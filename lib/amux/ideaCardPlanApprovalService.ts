import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { AmuxCardDuplicateScanError, loadAmuxCardDuplicateScanner } from
  "./ideaCardDuplicateScanService.ts";
import { AMUX_V4_CARD_PLAN_MAX_PROPOSED, AmuxV4CardPlanError, amuxV4CardPlanRound,
  amuxV4PlanPublicPrConsent, orderAmuxV4CardPlan } from "./ideaCardPlanCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { createAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { prepareAmuxV4CardRegistrationInTx } from "./ideaStoryRegistrationService.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { deriveAmuxIdeaUnitConfirmation, sameAmuxIdeaUnitConfirmation } from
  "./ideaUnitConfirmationCore.ts";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4UnitDecisionError, amuxV4UnitWriteEnabled,
  commitAmuxV4CardRegistration } from "./ideaUnitDecisionStore.ts";
import { readVerifiedAmuxCardProposal } from "./ideaUnitProposalReadService.ts";
import { AmuxV4TaskCatalogApprovalError, calculateCurrentApprovedAmuxV4TaskCost } from
  "./v4TaskCostCatalogApprovalService.ts";

export { AmuxV4CardPlanError } from "./ideaCardPlanCore.ts";

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/**
 * Plan approval, card part (amux-intake.md v18 item 3): every proposed Story
 * and Task of an idea is prepared and consumed in ONE transaction, Stories
 * first and Tasks after the plan's own cards they depend on. Each decision is
 * still its own row with its own prepare and consume audit entries, digest,
 * cost receipt and checks, exactly as the single routes write them; a refusal
 * of any unit rolls the whole plan back. An implement Task's public PR
 * consent is on unless the owner listed it in `publicPrConsentOff`. The
 * Features must already be approved (the node part of the plan).
 */
