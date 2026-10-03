import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { sealAmuxNodeText } from "./ideaNodeContentCore.ts";
import { AmuxNodeDuplicateScanError, scanAmuxNodeDuplicates } from
  "./ideaNodeDuplicateScanService.ts";
import { AmuxUnitExpiryError, expireStaleAmuxUnitDecision } from
  "./ideaUnitExpiryService.ts";
import { AMUX_V4_INPUT_SCANNER_VERSION } from "./localIntakeCore.ts";
import { bindAmuxOwnerSession, bindAmuxUnitDecisionReason } from
  "./ideaUnitDecisionBindingCore.ts";
import { deriveAmuxIdeaUnitConfirmation,
  sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaDuplicateScan,
  type AmuxIdeaUnitConfirmationSnapshot } from "./ideaUnitConfirmationCore.ts";
import { checkAmuxIdeaUnitConsume } from "./ideaUnitConsumeGuard.ts";
import { loadAmuxUnitDecisionSource, amuxUnitOwnerId,
  AmuxUnitRejectError } from
  "./ideaUnitRejectService.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREPARE_ACTION = "amux.v4.unit.prepare";
const CONSUME_ACTION = "amux.v4.unit.consume";
const TARGET = "AmuxIdeaUnitDecision";

export class AmuxNodeCreateError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "already_prepared" | "reconfirm" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxNodeCreateError";
  }
}

export type AmuxNodeCreatePrepare = {
  ideaId: string; draftUnitId: string; decisionId: string;
  prepareRequestId: string; nodeId: string; reason: string;
};
export type AmuxNodeCreateConsume = AmuxNodeCreatePrepare & {
  consumeRequestId: string; confirmationDigest: string;
};

const validChoice = (choice: AmuxNodeCreatePrepare) => Boolean(choice &&
  UUID.test(choice.ideaId) && UUID.test(choice.draftUnitId) &&
  UUID.test(choice.decisionId) && UUID.test(choice.prepareRequestId) &&
  UUID.test(choice.nodeId) && choice.decisionId !== choice.prepareRequestId &&
  choice.nodeId !== choice.decisionId &&
  choice.nodeId !== choice.prepareRequestId && typeof choice.reason === "string");

type Source = Awaited<ReturnType<typeof loadAmuxUnitDecisionSource>>;

function ownerId(session: Session) {
  try { return amuxUnitOwnerId(session); }
  catch (error) {
    if (error instanceof AmuxUnitRejectError) {
      throw new AmuxNodeCreateError(error.code === "not_found" ? "not_found" :
        error.code === "reconfirm" ? "reconfirm" : "integrity_unavailable");
    }
    throw error;
  }
}

async function loadSource(tx: Prisma.TransactionClient, session: Session,
  ideaId: string, draftUnitId: string, keys: AmuxContentKeys) {
  try { return await loadAmuxUnitDecisionSource(tx, session, ideaId,
    draftUnitId, keys); }
  catch (error) {
    if (error instanceof AmuxUnitRejectError) {
      throw new AmuxNodeCreateError(error.code === "not_found" ? "not_found" :
        error.code === "not_ready" ? "not_ready" :
        error.code === "reconfirm" ? "reconfirm" : "integrity_unavailable");
    }
    throw error;
  }
}

async function currentNodeScan(tx: Prisma.TransactionClient,
  title: string, keys: AmuxContentKeys) {
  try { return await scanAmuxNodeDuplicates(tx,
    { level: "initiative", parentId: null, title }, keys); }
  catch (error) {
    if (error instanceof AmuxNodeDuplicateScanError) {
      throw new AmuxNodeCreateError(error.code === "invalid_query" ? "not_ready" :
        error.code === "incomplete" ? "reconfirm" : "integrity_unavailable");
    }
    throw error;
  }
}

