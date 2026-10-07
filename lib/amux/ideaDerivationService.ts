import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { inspectAmuxStoredAnalysisUnit, amuxAnalysisTextSafe,
  type AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import { amuxContentDigest, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest, type AmuxContentKeys } from "./ideaCrypto.ts";
import { AMUX_V4_UNIT_WRITE_ENV, amuxV4UnitWriteEnabled } from
  "./ideaUnitDecisionStore.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9:_-]{8,80}$/;
const CARD_FIELDS = ["cardType", "storyKind", "title", "problem", "scopeIn",
  "scopeOut", "completionCriteria", "featureRef", "parentStoryRef",
  "dependencyRefs", "duplicateCandidateRefs", "taskRole", "executionGrade",
  "executionBrief"] as const;

export type OwnerAuthoredCard = Omit<AmuxAnalysisCard,
  "kind" | "localId" | "sourceRefIds">;
export type AmuxDerivationInput = {
  ideaId: string;
  groupId: string;
  requestId: string;
  operation: "split" | "merge";
  sourceUnitIds: string[];
  targetUnitIds: string[];
  cards: OwnerAuthoredCard[];
  reason: string;
};

export class AmuxIdeaDerivationError extends Error {
  constructor(readonly code: "forbidden" | "invalid_input" | "not_found" |
    "not_ready" | "reconfirm" | "write_disabled" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaDerivationError";
  }
}

const ownerId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxIdeaDerivationError("forbidden");
  }
  return id;
};

function assertShape(input: AmuxDerivationInput): void {
  if (!input || !ID.test(input.ideaId) || !UUID.test(input.groupId) ||
      !UUID.test(input.requestId) || !["split", "merge"].includes(input.operation) ||
      !Array.isArray(input.sourceUnitIds) || !Array.isArray(input.targetUnitIds) ||
      !Array.isArray(input.cards) || input.targetUnitIds.length !== input.cards.length ||
      input.sourceUnitIds.length > 40 || input.targetUnitIds.length > 40 ||
      (input.operation === "split" ?
        input.sourceUnitIds.length !== 1 || input.cards.length < 2 :
        input.sourceUnitIds.length < 2 || input.cards.length !== 1) ||
      input.sourceUnitIds.some((id) => !UUID.test(id)) ||
      input.targetUnitIds.some((id) => !UUID.test(id)) ||
      new Set(input.sourceUnitIds).size !== input.sourceUnitIds.length ||
      new Set(input.targetUnitIds).size !== input.targetUnitIds.length ||
      input.targetUnitIds.some((id) => input.sourceUnitIds.includes(id)) ||
      typeof input.reason !== "string" || input.reason.trim() !== input.reason ||
      input.reason.length < 3 || Buffer.byteLength(input.reason, "utf8") > 500 ||
      !amuxAnalysisTextSafe(input.reason)) {
    throw new AmuxIdeaDerivationError("invalid_input");
  }
  for (const card of input.cards) {
    if (!card || typeof card !== "object" || Array.isArray(card) ||
        Object.keys(card).sort().join("\0") !== [...CARD_FIELDS].sort().join("\0")) {
      throw new AmuxIdeaDerivationError("invalid_input");
    }
  }
}

type Plan = {
  confirmationDigest: string;
  digestKeyId: string;
  reasonDigest: string;
  reasonDigestKeyId: string;
  expiresAt: Date;
  sourceCommitments: Array<{ id: string; digest: string; digestKeyId: string }>;
  targets: Array<{ id: string; localRef: string; unitIndex: number;
    card: AmuxAnalysisCard; bodyDigest: string; bodyDigestKeyId: string }>;
  chunkIndex: number;
};

/** All source text is verified and discarded in memory. Only keyed digests,
 * IDs and lineage are retained in a seven-year group. */
