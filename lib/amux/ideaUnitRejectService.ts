import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { hasRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { inspectAmuxStoredAnalysisUnit } from "./ideaAnalysisChunkCore.ts";
import { matchesAmuxIdeaAnalysisUnitCommitments } from
  "./ideaAnalysisResultReadCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { bindAmuxOwnerSession, bindAmuxUnitDecisionReason,
  sameAmuxUnitDecisionBinding } from "./ideaUnitDecisionBindingCore.ts";
import { checkAmuxIdeaUnitConsume } from "./ideaUnitConsumeGuard.ts";
import { sameAmuxIdeaUnitConfirmation } from "./ideaUnitConfirmationCore.ts";
import { AMUX_V4_UNIT_REJECT_WRITE_ENV, amuxV4UnitRejectWritePermitted,
  deriveAmuxUnitRejectConfirmation } from "./ideaUnitRejectCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PREPARE_ACTION = "amux.v4.unit.prepare";
const CONSUME_ACTION = "amux.v4.unit.consume";
const TARGET = "AmuxIdeaUnitDecision";

export class AmuxUnitRejectError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "reconfirm" |
    "already_prepared" | "write_disabled" | "integrity_unavailable" | "outcome_unknown") {
    super(code);
    this.name = "AmuxUnitRejectError";
  }
}

export type AmuxUnitRejectPrepare = {
  ideaId: string; draftUnitId: string; decisionId: string;
  prepareRequestId: string; reason: string;
};
export type AmuxUnitRejectConsume = AmuxUnitRejectPrepare & {
  consumeRequestId: string; confirmationDigest: string;
};

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxUnitRejectError("not_found");
  }
  if (!hasRecentAdminAuthentication(session)) throw new AmuxUnitRejectError("reconfirm");
  return id;
}

const validPrepare = (value: AmuxUnitRejectPrepare): boolean =>
  Boolean(value && ID.test(value.ideaId) && ID.test(value.draftUnitId) &&
    UUID.test(value.decisionId) && UUID.test(value.prepareRequestId) &&
    value.decisionId !== value.prepareRequestId && typeof value.reason === "string");

/** Locks follow idea -> chunk -> preview -> unit -> decision. The audit-chain
 * lock is acquired first, matching the existing AMUX v4 owner writers. */
