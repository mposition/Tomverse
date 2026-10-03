import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { auditRowActorKind, AMUX_SYSTEM_AUDIT_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { amuxUnitOwnerId, AmuxUnitRejectError } from
  "./ideaUnitRejectService.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TARGET = "AmuxIdeaUnitDecision";
const PREPARE = "amux.v4.unit.prepare";
const CONSUME = "amux.v4.unit.consume";
const EXPIRE = "amux.v4.unit.expire";
const UNKNOWN = "amux.v4.unit.outcome_unknown";

export class AmuxNodeDecisionReadError extends Error {
  constructor(readonly code: "not_found" | "reconfirm") {
    super(code);
    this.name = "AmuxNodeDecisionReadError";
  }
}

function ownerId(session: Session) {
  try { return amuxUnitOwnerId(session); }
  catch (error) {
    if (error instanceof AmuxUnitRejectError) {
      throw new AmuxNodeDecisionReadError(error.code === "reconfirm"
        ? "reconfirm" : "not_found");
    }
    throw error;
  }
}

const meta = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** Metadata-only exact-ID read-back. A missing row is never a retry grant:
 * an earlier COMMIT can still be in flight. No node title or idea body leaves
 * this function. */
export async function readAmuxRootNodeDecisionInTransaction(
  tx: Prisma.TransactionClient, session: Session,
  decisionId: string, prepareRequestId: string,
) {
  const actorUserId = ownerId(session);
  if (!UUID.test(decisionId) || !UUID.test(prepareRequestId)) {
    throw new AmuxNodeDecisionReadError("not_found");
  }
  const row = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: decisionId },
  });
  const audits = await tx.adminAuditLog.findMany({
    where: { targetType: TARGET, targetId: decisionId,
      action: { in: [PREPARE, CONSUME] } },
  });
  if (!row) {
    const matchingPrepare = audits.some((audit) =>
      audit.action === PREPARE && audit.actorUserId === actorUserId &&
      meta(audit.metadata)?.prepareRequestId === prepareRequestId);
    if (audits.some((audit) => audit.actorUserId !== actorUserId) ||
        (audits.length > 0 && !matchingPrepare)) {
      return { state: "not_visible" } as const;
    }
    return { state: audits.length ? "partial" : "absent" } as const;
  }
  if (row.actorUserId !== actorUserId ||
      row.prepareRequestId !== prepareRequestId) {
    return { state: "not_visible" } as const;
  }
  const prepared = audits.find((audit) => audit.id === row.prepareAuditLogId);
  const preparedMeta = meta(prepared?.metadata);
  const snapshot = meta(preparedMeta?.snapshot);
  const source = meta(snapshot?.source);
  const unitBody = meta(snapshot?.unitBody);
  const ownerSession = meta(snapshot?.ownerSession);
  const proposal = meta(snapshot?.nodeProposal);
  if (row.action !== "create_node" || !prepared?.entryHash ||
      auditRowActorKind(prepared) !== "human" ||
      prepared.actorUserId !== actorUserId || prepared.action !== PREPARE ||
      prepared.targetType !== TARGET || prepared.targetId !== decisionId ||
      audits.filter((audit) => audit.action === PREPARE).length !== 1 ||
      preparedMeta?.action !== "create_node" ||
      preparedMeta.ideaId !== row.ideaId ||
      preparedMeta.draftUnitId !== row.draftUnitId ||
      preparedMeta.prepareRequestId !== prepareRequestId ||
      preparedMeta.confirmationDigest !== row.confirmationDigest ||
      preparedMeta.confirmationDigestKeyId !== row.confirmationDigestKeyId ||
      snapshot?.ideaId !== row.ideaId ||
      snapshot.decisionId !== row.id ||
      snapshot.draftUnitId !== row.draftUnitId ||
      snapshot.actorUserId !== row.actorUserId ||
      snapshot.prepareRequestId !== row.prepareRequestId ||
      snapshot.action !== "create_node" ||
      unitBody?.digest !== row.unitDigest ||
      unitBody.keyId !== row.unitDigestKeyId ||
      ownerSession?.digest !== row.ownerSessionDigest ||
      ownerSession.keyId !== row.ownerSessionDigestKeyId ||
      source?.previewId !== row.sourcePreviewId ||
      meta(source.payload)?.digest !== row.sourcePreviewDigest ||
      meta(source.payload)?.keyId !== row.sourcePreviewDigestKeyId ||
      !proposal || !UUID.test(String(proposal.id)) ||
      proposal.level !== "initiative" || proposal.parentId !== null) {
    return { state: "partial" } as const;
  }
  if (row.state === "prepared" && !row.finalAuditLogId &&
      row.consumeRequestId === null && row.resolvedNodeId === null) {
    if (audits.some((audit) => audit.action === CONSUME)) {
      return { state: "partial" } as const;
    }
    if (row.outcomeUnknownAt) {
      const unknownAudit = row.outcomeUnknownAuditLogId
        ? await tx.adminAuditLog.findUnique({
          where: { id: row.outcomeUnknownAuditLogId },
        }) : null;
      const unknownMeta = meta(unknownAudit?.metadata);
      if (!unknownAudit?.entryHash ||
          auditRowActorKind(unknownAudit) !== "system" ||
          unknownAudit.action !== UNKNOWN ||
          unknownAudit.targetType !== TARGET ||
          unknownAudit.targetId !== row.id ||
          unknownMeta?.systemActor !== AMUX_SYSTEM_AUDIT_ACTOR ||
          unknownMeta.ideaId !== row.ideaId ||
          unknownMeta.draftUnitId !== row.draftUnitId ||
          unknownMeta.prepareRequestId !== row.prepareRequestId ||
          unknownMeta.consumeRequestId !== row.outcomeUnknownConsumeRequestId ||
          unknownMeta.action !== "create_node" ||
          unknownMeta.confirmationDigest !== row.confirmationDigest ||
          unknownMeta.retryAllowed !== false) {
        return { state: "partial" } as const;
      }
      if (row.outcomeUnknownResolvedAt !== null) {
        const resolvedAudit = row.outcomeUnknownResolvedAuditLogId
          ? await tx.adminAuditLog.findUnique({
            where: { id: row.outcomeUnknownResolvedAuditLogId },
          }) : null;
        const resolvedMeta = meta(resolvedAudit?.metadata);
        if (row.outcomeUnknownResolution !== "no_commit" ||
            !resolvedAudit?.entryHash ||
            auditRowActorKind(resolvedAudit) !== "human" ||
            resolvedAudit.actorUserId !== actorUserId ||
            resolvedAudit.action !== "amux.v4.unit.no_commit_confirmed" ||
            resolvedAudit.targetType !== TARGET ||
            resolvedAudit.targetId !== row.id ||
            resolvedMeta?.ideaId !== row.ideaId ||
            resolvedMeta.draftUnitId !== row.draftUnitId ||
            resolvedMeta.prepareRequestId !== row.prepareRequestId ||
            resolvedMeta.consumeRequestId !== row.outcomeUnknownConsumeRequestId ||
            resolvedMeta.confirmationDigest !== row.confirmationDigest ||
            resolvedMeta.action !== "create_node" ||
            resolvedMeta.observedNoEffect !== true) {
          return { state: "partial" } as const;
        }
        return { state: "no_commit_confirmed", decisionId: row.id,
          draftUnitId: row.draftUnitId,
          auditId: row.outcomeUnknownResolvedAuditLogId! } as const;
      }
      return { state: "outcome_unknown", decisionId: row.id } as const;
    }
    return { state: "prepared", decisionId: row.id,
      ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      nodeId: proposal.id as string,
      confirmationDigest: row.confirmationDigest,
      expiresAt: row.expiresAt.toISOString() } as const;
  }
  if (row.state === "expired" && row.finalAuditLogId) {
    const expiry = await tx.adminAuditLog.findUnique({
      where: { id: row.finalAuditLogId },
    });
    const expiryMeta = meta(expiry?.metadata);
    if (!expiry?.entryHash || auditRowActorKind(expiry) !== "system" ||
        expiry.action !== EXPIRE || expiry.targetType !== TARGET ||
        expiry.targetId !== row.id ||
        expiryMeta?.systemActor !== AMUX_SYSTEM_AUDIT_ACTOR ||
        expiryMeta.action !== "create_node" ||
        expiryMeta.ideaId !== row.ideaId ||
        expiryMeta.draftUnitId !== row.draftUnitId ||
        expiryMeta.prepareRequestId !== row.prepareRequestId ||
        row.consumeRequestId !== null || row.resolvedNodeId !== null ||
        row.outcomeUnknownAt !== null ||
        row.outcomeUnknownAuditLogId !== null ||
        row.outcomeUnknownConsumeRequestId !== null ||
        audits.some((audit) => audit.action === CONSUME)) {
      return { state: "partial" } as const;
    }
    return { state: "expired", decisionId: row.id,
      draftUnitId: row.draftUnitId } as const;
  }
  const consumed = audits.find((audit) => audit.id === row.finalAuditLogId);
  const consumedMeta = meta(consumed?.metadata);
  if (row.state !== "consumed" || !row.resolvedNodeId ||
      row.resolvedNodeId !== proposal.id || !row.consumeRequestId ||
      row.outcomeUnknownAt !== null ||
      !consumed?.entryHash || auditRowActorKind(consumed) !== "human" ||
      consumed.actorUserId !== actorUserId || consumed.action !== CONSUME ||
      consumed.targetType !== TARGET || consumed.targetId !== row.id ||
      audits.filter((audit) => audit.action === CONSUME).length !== 1 ||
      consumedMeta?.action !== "create_node" ||
      consumedMeta.ideaId !== row.ideaId ||
      consumedMeta.draftUnitId !== row.draftUnitId ||
      consumedMeta.decisionId !== row.id ||
      consumedMeta.consumeRequestId !== row.consumeRequestId ||
      consumedMeta.confirmationDigest !== row.confirmationDigest ||
      consumedMeta.resolvedNodeId !== row.resolvedNodeId) {
    return { state: "partial" } as const;
  }
  const node = await tx.amuxPortfolioNode.findUnique({
    where: { id: row.resolvedNodeId },
  });
  const revision = await tx.amuxPortfolioNodeRevision.findFirst({
    where: { nodeId: row.resolvedNodeId, decisionId: row.id },
  });
  const unit = await tx.amuxIdeaDraftUnit.findUnique({
    where: { id: row.draftUnitId },
  });
  if (!node || !revision || unit?.state !== "approved" ||
      node.level !== "initiative" || node.parentId !== null ||
      node.approvedByUserId !== actorUserId ||
      node.authorizationAuditLogId !== row.finalAuditLogId ||
      node.contentDigest !== revision.contentDigest ||
      node.contentDigestKeyId !== revision.contentDigestKeyId ||
      revision.authorizationAuditLogId !== row.finalAuditLogId) {
    return { state: "partial" } as const;
  }
  return { state: "created", decisionId: row.id,
    draftUnitId: row.draftUnitId, nodeId: node.id,
    confirmationDigest: row.confirmationDigest,
    consumeRequestId: row.consumeRequestId,
    auditId: row.finalAuditLogId } as const;
}

export async function readAmuxRootNodeDecision(session: Session,
  decisionId: string, prepareRequestId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
    `;
    return readAmuxRootNodeDecisionInTransaction(tx, session,
      decisionId, prepareRequestId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 8_000 });
}
