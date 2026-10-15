import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { amuxV4PlanFailure, prepareAmuxV4CardPlan, runAmuxV4CardPlanInTx } from
  "./ideaCardPlanApprovalService.ts";
import { prepareAmuxV4NodePlan, runAmuxV4NodePlanInTx } from "./ideaNodePlanApprovalService.ts";
import { AmuxNodeDuplicateScanError } from "./ideaNodeDuplicateScanService.ts";
import { AmuxV4UnitDecisionError } from "./ideaUnitDecisionStore.ts";
import { AmuxPortfolioError } from "./portfolioAssessmentService.ts";
import { prepareAmuxV4ScorePlan, runAmuxV4ScorePlanInTx,
  type AmuxV4ScorePlanAssessment } from "./portfolioPlanApprovalService.ts";

/** One assessment on the plan screen, for a unit of this plan (by draft unit
 * id) or for a subject that already exists. */
export type AmuxV4PlanAssessmentInput = Omit<AmuxV4ScorePlanAssessment, "subject"> &
  ({ unitId: string; subject?: never } | { subject: AmuxV4ScorePlanAssessment["subject"]; unitId?: never });

export class AmuxV4PlanError extends Error {
  constructor(readonly code: "nothing_to_approve" | "unit_not_in_plan" | "plan_changed",
    readonly draftUnitIds: string[] = []) {
    super(code);
    this.name = "AmuxV4PlanError";
  }
}

/**
 * The whole plan approval (amux-intake.md v18 item 3): every proposed node,
 * then every proposed Story and Task (the first round of a large plan), then
 * the assessments and Task scores the owner confirmed -- ONE transaction, with
 * no partial registration. Each part runs exactly the writers of its own
 * route; the node and card ids are made before the transaction, so a card can
 * name a Feature this plan creates and an assessment can name a unit of this
 * plan. A refusal of anything rolls everything back.
 */
export async function approveAmuxV4Plan(session: Session, request: Request, input: {
  ideaId: string; planRequestId: string;
  reasons: Readonly<Record<string, string>>; publicPrConsentOff: readonly string[];
  assessments: readonly AmuxV4PlanAssessmentInput[]; scoreTaskUnitIds: readonly string[];
  /** Exactly the units the screen showed for this approval. */
  expectedUnitIds: readonly string[];
}) {
  const nodes = await prepareAmuxV4NodePlan(session, request,
    { ideaId: input.ideaId, reasons: input.reasons }, { allowEmpty: true });
  const pendingFeatures = new Map(nodes.plan.filter((entry) => entry.level === "feature")
    .map((entry) => [entry.localRef, entry.nodeId]));
  const cards = await prepareAmuxV4CardPlan(session, request,
    { ideaId: input.ideaId, reasons: input.reasons, publicPrConsentOff: input.publicPrConsentOff },
    { allowEmpty: true, pendingFeatures });

  // The owner approves what the screen showed: every unit this approval would
  // register, and nothing else. A difference (another analysis page, a
  // later round, a unit decided elsewhere meanwhile) refuses before writing.
  const willRegister = [...nodes.plan.map((entry) => entry.draftUnitId),
    ...cards.plan.map((entry) => entry.draftUnitId)];
  const expected = new Set(input.expectedUnitIds);
  const differs = [...willRegister.filter((id) => !expected.has(id)),
    ...input.expectedUnitIds.filter((id) => !willRegister.includes(id))];
  if (differs.length > 0 || expected.size !== input.expectedUnitIds.length) {
    throw new AmuxV4PlanError("plan_changed", [...new Set(differs)]);
  }
  const subjectOfUnit = new Map<string, AmuxV4ScorePlanAssessment["subject"]>([
    ...nodes.plan.map((entry) => [entry.draftUnitId, { kind: entry.level, id: entry.nodeId }] as const),
    ...cards.plan.map((entry) => [entry.draftUnitId, { kind: entry.cardType, id: entry.cardId }] as const),
  ]);
  const missing = [...input.assessments.flatMap((entry) => entry.unitId ? [entry.unitId] : []),
    ...input.scoreTaskUnitIds].filter((unitId) => !subjectOfUnit.has(unitId));
  const notTasks = input.scoreTaskUnitIds.filter((unitId) => subjectOfUnit.get(unitId)?.kind !== "task");
  if (missing.length > 0 || notTasks.length > 0) {
    throw new AmuxV4PlanError("unit_not_in_plan", [...new Set([...missing, ...notTasks])]);
  }
  if (nodes.plan.length + cards.plan.length + input.assessments.length === 0) {
    throw new AmuxV4PlanError("nothing_to_approve");
  }
  const score = await prepareAmuxV4ScorePlan(session, request, {
    planRequestId: input.planRequestId,
    assessments: input.assessments.map((entry) => ({
      subject: entry.unitId ? subjectOfUnit.get(entry.unitId)! : entry.subject!,
      metrics: entry.metrics, uncertainty: entry.uncertainty,
      evidenceRefs: entry.evidenceRefs, modelProposalDigest: entry.modelProposalDigest,
    })),
    taskIds: input.scoreTaskUnitIds.map((unitId) => subjectOfUnit.get(unitId)!.id),
  }, { allowEmpty: true });

  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const createdNodes = await runAmuxV4NodePlanInTx(tx, nodes);
      const createdCards = await runAmuxV4CardPlanInTx(tx, cards);
      const scored = await runAmuxV4ScorePlanInTx(tx, score);
      callbackReturned = true;
      return { ideaId: input.ideaId, nodes: createdNodes, cards: createdCards,
        remainingCards: cards.remaining, ...scored,
        backlogOnly: true as const, executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 120_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxPortfolioError) throw error;
    if (!callbackReturned && error instanceof AmuxNodeDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    throw amuxV4PlanFailure(error, callbackReturned);
  }
}