export async function approveAmuxV4CardPlan(session: Session, request: Request, input: {
  ideaId: string; reasons: Readonly<Record<string, string>>; publicPrConsentOff: readonly string[];
}) {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  await assertRecentAdminAuthentication(session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  if (!ID.test(input.ideaId) || input.publicPrConsentOff.some((id) => !ID.test(id))) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  for (const [unitId, reason] of Object.entries(input.reasons)) {
    if (!ID.test(unitId) || reason.length < 3 || reason.length > 500 || reason !== reason.trim()) {
      throw new AmuxV4CardPlanError("reason_invalid", [unitId]);
    }
  }
  const proposed = await prisma.amuxIdeaDraftUnit.findMany({
    where: { ideaId: input.ideaId, actorUserId, unitKind: "card", state: "proposed" },
    select: { id: true }, orderBy: { id: "asc" }, take: AMUX_V4_CARD_PLAN_MAX_PROPOSED + 1,
  });
  if (proposed.length === 0) throw new AmuxV4CardPlanError("nothing_to_approve");
  if (proposed.length > AMUX_V4_CARD_PLAN_MAX_PROPOSED) throw new AmuxV4CardPlanError("too_many_units");
  const verified = await Promise.all(proposed.map((unit) =>
    readVerifiedAmuxCardProposal(session, input.ideaId, unit.id)));

  // A Feature is a node a consumed decision of this idea created or linked, or a node id.
  const approvedNodes = await prisma.amuxIdeaDraftUnit.findMany({
    where: { ideaId: input.ideaId, actorUserId, unitKind: "node", state: "approved" },
    select: { id: true, localRef: true },
  });
  const featureOf = new Map<string, string>();
  for (const unit of approvedNodes) {
    const decision = await prisma.amuxIdeaUnitDecision.findFirst({
      where: { draftUnitId: unit.id, actorUserId, state: "consumed",
        action: { in: ["create_node", "select_existing_node", "link_existing_node"] } },
      select: { resolvedNodeId: true, linkedNodeId: true },
    });
    const nodeId = decision?.resolvedNodeId ?? decision?.linkedNodeId ?? null;
    if (unit.localRef && nodeId) featureOf.set(unit.localRef, nodeId);
  }
  const unresolved = verified.filter((entry) =>
    !featureOf.has(entry.proposal.featureRef) && !UUID.test(entry.proposal.featureRef));
  if (unresolved.length > 0) {
    throw new AmuxV4CardPlanError("feature_unresolved", unresolved.map((entry) => entry.unit.id));
  }
  const consentOff = new Set(input.publicPrConsentOff);
  const ordered = orderAmuxV4CardPlan(verified.map((entry) => ({
    draftUnitId: entry.unit.id, localRef: entry.unit.localRef ?? "",
    cardType: entry.proposal.cardType, parentStoryRef: entry.proposal.parentStoryRef,
    dependencyRefs: entry.proposal.dependencyRefs, verified: entry,
    featureNodeId: featureOf.get(entry.proposal.featureRef) ?? entry.proposal.featureRef,
    decisionId: randomUUID(), cardId: randomUUID(),
  })));
  // A large plan is approved in rounds; this one is the dependency-closed prefix.
  const { round: plan, remaining } = amuxV4CardPlanRound(ordered);

  const scanner = await loadAmuxCardDuplicateScanner();
  const keys = loadCurrentAmuxContentKeys(process.env);
  let contentKeys;
  try {
    contentKeys = await createAmuxContentKeyRing(
      plan.map((entry) => ({ ideaId: input.ideaId, purpose: "analysis_draft" as const,
        subjectId: entry.draftUnitId })),
      plan.flatMap((entry) => [
        { ideaId: input.ideaId, purpose: "card_title" as const, subjectId: entry.cardId },
        { ideaId: input.ideaId, purpose: "card_body" as const, subjectId: entry.cardId },
        ...(entry.cardType === "task" ? [{ ideaId: input.ideaId, purpose: "card_brief" as const,
          subjectId: entry.cardId }] : []),
      ]));
  } catch { throw new AmuxV4UnitDecisionError("integrity_unavailable"); }
  const nonce = randomBytes(32).toString("base64url");

  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const cards: Array<{ draftUnitId: string; decisionId: string; cardId: string;
        cardType: string; title: string; publicPrDisclosureApproved: boolean }> = [];
      for (const entry of plan) {
        const proposal = entry.verified.proposal;
        const publicPr = amuxV4PlanPublicPrConsent({ draftUnitId: entry.draftUnitId,
          cardType: entry.cardType, taskRole: proposal.taskRole ?? null }, consentOff);
        const ownerSession = amuxV4UnitBrowserDigest({ decisionId: entry.decisionId, actorUserId,
          authenticatedAt: session.user?.authenticatedAt, nonce, key: keys });
        const { result, snapshot } = await prepareAmuxV4CardRegistrationInTx(tx, {
          session, request, actorUserId,
          choice: { ideaId: input.ideaId, draftUnitId: entry.draftUnitId,
            featureNodeId: entry.featureNodeId, prepareRequestId: randomUUID(),
            decisionReason: input.reasons[entry.draftUnitId] ?? null,
            cardType: entry.cardType, publicPrDisclosureApproved: publicPr },
          verified: entry.verified, scanner, keys, decisionId: entry.decisionId, ownerSession,
        });
        const current = deriveAmuxIdeaUnitConfirmation(snapshot, keys, snapshot.duplicates,
          snapshot.card?.cardType === "task" ? { ok: true, receipt: snapshot.card.task!.costReceipt } : null);
        if (!current.ok || !sameAmuxIdeaUnitConfirmation(current.confirmationDigest, result.confirmationDigest)) {
          throw new AmuxV4UnitDecisionError("reconfirm");
        }
        await commitAmuxV4CardRegistration(tx, {
          session, request, snapshot, proposal, cardId: entry.cardId,
          consumeRequestId: randomUUID(), keys: contentKeys,
          recalculate: async (transaction) => {
            let taskCost = null;
            if (proposal.cardType === "task") {
              if (!proposal.taskRole || !proposal.executionGrade) {
                throw new AmuxV4UnitDecisionError("reconfirm");
              }
              const approved = await calculateCurrentApprovedAmuxV4TaskCost(transaction,
                proposal.taskRole, proposal.executionGrade);
              taskCost = { ok: true as const, receipt: approved.receipt };
            }
            return { duplicateScan: await scanner(transaction, { unitId: entry.draftUnitId,
              proposal, featureNodeId: entry.featureNodeId }), taskCost };
          },
          context: { decisionId: entry.decisionId, ideaId: input.ideaId,
            draftUnitId: entry.draftUnitId, actorUserId, recentOwnerStepUp: true,
            ownerSessionDigest: ownerSession.digest, ownerSessionDigestKeyId: ownerSession.keyId },
        });
        // The next unit's scan sees this card as the plan's own.
        await scanner.admitCreated(tx, { id: entry.cardId, title: proposal.title });
        cards.push({ draftUnitId: entry.draftUnitId, decisionId: entry.decisionId,
          cardId: entry.cardId, cardType: entry.cardType, title: proposal.title,
          publicPrDisclosureApproved: publicPr });
      }
      callbackReturned = true;
      return { ideaId: input.ideaId, cards, remaining, backlogOnly: true as const,
        executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 90_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxV4TaskCatalogApprovalError) {
      throw new AmuxV4UnitDecisionError("not_ready");
    }
    if (!callbackReturned && error instanceof AmuxCardDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    // The plan committed whole or not at all; the read-back by draft unit says which.
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}
