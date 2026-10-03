import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog,
  writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, AMUX_SYSTEM_AUDIT_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { sealAmuxNodeText } from "./ideaNodeContentCore.ts";
import { AmuxNodeDuplicateScanError, scanAmuxNodeDuplicates } from
  "./ideaNodeDuplicateScanService.ts";
import { AmuxUnitExpiryError, expireStaleAmuxUnitDecision } from
  "./ideaUnitExpiryService.ts";
import { readAmuxRootNodeDecisionInTransaction } from
  "./ideaNodeDecisionReadService.ts";
import { resolveApprovedAmuxRootParent,
  AmuxNodeParentResolutionError } from
  "./ideaNodeParentResolutionService.ts";
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
const ACTOR_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export class AmuxNodeCreateError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "already_prepared" | "reconfirm" |
    "integrity_unavailable" | "write_disabled" | "outcome_unknown") {
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
type NodeLevel = "initiative" | "epic";
type NodeContext = {
  proposal: Extract<Source["proposal"], { kind: "node" }>;
  parent: Awaited<ReturnType<typeof resolveApprovedAmuxRootParent>> | null;
};

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
  context: NodeContext, keys: AmuxContentKeys) {
  try { return await scanAmuxNodeDuplicates(tx,
    { level: context.proposal.level, parentId: context.parent?.id ?? null,
      title: context.proposal.title }, keys); }
  catch (error) {
    if (error instanceof AmuxNodeDuplicateScanError) {
      throw new AmuxNodeCreateError(error.code === "invalid_query" ? "not_ready" :
        error.code === "incomplete" ? "reconfirm" : "integrity_unavailable");
    }
    throw error;
  }
}

async function nodeContext(tx: Prisma.TransactionClient, session: Session,
  source: Source, level: NodeLevel): Promise<NodeContext> {
  const proposal = source.proposal;
  if (proposal.kind !== "node" || proposal.level !== level ||
      proposal.localId !== source.unit.localRef ||
      (level === "initiative" ? proposal.parentRef !== null :
        proposal.parentRef === null)) {
    throw new AmuxNodeCreateError("not_ready");
  }
  if (level === "initiative") return { proposal, parent: null };
  try {
    const parent = await resolveApprovedAmuxRootParent(tx, session,
      { ideaId: source.unit.ideaId, parentRef: proposal.parentRef! });
    return { proposal, parent };
  } catch (error) {
    if (error instanceof AmuxNodeParentResolutionError) {
      throw new AmuxNodeCreateError(error.code);
    }
    throw error;
  }
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
  source: Source; context: NodeContext; reviewedScan: AmuxIdeaDuplicateScan;
  keys: AmuxContentKeys }): AmuxIdeaUnitConfirmationSnapshot {
  const actorUserId = ownerId(input.session);
  const { proposal, parent } = input.context;
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
    hierarchy: parent ? [parent] : [], nodeProposal: { id: input.choice.nodeId,
      level: proposal.level, parentId: parent?.id ?? null }, target: null, card: null,
    duplicates: input.reviewedScan,
    decisionReason: decisionReason(input.choice, input.reviewedScan, input.keys),
  };
}

/** Dark DB writer for Initiative and a directly approved child Epic. The
 * shared writer does not open the Epic route or enable an environment latch.
 * Callers must use SERIALIZABLE; parent resolution and duplicate scan enforce it. */
async function commitAmuxNodePrepare(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreatePrepare;
    keys: AmuxContentKeys }, level: NodeLevel) {
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
  const context = await nodeContext(tx, input.session, source, level);
  try { await expireStaleAmuxUnitDecision(tx, choice.draftUnitId); }
  catch (error) {
    if (error instanceof AmuxUnitExpiryError) {
      throw new AmuxNodeCreateError(error.code);
    }
    throw error;
  }
  if (await tx.amuxPortfolioNode.findUnique({ where: { id: choice.nodeId },
    select: { id: true } })) throw new AmuxNodeCreateError("not_ready");
  const scan = await currentNodeScan(tx, context, input.keys);
  const reviewed = snapshot({ session: input.session, choice, source,
    context, reviewedScan: scan, keys: input.keys });
  const confirmation = deriveAmuxIdeaUnitConfirmation(reviewed, input.keys,
    scan, null);
  if (!confirmation.ok) throw new AmuxNodeCreateError("not_ready");
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: PREPARE_ACTION, targetType: TARGET,
    targetId: choice.decisionId,
    summary: `Owner prepared one AMUX v4 ${level} hierarchy node decision.`,
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
    baseNodeId: context.parent?.id ?? null,
    baseNodeRevision: context.parent?.revision ?? null,
    baseNodeDigest: context.parent?.content.digest ?? null,
    baseNodeDigestKeyId: context.parent?.content.keyId ?? null,
    preparedAt: source.now,
    expiresAt: new Date(source.now.getTime() + 15 * 60_000),
    prepareAuditLogId: auditId,
  } });
  return { decisionId: decision.id, draftUnitId: decision.draftUnitId,
    confirmationDigest: decision.confirmationDigest,
    expiresAt: decision.expiresAt.toISOString() };
}

