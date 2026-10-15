import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { AmuxNodeDuplicateScanError, loadAmuxNodeDuplicateScanner } from
  "./ideaNodeDuplicateScanService.ts";
import { prepareAmuxV4NodeCreationInTx } from "./ideaNodeRegistrationService.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { createAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { deriveAmuxIdeaUnitConfirmation, sameAmuxIdeaUnitConfirmation } from
  "./ideaUnitConfirmationCore.ts";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4UnitDecisionError, amuxV4UnitWriteEnabled,
  commitAmuxV4NodeCreation } from "./ideaUnitDecisionStore.ts";
import { readVerifiedAmuxNodeProposal } from "./ideaUnitProposalReadService.ts";
import { AMUX_V4_NODE_PLAN_MAX_UNITS, AmuxV4NodePlanError, orderAmuxV4NodePlan } from
  "./ideaNodePlanCore.ts";

export { AmuxV4NodePlanError } from "./ideaNodePlanCore.ts";

const ID = /^[A-Za-z0-9_-]{8,80}$/;
/**
 * Plan approval, node part (amux-intake.md v18 item 3): every proposed node
 * unit of an idea (Initiative, Epic, Feature) is prepared and consumed in ONE
 * transaction, parents first. Each decision is still its own row with its own
 * prepare and consume audit entries, digest and checks, exactly as the single
 * prepare/consume routes write them; only the clicks between them are gone.
 * A refusal of any unit rolls the whole plan back -- there is no partial
 * registration. The browser binding of the two-request flow has no second
 * request to bind here, so a server nonce stands in for it within this one
 * request. Cards, rejections, scores and PR consent are separate.
 */
export async function approveAmuxV4NodePlan(session: Session, request: Request,
  input: { ideaId: string; reasons: Readonly<Record<string, string>> }) {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  await assertRecentAdminAuthentication(session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  if (!ID.test(input.ideaId)) throw new AmuxV4UnitDecisionError("not_ready");
  for (const [unitId, reason] of Object.entries(input.reasons)) {
    if (!ID.test(unitId) || reason.length < 3 || reason.length > 500 || reason !== reason.trim()) {
      throw new AmuxV4NodePlanError("reason_invalid", [unitId]);
    }
  }
  const proposed = await prisma.amuxIdeaDraftUnit.findMany({
    where: { ideaId: input.ideaId, actorUserId, unitKind: "node", state: "proposed" },
    select: { id: true }, orderBy: { id: "asc" }, take: AMUX_V4_NODE_PLAN_MAX_UNITS + 1,
  });
  if (proposed.length === 0) throw new AmuxV4NodePlanError("nothing_to_approve");
  if (proposed.length > AMUX_V4_NODE_PLAN_MAX_UNITS) throw new AmuxV4NodePlanError("too_many_units");
  const verified = await Promise.all(proposed.map((unit) =>
    readVerifiedAmuxNodeProposal(session, input.ideaId, unit.id)));

  // Parents approved in an earlier round resolve to the node their decision created.
  const approvedUnits = await prisma.amuxIdeaDraftUnit.findMany({
    where: { ideaId: input.ideaId, actorUserId, unitKind: "node", state: "approved" },
    select: { id: true, localRef: true },
  });
  const existing = new Map<string, string>();
  for (const unit of approvedUnits) {
    const decision = await prisma.amuxIdeaUnitDecision.findFirst({
      where: { draftUnitId: unit.id, actorUserId, state: "consumed",
        action: { in: ["create_node", "select_existing_node", "link_existing_node"] } },
      select: { resolvedNodeId: true, linkedNodeId: true },
    });
    const nodeId = decision?.resolvedNodeId ?? decision?.linkedNodeId ?? null;
    if (unit.localRef && nodeId) existing.set(unit.localRef, nodeId);
  }
  const plan = orderAmuxV4NodePlan(verified.map((entry) => ({
    draftUnitId: entry.unit.id, localRef: entry.unit.localRef ?? "",
    level: entry.proposal.level, parentRef: entry.proposal.parentRef, verified: entry,
    decisionId: randomUUID(), nodeId: randomUUID(),
  })), existing);
  const nodeIdOf = new Map(plan.map((entry) => [entry.localRef, entry.nodeId]));
  const parentNodeIdOf = (entry: (typeof plan)[number]) => entry.parent.kind === "none" ? null :
    entry.parent.kind === "existing" ? entry.parent.nodeId : nodeIdOf.get(entry.parent.localRef)!;

  const scanner = await loadAmuxNodeDuplicateScanner();
  const keys = loadCurrentAmuxContentKeys(process.env);
  let contentKeys;
  try {
    contentKeys = await createAmuxContentKeyRing(
      plan.map((entry) => ({ ideaId: input.ideaId, purpose: "analysis_draft" as const, subjectId: entry.draftUnitId })),
      plan.map((entry) => ({ ideaId: input.ideaId, purpose: "node_content" as const, subjectId: entry.nodeId })));
  } catch { throw new AmuxV4UnitDecisionError("integrity_unavailable"); }
  const nonce = randomBytes(32).toString("base64url");

  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const nodes: Array<{ draftUnitId: string; decisionId: string; nodeId: string;
        level: string; title: string }> = [];
      for (const entry of plan) {
        const parentNodeId = parentNodeIdOf(entry);
        const ownerSession = amuxV4UnitBrowserDigest({ decisionId: entry.decisionId, actorUserId,
          authenticatedAt: session.user?.authenticatedAt, nonce, key: keys });
        const { result, snapshot } = await prepareAmuxV4NodeCreationInTx(tx, {
          session, request, actorUserId,
          choice: { ideaId: input.ideaId, draftUnitId: entry.draftUnitId, parentNodeId,
            prepareRequestId: randomUUID(), decisionReason: input.reasons[entry.draftUnitId] ?? null },
          verified: entry.verified, scanner, keys, decisionId: entry.decisionId,
          nodeId: entry.nodeId, ownerSession,
        });
        const current = deriveAmuxIdeaUnitConfirmation(snapshot, keys, snapshot.duplicates, null);
        if (!current.ok || !sameAmuxIdeaUnitConfirmation(current.confirmationDigest, result.confirmationDigest)) {
          throw new AmuxV4UnitDecisionError("reconfirm");
        }
        await commitAmuxV4NodeCreation(tx, {
          session, request, snapshot, proposal: entry.verified.proposal,
          consumeRequestId: randomUUID(), keys: contentKeys,
          recalculate: (transaction) => scanner(transaction, {
            unitId: entry.draftUnitId, title: entry.verified.proposal.title,
            level: entry.verified.proposal.level, parentId: parentNodeId,
          }),
          context: { decisionId: entry.decisionId, ideaId: input.ideaId,
            draftUnitId: entry.draftUnitId, actorUserId, recentOwnerStepUp: true,
            ownerSessionDigest: ownerSession.digest, ownerSessionDigestKeyId: ownerSession.keyId },
        });
        // The next unit's scan sees this node as the plan's own, not as an
        // unexpected change to the catalog.
        await scanner.admitCreated(tx, { id: entry.nodeId, title: entry.verified.proposal.title });
        nodes.push({ draftUnitId: entry.draftUnitId, decisionId: entry.decisionId,
          nodeId: entry.nodeId, level: entry.level, title: entry.verified.proposal.title });
      }
      callbackReturned = true;
      return { ideaId: input.ideaId, nodes, executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 60_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxNodeDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    // Nothing per decision is marked: the plan committed whole or not at all,
    // and the read-back by draft unit says which.
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}