async function loadSource(tx: Prisma.TransactionClient, actorUserId: string,
  ideaId: string, draftUnitId: string, keys: AmuxContentKeys) {
  const ideaLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${ideaId} AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  if (ideaLock.length !== 1) throw new AmuxUnitRejectError("not_found");
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId } });
  const chunkLock = await tx.$queryRaw<Array<{ chunkIndex: number }>>`
    SELECT "chunkIndex" FROM "AmuxIdeaAnalysisChunk"
    WHERE "ideaId" = ${ideaId} AND "chunkIndex" = 0 FOR UPDATE
  `;
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
  });
  if (!idea || chunkLock.length !== 1 || !chunk?.currentPreviewId) {
    throw new AmuxUnitRejectError("not_ready");
  }
  const previewLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaTransferPreview"
    WHERE "id" = ${chunk.currentPreviewId} FOR UPDATE
  `;
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: chunk.currentPreviewId },
  });
  const unitLock = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaDraftUnit"
    WHERE "id" = ${draftUnitId} AND "ideaId" = ${ideaId} AND
      "actorUserId" = ${actorUserId} AND "chunkIndex" = 0 FOR UPDATE
  `;
  const unit = await tx.amuxIdeaDraftUnit.findUnique({ where: { id: draftUnitId } });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxUnitRejectError("integrity_unavailable");
  }
  if (previewLock.length !== 1 || unitLock.length !== 1 || !preview || !unit ||
      idea.state !== "awaiting_owner" || !idea.analysisCompletedAt ||
      idea.cancelledAt !== null || chunk.state !== "draft_ready" ||
      chunk.draftVersion !== 2 || chunk.actorUserId !== actorUserId ||
      chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      chunk.currentPreviewId !== preview.id ||
      preview.ideaId !== ideaId || preview.chunkIndex !== 0 ||
      preview.state !== "completed" || preview.confirmedByUserId !== actorUserId ||
      !preview.confirmationAuditLogId ||
      preview.sourceScopeApprovalId !== null || preview.sourceUnitOrdinal !== 0 ||
      preview.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId ||
      unit.ideaId !== ideaId || unit.actorUserId !== actorUserId ||
      unit.chunkIndex !== 0 || unit.state !== "proposed" ||
      !unit.localRef || !unit.bodyCiphertext || !unit.bodyKeyId ||
      !unit.bodyKeyVersion || unit.bodyPurgedAt !== null ||
      now >= unit.expiresAt ||
      (unit.bodyPurgeAfter !== null && now >= unit.bodyPurgeAfter)) {
    throw new AmuxUnitRejectError("not_ready");
  }
  const units = await tx.amuxIdeaDraftUnit.findMany({
    where: { ideaId, actorUserId, chunkIndex: 0 },
    orderBy: { unitIndex: "asc" },
    select: { id: true, localRef: true, unitKind: true,
      bodyDigest: true, bodyDigestKeyId: true },
  });
  const draftAudits = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
      targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
      targetId: `${ideaId}:0` }, take: 2,
  });
  const draftAudit = draftAudits[0];
  const draftMetadata = draftAudit?.metadata;
  const draftMeta = draftMetadata && typeof draftMetadata === "object" &&
    !Array.isArray(draftMetadata) ? draftMetadata as Record<string, unknown> : null;
  const previewAudit = await tx.adminAuditLog.findUnique({
    where: { id: preview.confirmationAuditLogId },
  });
  const previewMetadata = previewAudit?.metadata;
  const previewMeta = previewMetadata && typeof previewMetadata === "object" &&
    !Array.isArray(previewMetadata) ? previewMetadata as Record<string, unknown> : null;
  if (draftAudits.length !== 1 || !draftAudit?.entryHash ||
      auditRowActorKind(draftAudit) !== "system" ||
      !draftMeta || draftMeta.ideaId !== ideaId ||
      draftMeta.systemActor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
      draftMeta.previewId !== preview.id ||
      draftMeta.unitCount !== units.length ||
      !matchesAmuxIdeaAnalysisUnitCommitments(draftMeta.unitCommitments, units) ||
      !previewAudit?.entryHash || auditRowActorKind(previewAudit) !== "human" ||
      previewAudit.actorUserId !== actorUserId ||
      previewAudit.action !== "amux.v4.transfer_preview.confirmed" ||
      previewAudit.targetType !== "AmuxIdeaTransferPreview" ||
      previewAudit.targetId !== preview.id || !previewMeta ||
      previewMeta.payloadDigest !== preview.payloadDigest ||
      previewMeta.payloadDigestKeyId !== preview.payloadDigestKeyId) {
    throw new AmuxUnitRejectError("integrity_unavailable");
  }
  let plain: Buffer;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(unit.bodyCiphertext),
      keyId: unit.bodyKeyId, keyVersion: unit.bodyKeyVersion },
    "analysis_draft", unit.id, keys);
  } catch { throw new AmuxUnitRejectError("integrity_unavailable"); }
  try {
    if (!verifyAmuxContentDigest(plain, "analysis_draft", unit.id,
      unit.bodyDigest, unit.bodyDigestKeyId, keys)) {
      throw new AmuxUnitRejectError("integrity_unavailable");
    }
    const inspected = inspectAmuxStoredAnalysisUnit({ raw: plain.toString("utf8"),
      chunkIndex: 0, permittedSourceRefIds: ["operator_idea"] });
    if (!inspected.ok || inspected.unit.localId !== unit.localRef ||
        inspected.unit.kind !== unit.unitKind || inspected.unit.kind === "evidence") {
      throw new AmuxUnitRejectError("not_ready");
    }
    return { unit, preview, proposal: inspected.unit, now };
  } finally { plain.fill(0); }
}

function confirmation(input: {
  actorUserId: string; authenticatedAt: string; ideaId: string;
  draftUnitId: string; decisionId: string; prepareRequestId: string;
  reason: string;
}, source: Awaited<ReturnType<typeof loadSource>>, keys: AmuxContentKeys) {
  const ownerSession = bindAmuxOwnerSession({ actorUserId: input.actorUserId,
    authenticatedAt: input.authenticatedAt }, keys);
  const reason = bindAmuxUnitDecisionReason({ ideaId: input.ideaId,
    draftUnitId: input.draftUnitId, decisionId: input.decisionId,
    reason: input.reason }, keys);
  if (!ownerSession || !reason || !source.unit.localRef) {
    throw new AmuxUnitRejectError("not_ready");
  }
  const result = deriveAmuxUnitRejectConfirmation({
    ...input, ownerSession, reason, localRef: source.unit.localRef,
    unitBody: { digest: source.unit.bodyDigest,
      keyId: source.unit.bodyDigestKeyId },
    proposal: source.proposal,
    previewId: source.preview.id,
    previewPayload: { digest: source.preview.payloadDigest,
      keyId: source.preview.payloadDigestKeyId },
  }, keys);
  if (!result.ok) throw new AmuxUnitRejectError("not_ready");
  return { ownerSession, reason, result };
}

