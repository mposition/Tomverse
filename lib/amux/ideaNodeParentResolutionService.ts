import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { readAmuxRootNodeDecisionInTransaction } from
  "./ideaNodeDecisionReadService.ts";
import { amuxUnitOwnerId, AmuxUnitRejectError } from
  "./ideaUnitRejectService.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const ROOT_REF = /^c(0|[1-9][0-9]*):node-(0|[1-9][0-9]{0,3})$/;

export class AmuxNodeParentResolutionError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "reconfirm" |
    "integrity_unavailable") {
    super(code);
    this.name = "AmuxNodeParentResolutionError";
  }
}

/** A child may bind only to a root created by a consumed owner decision in
 * this idea. A proposal localRef alone is never a persisted parent. The
 * caller's SERIALIZABLE transaction must re-run this on consume. */
export async function resolveApprovedAmuxRootParent(
  tx: Prisma.TransactionClient, session: Session,
  input: { ideaId: string; parentRef: string },
) {
  let actorUserId: string;
  try { actorUserId = amuxUnitOwnerId(session); }
  catch (error) {
    if (error instanceof AmuxUnitRejectError) {
      throw new AmuxNodeParentResolutionError(error.code === "reconfirm"
        ? "reconfirm" : "not_found");
    }
    throw error;
  }
  if (!ID.test(input.ideaId) || !ROOT_REF.test(input.parentRef)) {
    throw new AmuxNodeParentResolutionError("not_ready");
  }
  const isolation = await tx.$queryRaw<Array<{ level: string }>>`
    SELECT current_setting('transaction_isolation') AS "level"
  `;
  if (isolation[0]?.level !== "serializable") {
    throw new AmuxNodeParentResolutionError("integrity_unavailable");
  }
  const unit = await tx.amuxIdeaDraftUnit.findUnique({
    where: { ideaId_localRef: { ideaId: input.ideaId,
      localRef: input.parentRef } },
  });
  if (!unit || unit.actorUserId !== actorUserId) {
    throw new AmuxNodeParentResolutionError("not_found");
  }
  if (unit.unitKind !== "node" || unit.state !== "approved") {
    throw new AmuxNodeParentResolutionError("not_ready");
  }
  const decisions = await tx.amuxIdeaUnitDecision.findMany({
    where: { draftUnitId: unit.id, ideaId: input.ideaId, actorUserId,
      action: "create_node", state: "consumed" }, take: 2,
  });
  if (decisions.length !== 1) {
    throw new AmuxNodeParentResolutionError("integrity_unavailable");
  }
  const decision = decisions[0]!;
  const readBack = await readAmuxRootNodeDecisionInTransaction(tx, session,
    decision.id, decision.prepareRequestId);
  if (readBack.state !== "created" ||
      readBack.nodeId !== decision.resolvedNodeId) {
    throw new AmuxNodeParentResolutionError("integrity_unavailable");
  }
  const node = await tx.amuxPortfolioNode.findUnique({
    where: { id: readBack.nodeId },
  });
  const revision = await tx.amuxPortfolioNodeRevision.findUnique({
    where: { nodeId_revision: { nodeId: readBack.nodeId,
      revision: node?.revision ?? -1 } },
  });
  if (!node || node.level !== "initiative" || node.parentId !== null ||
      node.state !== "active" || node.approvedByUserId !== actorUserId ||
      !revision || revision.decisionId !== decision.id ||
      revision.authorizationAuditLogId !== node.authorizationAuditLogId ||
      revision.contentDigest !== node.contentDigest ||
      revision.contentDigestKeyId !== node.contentDigestKeyId) {
    throw new AmuxNodeParentResolutionError("integrity_unavailable");
  }
  return { id: node.id, level: "initiative" as const, parentId: null,
    revision: node.revision,
    content: { digest: node.contentDigest, keyId: node.contentDigestKeyId },
    state: "active" as const, approvedDecisionId: decision.id };
}
