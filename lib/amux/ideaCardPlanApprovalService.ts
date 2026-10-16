import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { AMUX_IDEA_CARD_PLAN_APPROVAL_TRANSACTION } from "./ideaRequestTimeoutsCore.ts";
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
import { inspectAmuxV20TaskRegistration } from
  "./ideaUnitRegistrationCore.ts";
import { AmuxV20RegistrationRefusalDetected } from
  "./ideaRegistrationRefusalDetectionCore.ts";
import { recordAmuxV20RegistrationRefusal } from
  "./ideaRegistrationRefusalService.ts";
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
 * Features must already be approved, or be created by the node part of the
 * same whole-plan transaction (`pendingFeatures`).
 */
export async function approveAmuxV4CardPlan(session: Session, request: Request, input: {
  ideaId: string; planRequestId: string;
  reasons: Readonly<Record<string, string>>; publicPrConsentOff: readonly string[];
}) {
  if (!UUID.test(input.planRequestId)) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  let preparedComplete = false;
  let callbackReturned = false;
  try {
    const prepared = await prepareAmuxV4CardPlan(session, request, input);
    preparedComplete = true;
    return await prisma.$transaction(async (tx) => {
      const cards = await runAmuxV4CardPlanInTx(tx, prepared);
      callbackReturned = true;
      return { ideaId: input.ideaId, cards, remaining: prepared.remaining,
        backlogOnly: true as const, executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      ...AMUX_IDEA_CARD_PLAN_APPROVAL_TRANSACTION });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV20RegistrationRefusalDetected) {
      try {
        await recordAmuxV20RegistrationRefusal({ session, request,
          requestId: input.planRequestId, attemptKind: "whole_plan",
          refusalCode: error.code, ...error.identity,
          proposedExecutionGrade: error.proposedExecutionGrade,
          finalExecutionGrade: error.finalExecutionGrade });
      } catch {
        throw new AmuxV4UnitDecisionError("integrity_unavailable");
      }
      throw new AmuxV4UnitDecisionError(error.code);
    }
    if (!preparedComplete) throw error;
    throw amuxV4PlanFailure(error, callbackReturned);
  }
}

export type AmuxV4CardPlanPrepared = Awaited<ReturnType<typeof prepareAmuxV4CardPlan>>;

/** Everything the card part reads and makes before its transaction. */
export async function prepareAmuxV4CardPlan(session: Session, request: Request, input: {
  ideaId: string; reasons: Readonly<Record<string, string>>; publicPrConsentOff: readonly string[];
}, options: { allowEmpty?: boolean; pendingFeatures?: ReadonlyMap<string, string> } = {}) {
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
    // The analysis's own units only; a derived unit keeps its own flow.
    where: { ideaId: input.ideaId, actorUserId, unitKind: "card", state: "proposed",
      derivationGroupId: null },
    select: { id: true }, orderBy: { id: "asc" }, take: AMUX_V4_CARD_PLAN_MAX_PROPOSED + 1,
  });
  if (proposed.length === 0 && !options.allowEmpty) throw new AmuxV4CardPlanError("nothing_to_approve");
  if (proposed.length > AMUX_V4_CARD_PLAN_MAX_PROPOSED) throw new AmuxV4CardPlanError("too_many_units");
  const verified = await Promise.all(proposed.map((unit) =>
    readVerifiedAmuxCardProposal(session, input.ideaId, unit.id)));
  for (const entry of verified) {
    if (entry.proposal.cardType !== "task") continue;
    const inspected = inspectAmuxV20TaskRegistration(entry.proposal);
    if (!inspected.ok) {
      throw new AmuxV20RegistrationRefusalDetected(inspected.code, {
        ideaId: input.ideaId, draftUnitId: entry.unit.id,
        analysisPreviewId: entry.previewId,
      }, entry.proposal);
    }
  }

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
  // Features the node part of the same transaction will create, by local ref.
  for (const [localRef, nodeId] of options.pendingFeatures ?? []) featureOf.set(localRef, nodeId);
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

  const keys = loadCurrentAmuxContentKeys(process.env);
  const nonce = randomBytes(32).toString("base64url");
  const base = { session, request, actorUserId, ideaId: input.ideaId, reasons: input.reasons,
    consentOff, plan, remaining, keys, nonce };
  if (plan.length === 0) return { ...base, scanner: null, contentKeys: null };
  const scanner = await loadAmuxCardDuplicateScanner();
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
  return { ...base, scanner, contentKeys };
}

/** The card part inside the caller's transaction, in plan order. */
export async function runAmuxV4CardPlanInTx(tx: Prisma.TransactionClient,
  prepared: AmuxV4CardPlanPrepared) {
  const { session, request, actorUserId, plan, consentOff, keys, nonce } = prepared;
  const input = { ideaId: prepared.ideaId, reasons: prepared.reasons };
  const cards: Array<{ draftUnitId: string; decisionId: string; cardId: string;
    cardType: string; title: string; publicPrDisclosureApproved: boolean }> = [];
  if (plan.length === 0) return cards;
  const scanner = prepared.scanner!;
  const contentKeys = prepared.contentKeys!;
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
          const inspected = inspectAmuxV20TaskRegistration(proposal);
          if (!inspected.ok) {
            throw new AmuxV20RegistrationRefusalDetected(inspected.code, {
              ideaId: input.ideaId, draftUnitId: entry.draftUnitId,
              analysisPreviewId: entry.verified.previewId,
            }, proposal);
          }
          const approved = await calculateCurrentApprovedAmuxV4TaskCost(transaction,
            proposal.taskRole, inspected.executionGrade);
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
  return cards;
}

/** Refusals from inside a plan transaction surface as themselves; anything
 * after the callback returned is an unknown outcome. */
export function amuxV4PlanFailure(error: unknown, callbackReturned: boolean): Error {
  if (!callbackReturned && error instanceof AmuxV20RegistrationRefusalDetected) {
    return new AmuxV4UnitDecisionError(error.code);
  }
  if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) return error;
  if (!callbackReturned && error instanceof AmuxV4TaskCatalogApprovalError) {
    return new AmuxV4UnitDecisionError("not_ready");
  }
  if (!callbackReturned && error instanceof AmuxCardDuplicateScanError) {
    return new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
      "integrity_unavailable" : "reconfirm");
  }
  // The plan committed whole or not at all; the read-back by draft unit says which.
  return new AmuxV4UnitDecisionError("outcome_unknown");
}