export async function commitAmuxUnitRejectPrepare(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxUnitRejectPrepare;
    keys: AmuxContentKeys }) {
  const actorUserId = ownerId(input.session);
  if (!validPrepare(input.choice)) throw new AmuxUnitRejectError("not_ready");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const source = await loadSource(tx, actorUserId,
    input.choice.ideaId, input.choice.draftUnitId, input.keys);
  if (await tx.amuxIdeaUnitDecision.count({ where: { draftUnitId: source.unit.id,
    state: { in: ["prepared", "consumed"] } } }) !== 0) {
    throw new AmuxUnitRejectError("already_prepared");
  }
  const bound = confirmation({ ...input.choice, actorUserId,
    authenticatedAt: input.session.user?.authenticatedAt ?? "" }, source, input.keys);
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: PREPARE_ACTION, targetType: TARGET,
    targetId: input.choice.decisionId,
    summary: "Owner prepared one AMUX v4 proposal rejection without registering a card or node.",
    metadata: { ideaId: input.choice.ideaId, draftUnitId: source.unit.id,
      prepareRequestId: input.choice.prepareRequestId,
      unitDigest: source.unit.bodyDigest,
      sourcePreviewId: source.preview.id,
      sourcePreviewDigest: source.preview.payloadDigest,
      reasonDigest: bound.reason.digest, reasonDigestKeyId: bound.reason.keyId,
      confirmationDigest: bound.result.confirmationDigest,
      confirmationDigestKeyId: bound.result.digestKeyId,
      action: "reject_unit", registered: false },
  });
  const row = await tx.amuxIdeaUnitDecision.create({ data: {
    id: input.choice.decisionId, ideaId: input.choice.ideaId,
    draftUnitId: source.unit.id, actorUserId, chunkIndex: 0,
    prepareRequestId: input.choice.prepareRequestId,
    action: "reject_unit", state: "prepared",
    ownerSessionDigest: bound.ownerSession.digest,
    ownerSessionDigestKeyId: bound.ownerSession.keyId,
    unitDigest: source.unit.bodyDigest,
    unitDigestKeyId: source.unit.bodyDigestKeyId,
    confirmationDigest: bound.result.confirmationDigest,
    confirmationDigestKeyId: bound.result.digestKeyId,
    sourcePreviewId: source.preview.id,
    sourcePreviewDigest: source.preview.payloadDigest,
    sourcePreviewDigestKeyId: source.preview.payloadDigestKeyId,
    preparedAt: source.now,
    expiresAt: new Date(source.now.getTime() + 15 * 60_000),
    prepareAuditLogId: auditId,
  } });
  return { decisionId: row.id, ideaId: row.ideaId,
    draftUnitId: row.draftUnitId, confirmationDigest: row.confirmationDigest,
    confirmationDigestKeyId: row.confirmationDigestKeyId,
    expiresAt: row.expiresAt.toISOString() };
}