function rootProposal(source: Source) {
  const proposal = source.proposal;
  if (proposal.kind !== "node" || proposal.level !== "initiative" ||
      proposal.parentRef !== null || proposal.localId !== source.unit.localRef) {
    throw new AmuxNodeCreateError("not_ready");
  }
  return proposal;
}

function decisionReason(choice: AmuxNodeCreatePrepare,
  scan: AmuxIdeaDuplicateScan, keys: AmuxContentKeys) {
  if (scan.candidates.length === 0) {
    if (choice.reason !== "") throw new AmuxNodeCreateError("not_ready");
    return null;
  }
  const bound = bindAmuxUnitDecisionReason({ ideaId: choice.ideaId,
    draftUnitId: choice.draftUnitId, decisionId: choice.decisionId,
    reason: choice.reason }, keys);
  if (!bound) throw new AmuxNodeCreateError("not_ready");
  return bound;
}

function snapshot(input: { session: Session; choice: AmuxNodeCreatePrepare;
  source: Source; reviewedScan: AmuxIdeaDuplicateScan;
  keys: AmuxContentKeys }): AmuxIdeaUnitConfirmationSnapshot {
  const actorUserId = ownerId(input.session);
  const proposal = rootProposal(input.source);
  const ownerSession = bindAmuxOwnerSession({ actorUserId,
    authenticatedAt: input.session.user?.authenticatedAt ?? "" }, input.keys);
  if (!ownerSession || !input.source.unit.localRef) {
    throw new AmuxNodeCreateError("not_ready");
  }
  return {
    schemaVersion: 1, policyVersion: "amux-intake-v11",
    canonicalizerVersion: "amux-canonical-v1",
    scannerVersion: AMUX_V4_INPUT_SCANNER_VERSION,
    ideaId: input.choice.ideaId, decisionId: input.choice.decisionId,
    prepareRequestId: input.choice.prepareRequestId, actorUserId,
    ownerSession, draftUnitId: input.choice.draftUnitId,
    localRef: input.source.unit.localRef, unitVersion: 1,
    unitKind: "node", unitBody: { digest: input.source.unit.bodyDigest,
      keyId: input.source.unit.bodyDigestKeyId },
    draftShape: { kind: "node", level: proposal.level },
    action: "create_node",
    source: { previewId: input.source.preview.id,
      payload: { digest: input.source.preview.payloadDigest,
        keyId: input.source.preview.payloadDigestKeyId },
      scopeApprovalId: null, scope: null },
    hierarchy: [], nodeProposal: { id: input.choice.nodeId,
      level: "initiative", parentId: null }, target: null, card: null,
    duplicates: input.reviewedScan,
    decisionReason: decisionReason(input.choice, input.reviewedScan, input.keys),
  };
}

/** Dark DB writer for the first, root-only hierarchy unit. These functions do
 * not open a route or enable an environment latch. Callers must use a
 * SERIALIZABLE transaction; the duplicate scan checks that at runtime. */