async function buildPlan(tx: Prisma.TransactionClient,
  actorUserId: string, input: AmuxDerivationInput,
  keys: AmuxContentKeys): Promise<Plan> {
  const idea = await tx.amuxIdeaSubmission.findFirst({ where: {
    id: input.ideaId, actorUserId,
  }, select: { state: true } });
  if (!idea || !["analyzing", "awaiting_owner"].includes(idea.state)) {
    throw new AmuxIdeaDerivationError("not_ready");
  }
  const first = await tx.amuxIdeaAnalysisChunk.findUnique({ where: {
    ideaId_chunkIndex: { ideaId: input.ideaId, chunkIndex: 0 },
  }, select: { analysisCompletedAt: true } });
  if (!first?.analysisCompletedAt) throw new AmuxIdeaDerivationError("not_ready");
  const expiresAt = new Date(first.analysisCompletedAt.getTime() + 30 * 86_400_000);
  if (Date.now() >= expiresAt.getTime()) throw new AmuxIdeaDerivationError("not_ready");
  const sources = await tx.amuxIdeaDraftUnit.findMany({ where: {
    id: { in: input.sourceUnitIds }, ideaId: input.ideaId, actorUserId,
  }, select: { id: true, chunkIndex: true, localRef: true, unitKind: true,
    state: true, expiresAt: true, bodyCiphertext: true, bodyKeyId: true,
    bodyKeyVersion: true, bodyDigest: true, bodyDigestKeyId: true,
    bodyPurgedAt: true, bodyPurgeAfter: true } });
  if (sources.length !== input.sourceUnitIds.length || sources.some((source) =>
    source.unitKind !== "card" || !source.localRef ||
    !["proposed", "approved"].includes(source.state) ||
    source.expiresAt.getTime() !== expiresAt.getTime() ||
    source.bodyPurgedAt !== null || !source.bodyCiphertext ||
    !source.bodyKeyId || !source.bodyKeyVersion ||
    (source.bodyPurgeAfter !== null && Date.now() >= source.bodyPurgeAfter.getTime()))) {
    throw new AmuxIdeaDerivationError("not_ready");
  }
  if (await tx.amuxIdeaUnitDecision.count({ where: {
    draftUnitId: { in: input.sourceUnitIds }, state: "prepared",
  } }) !== 0) {
    throw new AmuxIdeaDerivationError("not_ready");
  }
  if (await tx.amuxIdeaDerivationEdge.count({ where: {
    sourceUnitId: { in: input.sourceUnitIds },
  } }) !== 0) {
    throw new AmuxIdeaDerivationError("not_ready");
  }
  for (const source of sources) {
    const plain = openAmuxContent({ ciphertext: Buffer.from(source.bodyCiphertext!),
      keyId: source.bodyKeyId!, keyVersion: source.bodyKeyVersion! },
    "analysis_draft", source.id, keys);
    try {
      if (!verifyAmuxContentDigest(plain, "analysis_draft", source.id,
        source.bodyDigest, source.bodyDigestKeyId, keys)) {
        throw new AmuxIdeaDerivationError("integrity_unavailable");
      }
      const inspected = inspectAmuxStoredAnalysisUnit({ raw: plain.toString("utf8"),
        chunkIndex: source.chunkIndex, permittedSourceRefIds: ["operator_idea"] });
      if (!inspected.ok || inspected.unit.kind !== "card" ||
          inspected.unit.localId !== source.localRef ||
          inspected.unit.sourceRefIds.length !== 1 ||
          inspected.unit.sourceRefIds[0] !== "operator_idea") {
        throw new AmuxIdeaDerivationError("integrity_unavailable");
      }
    } finally { plain.fill(0); }
  }
  const chunkIndex = Math.min(...sources.map((source) => source.chunkIndex));
  const existing = await tx.amuxIdeaDraftUnit.findMany({ where: {
    ideaId: input.ideaId, chunkIndex,
  }, select: { unitIndex: true, localRef: true } });
  const nextUnit = Math.max(-1, ...existing.map((unit) => unit.unitIndex)) + 1;
  const nextCard = Math.max(-1, ...existing.map((unit) => {
    const matched = /^c\d+:card-(\d+)$/.exec(unit.localRef ?? "");
    return matched ? Number(matched[1]) : -1;
  })) + 1;
  if (nextCard + input.cards.length > 10_000 ||
      nextUnit + input.cards.length > 10_000) {
    throw new AmuxIdeaDerivationError("not_ready");
  }
  const targets = input.cards.map((candidate, index) => {
    const card = { ...candidate, kind: "card" as const,
      localId: `c${chunkIndex}:card-${nextCard + index}`,
      sourceRefIds: ["operator_idea"] };
    const parsed = inspectAmuxStoredAnalysisUnit({ raw: JSON.stringify(card),
      chunkIndex, permittedSourceRefIds: ["operator_idea"] });
    if (!parsed.ok || parsed.unit.kind !== "card") {
      throw new AmuxIdeaDerivationError("invalid_input");
    }
    const bytes = Buffer.from(amuxCanonicalJson(parsed.unit), "utf8");
    try {
      const digest = amuxContentDigest(bytes, "analysis_draft",
        input.targetUnitIds[index]!, keys);
      return { id: input.targetUnitIds[index]!, localRef: card.localId,
        unitIndex: nextUnit + index, card: parsed.unit,
        bodyDigest: digest.digest, bodyDigestKeyId: digest.digestKeyId };
    } finally { bytes.fill(0); }
  });
  const sourceCommitments = input.sourceUnitIds.map((id) => {
    const source = sources.find((item) => item.id === id)!;
    return { id, digest: source.bodyDigest,
      digestKeyId: source.bodyDigestKeyId };
  });
  const reasonBytes = Buffer.from(input.reason, "utf8");
  const reason = amuxContentDigest(reasonBytes, "derivation_reason", input.groupId, keys);
  reasonBytes.fill(0);
  const confirmationBytes = Buffer.from(amuxCanonicalJson({
    schemaVersion: 1, actorUserId, ideaId: input.ideaId,
    groupId: input.groupId, requestId: input.requestId,
    operation: input.operation, sourceCommitments,
    targets: targets.map((target) => ({ id: target.id, localRef: target.localRef,
      digest: target.bodyDigest, digestKeyId: target.bodyDigestKeyId })),
    reasonDigest: reason.digest, expiresAt: expiresAt.toISOString(),
  }), "utf8");
  try {
    const confirmation = amuxContentDigest(confirmationBytes,
      "derivation_confirmation", input.groupId, keys);
    return { confirmationDigest: confirmation.digest,
      digestKeyId: confirmation.digestKeyId,
      reasonDigest: reason.digest, reasonDigestKeyId: reason.digestKeyId,
      sourceCommitments, targets, chunkIndex, expiresAt };
  } finally { confirmationBytes.fill(0); }
}