export async function commitAmuxUnitRejectConsume(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxUnitRejectConsume;
    keys: AmuxContentKeys }) {
  const actorUserId = ownerId(input.session);
  const choice = input.choice;
  if (!validPrepare(choice) || !UUID.test(choice.consumeRequestId) ||
      choice.consumeRequestId === choice.prepareRequestId ||
      !DIGEST.test(choice.confirmationDigest)) throw new AmuxUnitRejectError("not_ready");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const source = await loadSource(tx, actorUserId, choice.ideaId,
    choice.draftUnitId, input.keys);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${choice.decisionId} AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  const row = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: choice.decisionId },
  });
  if (locked.length !== 1 || !row || row.action !== "reject_unit" ||
      row.state !== "prepared" ||
      row.prepareRequestId !== choice.prepareRequestId ||
      !sameAmuxIdeaUnitConfirmation(choice.confirmationDigest, row.confirmationDigest)) {
    throw new AmuxUnitRejectError("reconfirm");
  }
  const prepareAudit = await tx.adminAuditLog.findUnique({
    where: { id: row.prepareAuditLogId },
  });
  const metadata = prepareAudit?.metadata;
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : null;
  const bound = confirmation({ ...choice, actorUserId,
    authenticatedAt: input.session.user?.authenticatedAt ?? "" }, source, input.keys);
  if (!prepareAudit?.entryHash || auditRowActorKind(prepareAudit) !== "human" ||
      prepareAudit.actorUserId !== actorUserId ||
      prepareAudit.action !== PREPARE_ACTION ||
      prepareAudit.targetType !== TARGET || prepareAudit.targetId !== row.id ||
      !meta || meta.ideaId !== choice.ideaId ||
      meta.draftUnitId !== choice.draftUnitId ||
      meta.prepareRequestId !== choice.prepareRequestId ||
      meta.reasonDigest !== bound.reason.digest ||
      meta.reasonDigestKeyId !== bound.reason.keyId ||
      meta.confirmationDigest !== row.confirmationDigest ||
      meta.confirmationDigestKeyId !== row.confirmationDigestKeyId ||
      !sameAmuxUnitDecisionBinding(bound.ownerSession,
        { digest: row.ownerSessionDigest, keyId: row.ownerSessionDigestKeyId })) {
    throw new AmuxUnitRejectError("reconfirm");
  }
  const guard = checkAmuxIdeaUnitConsume({ ...row, state: "prepared" }, {
    decisionId: choice.decisionId, ideaId: choice.ideaId,
    draftUnitId: choice.draftUnitId, actorUserId,
    recentOwnerStepUp: true,
    ownerSessionDigest: bound.ownerSession.digest,
    ownerSessionDigestKeyId: bound.ownerSession.keyId,
    databaseNow: source.now, currentConfirmation: bound.result,
  });
  if (guard.decision !== "allow") {
    throw new AmuxUnitRejectError(guard.decision === "halt"
      ? "integrity_unavailable" : "reconfirm");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: CONSUME_ACTION, targetType: TARGET,
    targetId: row.id,
    summary: "Owner rejected one AMUX v4 proposal; no card or node was registered.",
    metadata: { ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      decisionId: row.id, consumeRequestId: choice.consumeRequestId,
      confirmationDigest: row.confirmationDigest,
      reasonDigest: bound.reason.digest, action: "reject_unit",
      registered: false },
  });
  const consumed = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: row.id, actorUserId, state: "prepared",
      outcomeUnknownAt: null, expiresAt: { gt: source.now },
      consumeRequestId: null },
    data: { state: "consumed", consumeRequestId: choice.consumeRequestId,
      finalAuditLogId: auditId },
  });
  if (consumed.count !== 1) throw new AmuxUnitRejectError("reconfirm");
  const rejected = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: row.draftUnitId, ideaId: row.ideaId, actorUserId,
      state: "proposed", expiresAt: { gt: source.now } },
    data: { state: "rejected" },
  });
  if (rejected.count !== 1) throw new AmuxUnitRejectError("reconfirm");
  return { decisionId: row.id, draftUnitId: row.draftUnitId,
    state: "rejected" as const, auditId };
}

function beforeWrite(session: Session) {
  ownerId(session);
  if (!amuxV4UnitRejectWritePermitted(process.env[AMUX_V4_UNIT_REJECT_WRITE_ENV])) {
    throw new AmuxUnitRejectError("write_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxUnitRejectError("integrity_unavailable");
  }
  try { return loadCurrentAmuxContentKeys(process.env); }
  catch { throw new AmuxUnitRejectError("integrity_unavailable"); }
}

export async function prepareAmuxUnitReject(session: Session, request: Request,
  choice: AmuxUnitRejectPrepare) {
  const keys = beforeWrite(session);
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitAmuxUnitRejectPrepare(tx,
        { session, request, choice, keys });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxUnitRejectError) throw error;
    throw new AmuxUnitRejectError("outcome_unknown");
  }
}

export async function consumeAmuxUnitReject(session: Session, request: Request,
  choice: AmuxUnitRejectConsume) {
  const keys = beforeWrite(session);
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitAmuxUnitRejectConsume(tx,
        { session, request, choice, keys });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxUnitRejectError) throw error;
    throw new AmuxUnitRejectError("outcome_unknown");
  }
}

/** Metadata-only exact-ID read-back. Absence is not permission to blind retry:
 * the preceding COMMIT may still be in flight, and only the owner can decide
 * whether to prepare a new confirmation after reconciliation. */