export const commitAmuxRootNodePrepare = (tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreatePrepare;
    keys: AmuxContentKeys }) => commitAmuxNodePrepare(tx, input, "initiative");

export const commitAmuxEpicNodePrepare = (tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreatePrepare;
    keys: AmuxContentKeys }) => commitAmuxNodePrepare(tx, input, "epic");

async function commitAmuxNodeConsume(tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreateConsume;
    keys: AmuxContentKeys }, level: NodeLevel) {
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
  const context = await nodeContext(tx, input.session, source, level);
  const proposal = context.proposal;
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
      decision.baseNodeId !== (context.parent?.id ?? null) ||
      decision.baseNodeRevision !== (context.parent?.revision ?? null) ||
      decision.baseNodeDigest !== (context.parent?.content.digest ?? null) ||
      decision.baseNodeDigestKeyId !== (context.parent?.content.keyId ?? null) ||
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
  const currentScan = await currentNodeScan(tx, context, input.keys);
  const currentSnapshot = snapshot({ session: input.session, choice, source,
    context, reviewedScan: stored.duplicates, keys: input.keys });
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
    summary: `Owner approved and registered one AMUX v4 ${level} hierarchy node.`,
    metadata: { ideaId: choice.ideaId, draftUnitId: choice.draftUnitId,
      decisionId: decision.id, consumeRequestId: choice.consumeRequestId,
      confirmationDigest: decision.confirmationDigest,
      resolvedNodeId: choice.nodeId, action: "create_node" },
  });
  await tx.amuxPortfolioNode.create({ data: {
    id: choice.nodeId, level, parentId: context.parent?.id ?? null,
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
    revision: 0, priorRevision: null,
    parentIdAtApproval: context.parent?.id ?? null,
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

export const commitAmuxRootNodeConsume = (tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreateConsume;
    keys: AmuxContentKeys }) => commitAmuxNodeConsume(tx, input, "initiative");

export const commitAmuxEpicNodeConsume = (tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; choice: AmuxNodeCreateConsume;
    keys: AmuxContentKeys }) => commitAmuxNodeConsume(tx, input, "epic");

/** Freeze an exact unresolved consume attempt. The row lock waits for any
 * in-flight consume before deciding; a missing row is never retried. */
export async function commitAmuxRootNodeUnknown(tx: Prisma.TransactionClient,
  input: { actorUserId: string; decisionId: string;
    prepareRequestId: string; consumeRequestId: string }) {
  if (!ACTOR_ID.test(input.actorUserId) || !UUID.test(input.decisionId) ||
      !UUID.test(input.prepareRequestId) || !UUID.test(input.consumeRequestId) ||
      input.consumeRequestId === input.prepareRequestId) {
    throw new AmuxNodeCreateError("integrity_unavailable");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${input.decisionId} AND "actorUserId" = ${input.actorUserId}
      AND "prepareRequestId" = ${input.prepareRequestId}::uuid FOR UPDATE
  `;
  if (locked.length !== 1) return false;
  const row = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: input.decisionId },
  });
  if (!row || row.action !== "create_node" || row.state !== "prepared" ||
      row.prepareRequestId !== input.prepareRequestId ||
      row.consumeRequestId !== null || row.outcomeUnknownAt !== null ||
      row.finalAuditLogId !== null || row.resolvedNodeId !== null) return false;
  const prepared = await tx.adminAuditLog.findUnique({
    where: { id: row.prepareAuditLogId },
  });
  const metadata = prepared?.metadata;
  const meta = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
  const snapshot = meta?.snapshot;
  const stored = snapshot && typeof snapshot === "object" &&
    !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : null;
  const proposal = stored?.nodeProposal;
  const nodeProposal = proposal && typeof proposal === "object" &&
    !Array.isArray(proposal) ? proposal as Record<string, unknown> : null;
  const hierarchy = Array.isArray(stored?.hierarchy) ? stored.hierarchy : null;
  const parentValue = hierarchy?.length === 1 ? hierarchy[0] : null;
  const parent = parentValue && typeof parentValue === "object" &&
    !Array.isArray(parentValue) ? parentValue as Record<string, unknown> : null;
  const parentContentValue = parent?.content;
  const parentContent = parentContentValue &&
    typeof parentContentValue === "object" &&
    !Array.isArray(parentContentValue)
    ? parentContentValue as Record<string, unknown> : null;
  const rootShape = nodeProposal?.level === "initiative" &&
    nodeProposal.parentId === null && hierarchy?.length === 0 &&
    row.baseNodeId === null && row.baseNodeRevision === null &&
    row.baseNodeDigest === null && row.baseNodeDigestKeyId === null;
  const epicShape = nodeProposal?.level === "epic" &&
    parent?.level === "initiative" && parent.parentId === null &&
    parent.state === "active" && parent.id === nodeProposal.parentId &&
    parent.id === row.baseNodeId && parent.revision === row.baseNodeRevision &&
    parentContent?.digest === row.baseNodeDigest &&
    parentContent.keyId === row.baseNodeDigestKeyId;
  if (!prepared?.entryHash || auditRowActorKind(prepared) !== "human" ||
      prepared.actorUserId !== input.actorUserId ||
      prepared.action !== PREPARE_ACTION ||
      prepared.targetType !== TARGET || prepared.targetId !== row.id ||
      meta?.action !== "create_node" || meta.ideaId !== row.ideaId ||
      meta.draftUnitId !== row.draftUnitId ||
      meta.prepareRequestId !== input.prepareRequestId ||
      meta.confirmationDigest !== row.confirmationDigest ||
      meta.confirmationDigestKeyId !== row.confirmationDigestKeyId ||
      stored?.decisionId !== row.id || stored.actorUserId !== row.actorUserId ||
      stored.action !== "create_node" ||
      !(rootShape || epicShape) ||
      !UUID.test(String(nodeProposal.id))) {
    throw new AmuxNodeCreateError("integrity_unavailable");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxNodeCreateError("integrity_unavailable");
  }
  const auditId = await writeSystemAuditLog({
    tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.v4.unit.outcome_unknown", targetType: TARGET,
    targetId: row.id,
    summary: "Froze an AMUX v4 root node decision after an unverified consume result; no retry occurred.",
    metadata: { ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      prepareRequestId: row.prepareRequestId,
      consumeRequestId: input.consumeRequestId, action: "create_node",
      confirmationDigest: row.confirmationDigest, retryAllowed: false },
  });
  const updated = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: row.id, actorUserId: input.actorUserId, state: "prepared",
      outcomeUnknownAt: null, consumeRequestId: null, finalAuditLogId: null },
    data: { outcomeUnknownAt: now,
      outcomeUnknownConsumeRequestId: input.consumeRequestId,
      outcomeUnknownAuditLogId: auditId },
  });
  if (updated.count !== 1) throw new AmuxNodeCreateError("integrity_unavailable");
  return true;
}

/** Owner-confirmed no-commit after the unknown marker has waited out the
 * in-flight row lock. This never replays the attempted create. */
export async function commitAmuxRootNodeNoCommitConfirmed(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; decisionId: string;
    prepareRequestId: string },
  expectedLevel: NodeLevel = "initiative",
) {
  const actorUserId = ownerId(input.session);
  if (!UUID.test(input.decisionId) || !UUID.test(input.prepareRequestId)) {
    throw new AmuxNodeCreateError("not_ready");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${input.decisionId} AND "actorUserId" = ${actorUserId}
      AND "prepareRequestId" = ${input.prepareRequestId}::uuid FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxNodeCreateError("not_found");
  const status = await readAmuxRootNodeDecisionInTransaction(tx,
    input.session, input.decisionId, input.prepareRequestId, expectedLevel);
  if (status.state !== "outcome_unknown") {
    throw new AmuxNodeCreateError(status.state === "partial"
      ? "integrity_unavailable" : "reconfirm");
  }
  const row = await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
    where: { id: input.decisionId },
  });
  if (await tx.amuxPortfolioNode.findUnique({
    where: { id: status.nodeId }, select: { id: true },
  }) ||
      await tx.amuxPortfolioNodeRevision.findFirst({
        where: { decisionId: row.id }, select: { id: true },
      }) ||
      await tx.amuxWorkItem.findFirst({
        where: { v4SourceApprovalId: row.id }, select: { id: true },
      })) throw new AmuxNodeCreateError("integrity_unavailable");
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxNodeCreateError("integrity_unavailable");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.no_commit_confirmed",
    targetType: TARGET, targetId: row.id,
    summary: `Owner confirmed an AMUX v4 ${expectedLevel} node attempt did not commit.`,
    metadata: { ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      prepareRequestId: row.prepareRequestId,
      consumeRequestId: row.outcomeUnknownConsumeRequestId,
      confirmationDigest: row.confirmationDigest,
      action: "create_node", observedNoEffect: true },
  });
  const changed = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: row.id, actorUserId, action: "create_node",
      state: "prepared", outcomeUnknownAt: { not: null },
      outcomeUnknownResolvedAt: null,
      finalAuditLogId: null, resolvedNodeId: null },
    data: { outcomeUnknownResolvedAt: now,
      outcomeUnknownResolution: "no_commit",
      outcomeUnknownResolvedAuditLogId: auditId },
  });
  if (changed.count !== 1) throw new AmuxNodeCreateError("integrity_unavailable");
  return { decisionId: row.id, state: "no_commit_confirmed" as const, auditId };
}