export async function previewAmuxV4Derivation(session: Session,
  input: AmuxDerivationInput, keys: AmuxContentKeys) {
  const actorUserId = ownerId(session);
  assertShape(input);
  return prisma.$transaction(async (tx) => buildPlan(tx, actorUserId, input, keys),
    { isolationLevel: "RepeatableRead", maxWait: 2_000, timeout: 8_000 });
}

/** Owner approval of the derivation is separate from each later card decision.
 * No card, Todo or worker row is created by this transaction. */
export async function commitAmuxV4Derivation(input: {
  session: Session; request: Request; payload: AmuxDerivationInput;
  confirmationDigest: string; keys: AmuxContentKeys;
}) {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  assertShape(input.payload);
  const payload = input.payload;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    await takeAuditChainLock(tx);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxIdeaSubmission"
      WHERE "id" = ${payload.ideaId} AND "actorUserId" = ${actorUserId}
      FOR UPDATE
    `;
    if (locked.length !== 1) throw new AmuxIdeaDerivationError("not_found");
    const existing = await tx.amuxIdeaDerivationGroup.findUnique({ where: {
      requestId: payload.requestId,
    }, select: { id: true, confirmationDigest: true } });
    if (existing) {
      // A possibly lost response must be resolved by the readback endpoint,
      // never by replaying a write request with caller-supplied target IDs.
      throw new AmuxIdeaDerivationError("reconfirm");
    }
    const plan = await buildPlan(tx, actorUserId, payload, input.keys);
    if (plan.confirmationDigest !== input.confirmationDigest) {
      throw new AmuxIdeaDerivationError("reconfirm");
    }
    const auditId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: "amux.v4.derivation.approve",
      targetType: "AmuxIdeaDerivationGroup", targetId: payload.groupId,
      summary: "Approved one owner-authored split or merge proposal group.",
      metadata: { ideaId: payload.ideaId, operation: payload.operation,
        sourceUnitIds: payload.sourceUnitIds,
        targetUnitIds: payload.targetUnitIds,
        confirmationDigest: plan.confirmationDigest,
        reasonDigest: plan.reasonDigest },
    });
    const now = new Date();
    await tx.amuxIdeaDerivationGroup.create({ data: {
      id: payload.groupId, ideaId: payload.ideaId, actorUserId,
      requestId: payload.requestId, operation: payload.operation,
      sourceCount: payload.sourceUnitIds.length,
      targetCount: plan.targets.length,
      confirmationDigest: plan.confirmationDigest,
      confirmationDigestKeyId: plan.digestKeyId,
      reasonDigest: plan.reasonDigest,
      reasonDigestKeyId: plan.reasonDigestKeyId,
      approvalAuditLogId: auditId, approvedAt: now,
    } });
    for (const target of plan.targets) {
      const bytes = Buffer.from(amuxCanonicalJson(target.card), "utf8");
      try {
        const sealed = sealAmuxContent(bytes, "analysis_draft", target.id,
          input.keys);
        if (sealed.digest !== target.bodyDigest ||
            sealed.digestKeyId !== target.bodyDigestKeyId) {
          throw new AmuxIdeaDerivationError("integrity_unavailable");
        }
        await tx.amuxIdeaDraftUnit.create({ data: {
          id: target.id, ideaId: payload.ideaId, actorUserId,
          chunkIndex: plan.chunkIndex, unitIndex: target.unitIndex,
          localRef: target.localRef, unitKind: "card", state: "proposed",
          derivationGroupId: payload.groupId, expiresAt: plan.expiresAt,
          bodyCiphertext: Uint8Array.from(sealed.ciphertext),
          bodyKeyId: sealed.keyId, bodyKeyVersion: sealed.keyVersion,
          bodyDigest: sealed.digest, bodyDigestKeyId: sealed.digestKeyId,
        } });
      } finally { bytes.fill(0); }
    }
    for (const sourceId of payload.sourceUnitIds) {
      for (const target of plan.targets) {
        await tx.amuxIdeaDerivationEdge.create({ data: {
          id: randomUUID(), groupId: payload.groupId,
          sourceUnitId: sourceId, targetUnitId: target.id,
        } });
      }
    }
    return { state: "approved" as const, groupId: payload.groupId,
      targetUnitIds: plan.targets.map((target) => target.id), auditId };
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
}

export async function approveAmuxV4Derivation(
  input: Parameters<typeof commitAmuxV4Derivation>[0],
) {
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxIdeaDerivationError("write_disabled");
  }
  return commitAmuxV4Derivation(input);
}

export async function readAmuxV4Derivation(session: Session,
  requestId: string) {
  const actorUserId = ownerId(session);
  if (!UUID.test(requestId)) throw new AmuxIdeaDerivationError("not_found");
  const group = await prisma.amuxIdeaDerivationGroup.findFirst({ where: {
    requestId, actorUserId,
  } });
  if (!group) return { state: "not_found" as const };
  const [audit, edges] = await Promise.all([
    prisma.adminAuditLog.findUnique({ where: { id: group.approvalAuditLogId },
      select: { action: true, targetType: true, targetId: true,
        actorUserId: true, entryHash: true } }),
    prisma.amuxIdeaDerivationEdge.findMany({ where: { groupId: group.id },
      select: { sourceUnitId: true, targetUnitId: true } }),
  ]);
  if (!audit?.entryHash || audit.action !== "amux.v4.derivation.approve" ||
      audit.targetType !== "AmuxIdeaDerivationGroup" ||
      audit.targetId !== group.id || audit.actorUserId !== actorUserId ||
      new Set(edges.map((edge) => edge.sourceUnitId)).size !== group.sourceCount ||
      new Set(edges.map((edge) => edge.targetUnitId)).size !== group.targetCount ||
      edges.length !== group.sourceCount * group.targetCount) {
    throw new AmuxIdeaDerivationError("integrity_unavailable");
  }
  return { state: "approved" as const, groupId: group.id,
    ideaId: group.ideaId, operation: group.operation,
    sourceUnitIds: [...new Set(edges.map((edge) => edge.sourceUnitId))],
    targetUnitIds: [...new Set(edges.map((edge) => edge.targetUnitId))],
    confirmationDigest: group.confirmationDigest };
}