export async function readAmuxUnitRejectDecision(session: Session,
  decisionId: string, prepareRequestId: string) {
  const actorUserId = ownerId(session);
  if (!UUID.test(decisionId) || !UUID.test(prepareRequestId)) {
    throw new AmuxUnitRejectError("not_found");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
    `;
    const row = await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: decisionId },
    });
    const audits = await tx.adminAuditLog.findMany({
      where: { targetType: TARGET, targetId: decisionId,
        action: { in: [PREPARE_ACTION, CONSUME_ACTION] } }, take: 3,
    });
    if (!row) {
      const matchingPrepare = audits.some((audit) => {
        const metadata = audit.metadata;
        return audit.action === PREPARE_ACTION &&
          metadata && typeof metadata === "object" &&
          !Array.isArray(metadata) &&
          (metadata as Record<string, unknown>).prepareRequestId === prepareRequestId;
      });
      if (audits.some((audit) => audit.actorUserId !== actorUserId) ||
          (audits.length > 0 && !matchingPrepare)) {
        return { state: "not_visible" } as const;
      }
      return { state: audits.length ? "partial" : "absent" } as const;
    }
    if (row.actorUserId !== actorUserId || row.prepareRequestId !== prepareRequestId) {
      return { state: "not_visible" } as const;
    }
    const prepareAudit = audits.find((audit) => audit.id === row.prepareAuditLogId);
    const finalAudit = audits.find((audit) => audit.id === row.finalAuditLogId);
    if (row.action !== "reject_unit" || !prepareAudit?.entryHash ||
        auditRowActorKind(prepareAudit) !== "human" ||
        prepareAudit.actorUserId !== actorUserId ||
        prepareAudit.action !== PREPARE_ACTION ||
        audits.filter((audit) => audit.action === PREPARE_ACTION).length !== 1) {
      return { state: "partial" } as const;
    }
    const prepareMetadata = prepareAudit.metadata;
    const prepareMeta = prepareMetadata && typeof prepareMetadata === "object" &&
      !Array.isArray(prepareMetadata)
      ? prepareMetadata as Record<string, unknown> : null;
    if (!prepareMeta || prepareMeta.ideaId !== row.ideaId ||
        prepareMeta.draftUnitId !== row.draftUnitId ||
        prepareMeta.prepareRequestId !== row.prepareRequestId ||
        prepareMeta.unitDigest !== row.unitDigest ||
        prepareMeta.sourcePreviewId !== row.sourcePreviewId ||
        prepareMeta.sourcePreviewDigest !== row.sourcePreviewDigest ||
        prepareMeta.confirmationDigest !== row.confirmationDigest ||
        prepareMeta.confirmationDigestKeyId !== row.confirmationDigestKeyId ||
        prepareMeta.action !== "reject_unit" ||
        prepareMeta.registered !== false) {
      return { state: "partial" } as const;
    }
    if (row.state === "prepared" && row.finalAuditLogId === null) {
      if (row.outcomeUnknownAt !== null) return { state: "outcome_unknown" } as const;
      return { state: "prepared", decisionId: row.id,
        confirmationDigest: row.confirmationDigest,
        expiresAt: row.expiresAt.toISOString() } as const;
    }
    if (row.state !== "consumed" || !finalAudit?.entryHash ||
        auditRowActorKind(finalAudit) !== "human" ||
        finalAudit.actorUserId !== actorUserId ||
        finalAudit.action !== CONSUME_ACTION ||
        audits.filter((audit) => audit.action === CONSUME_ACTION).length !== 1) {
      return { state: "partial" } as const;
    }
    const finalMetadata = finalAudit.metadata;
    const finalMeta = finalMetadata && typeof finalMetadata === "object" &&
      !Array.isArray(finalMetadata) ? finalMetadata as Record<string, unknown> : null;
    if (!finalMeta || finalMeta.ideaId !== row.ideaId ||
        finalMeta.draftUnitId !== row.draftUnitId ||
        finalMeta.decisionId !== row.id ||
        finalMeta.consumeRequestId !== row.consumeRequestId ||
        finalMeta.confirmationDigest !== row.confirmationDigest ||
        finalMeta.action !== "reject_unit" || finalMeta.registered !== false) {
      return { state: "partial" } as const;
    }
    const unit = await tx.amuxIdeaDraftUnit.findUnique({
      where: { id: row.draftUnitId }, select: { state: true },
    });
    return unit?.state === "rejected"
      ? { state: "rejected", decisionId: row.id, draftUnitId: row.draftUnitId } as const
      : { state: "partial" } as const;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 8_000 });
}