export async function commitAmuxRootNodePrepare(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreatePrepare;
    keys: AmuxContentKeys }) {
  const actorUserId = ownerId(input.session);
  const choice = input.choice;
  if (!validChoice(choice)) throw new AmuxNodeCreateError("not_ready");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const source = await loadSource(tx, input.session,
    choice.ideaId, choice.draftUnitId, input.keys);
  const proposal = rootProposal(source);
  try { await expireStaleAmuxUnitDecision(tx, choice.draftUnitId); }
  catch (error) {
    if (error instanceof AmuxUnitExpiryError) {
      throw new AmuxNodeCreateError(error.code);
    }
    throw error;
  }
  if (await tx.amuxPortfolioNode.findUnique({ where: { id: choice.nodeId },
    select: { id: true } })) throw new AmuxNodeCreateError("not_ready");
  const scan = await currentNodeScan(tx, proposal.title, input.keys);
  const reviewed = snapshot({ session: input.session, choice, source,
    reviewedScan: scan, keys: input.keys });
  const confirmation = deriveAmuxIdeaUnitConfirmation(reviewed, input.keys,
    scan, null);
  if (!confirmation.ok) throw new AmuxNodeCreateError("not_ready");
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: PREPARE_ACTION, targetType: TARGET,
    targetId: choice.decisionId,
    summary: "Owner prepared one AMUX v4 root hierarchy node decision.",
    metadata: { ideaId: choice.ideaId, draftUnitId: choice.draftUnitId,
      prepareRequestId: choice.prepareRequestId, action: "create_node",
      confirmationDigest: confirmation.confirmationDigest,
      confirmationDigestKeyId: confirmation.digestKeyId,
      snapshot: reviewed },
  });
  const decision = await tx.amuxIdeaUnitDecision.create({ data: {
    id: choice.decisionId, ideaId: choice.ideaId,
    draftUnitId: choice.draftUnitId, actorUserId,
    chunkIndex: source.unit.chunkIndex,
    prepareRequestId: choice.prepareRequestId,
    action: "create_node", state: "prepared",
    ownerSessionDigest: reviewed.ownerSession.digest,
    ownerSessionDigestKeyId: reviewed.ownerSession.keyId,
    unitDigest: source.unit.bodyDigest,
    unitDigestKeyId: source.unit.bodyDigestKeyId,
    confirmationDigest: confirmation.confirmationDigest,
    confirmationDigestKeyId: confirmation.digestKeyId,
    sourcePreviewId: source.preview.id,
    sourcePreviewDigest: source.preview.payloadDigest,
    sourcePreviewDigestKeyId: source.preview.payloadDigestKeyId,
    preparedAt: source.now,
    expiresAt: new Date(source.now.getTime() + 15 * 60_000),
    prepareAuditLogId: auditId,
  } });
  return { decisionId: decision.id, draftUnitId: decision.draftUnitId,
    confirmationDigest: decision.confirmationDigest,
    expiresAt: decision.expiresAt.toISOString() };
}

export async function commitAmuxRootNodeConsume(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreateConsume;
    keys: AmuxContentKeys }) {
  const actorUserId = ownerId(input.session);
  const choice = input.choice;
  if (!validChoice(choice) || !UUID.test(choice.consumeRequestId) ||
      choice.consumeRequestId === choice.prepareRequestId ||
      !/^[a-f0-9]{64}$/.test(choice.confirmationDigest)) {
    throw new AmuxNodeCreateError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const source = await loadSource(tx, input.session,
    choice.ideaId, choice.draftUnitId, input.keys);
  const proposal = rootProposal(source);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${choice.decisionId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  const decision = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: choice.decisionId },
  });
  if (locked.length !== 1 || !decision || decision.action !== "create_node" ||
      decision.state !== "prepared" ||
      decision.prepareRequestId !== choice.prepareRequestId ||
      !sameAmuxIdeaUnitConfirmation(decision.confirmationDigest,
        choice.confirmationDigest)) throw new AmuxNodeCreateError("reconfirm");
  const prepareAudit = await tx.adminAuditLog.findUnique({
    where: { id: decision.prepareAuditLogId },
  });
  const metadata = prepareAudit?.metadata;
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : null;
  const stored = meta?.snapshot as AmuxIdeaUnitConfirmationSnapshot | undefined;
  if (!prepareAudit?.entryHash || auditRowActorKind(prepareAudit) !== "human" ||
      prepareAudit.actorUserId !== actorUserId ||
      prepareAudit.action !== PREPARE_ACTION ||
      prepareAudit.targetType !== TARGET ||
      prepareAudit.targetId !== decision.id ||
      meta?.action !== "create_node" || meta.ideaId !== choice.ideaId ||
      meta.draftUnitId !== choice.draftUnitId ||
      meta.prepareRequestId !== choice.prepareRequestId ||
      meta.confirmationDigest !== decision.confirmationDigest ||
      meta.confirmationDigestKeyId !== decision.confirmationDigestKeyId ||
      !stored || !stored.duplicates || stored.nodeProposal?.id !== choice.nodeId) {
    throw new AmuxNodeCreateError("integrity_unavailable");
  }
  const currentScan = await currentNodeScan(tx, proposal.title, input.keys);
  const currentSnapshot = snapshot({ session: input.session, choice, source,
    reviewedScan: stored.duplicates, keys: input.keys });
  if (amuxCanonicalJson(stored) !== amuxCanonicalJson(currentSnapshot)) {
    throw new AmuxNodeCreateError("reconfirm");
  }
  const confirmation = deriveAmuxIdeaUnitConfirmation(currentSnapshot,
    input.keys, currentScan, null);
  const guard = checkAmuxIdeaUnitConsume({ ...decision, state: "prepared" }, {
    decisionId: choice.decisionId, ideaId: choice.ideaId,
    draftUnitId: choice.draftUnitId, actorUserId,
    recentOwnerStepUp: true,
    ownerSessionDigest: currentSnapshot.ownerSession.digest,
    ownerSessionDigestKeyId: currentSnapshot.ownerSession.keyId,
    databaseNow: source.now, currentConfirmation: confirmation,
  });
  if (guard.decision !== "allow") throw new AmuxNodeCreateError(
    guard.decision === "halt" ? "integrity_unavailable" : "reconfirm");
  if (await tx.amuxPortfolioNode.findUnique({ where: { id: choice.nodeId },
    select: { id: true } })) throw new AmuxNodeCreateError("reconfirm");
  const sealed = sealAmuxNodeText(choice.nodeId,
    { title: proposal.title, description: proposal.description }, input.keys);
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: CONSUME_ACTION, targetType: TARGET,
    targetId: decision.id,
    summary: "Owner approved and registered one AMUX v4 root hierarchy node.",
    metadata: { ideaId: choice.ideaId, draftUnitId: choice.draftUnitId,
      decisionId: decision.id, consumeRequestId: choice.consumeRequestId,
      confirmationDigest: decision.confirmationDigest,
      resolvedNodeId: choice.nodeId, action: "create_node" },
  });
  await tx.amuxPortfolioNode.create({ data: {
    id: choice.nodeId, level: "initiative", parentId: null,
    state: "active", revision: 0,
    titleCiphertext: Uint8Array.from(sealed.titleCiphertext),
    descriptionCiphertext: Uint8Array.from(sealed.descriptionCiphertext),
    contentKeyId: sealed.contentKeyId,
    contentKeyVersion: sealed.contentKeyVersion,
    contentDigest: sealed.contentDigest,
    contentDigestKeyId: sealed.contentDigestKeyId,
    approvedByUserId: actorUserId, authorizationAuditLogId: auditId,
  } });
  await tx.amuxPortfolioNodeRevision.create({ data: {
    id: randomUUID(), nodeId: choice.nodeId,
    revision: 0, priorRevision: null, parentIdAtApproval: null,
    contentDigest: sealed.contentDigest,
    contentDigestKeyId: sealed.contentDigestKeyId,
    decisionId: decision.id, authorizationAuditLogId: auditId,
    approvedAt: source.now,
  } });
  const consumed = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: decision.id, actorUserId, state: "prepared",
      outcomeUnknownAt: null, consumeRequestId: null,
      finalAuditLogId: null, expiresAt: { gt: source.now } },
    data: { state: "consumed", consumeRequestId: choice.consumeRequestId,
      finalAuditLogId: auditId, resolvedNodeId: choice.nodeId },
  });
  if (consumed.count !== 1) throw new AmuxNodeCreateError("reconfirm");
  const approved = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: choice.draftUnitId, ideaId: choice.ideaId,
      actorUserId, state: "proposed", expiresAt: { gt: source.now } },
    data: { state: "approved" },
  });
  if (approved.count !== 1) throw new AmuxNodeCreateError("reconfirm");
  return { decisionId: decision.id, nodeId: choice.nodeId,
    state: "created" as const, auditId };
}
