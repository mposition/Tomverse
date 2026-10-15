import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";

import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { AMUX_V4_PORTFOLIO_WRITE_ENV, AmuxPortfolioError, amuxPortfolioOwnerId,
  amuxV4PortfolioWriteEnabled, writeAmuxPortfolioAssessmentInTx } from
  "./portfolioAssessmentService.ts";
import { writeAmuxPortfolioScoreInTx } from "./portfolioScoreService.ts";
import type { AmuxPortfolioAssessmentPayload } from "./portfolioScoreSchemas.ts";

export const AMUX_V4_SCORE_PLAN_MAX_ASSESSMENTS = 64;
export const AMUX_V4_SCORE_PLAN_MAX_TASKS = 32;
const ID = /^[A-Za-z0-9:_-]{8,128}$/;

export class AmuxV4ScorePlanError extends Error {
  constructor(readonly code: "outcome_unknown") {
    super(code);
    this.name = "AmuxV4ScorePlanError";
  }
}

export type AmuxV4ScorePlanAssessment = {
  subject: AmuxPortfolioAssessmentPayload["subject"];
  metrics: unknown;
  uncertainty: AmuxPortfolioAssessmentPayload["uncertainty"];
  evidenceRefs: string[];
  modelProposalDigest: string | null;
};

/**
 * Plan approval, score part (amux-intake.md v18 item 3): the assessments the
 * owner confirmed on the plan screen -- each subject once, so an Initiative
 * shared by several Tasks is assessed a single time -- and then the score of
 * every listed Task, all in ONE transaction. Each assessment and each score is
 * still its own row with its own owner audit entry, written by exactly the
 * writers the single portfolio route uses, and the score is still computed
 * deterministically from the latest assessments. A refusal of any one rolls
 * the whole plan back. The values written are the ones in this request, so
 * there is no separate preview digest to echo.
 */
export async function approveAmuxV4ScorePlan(session: Session, request: Request, input: {
  assessments: readonly AmuxV4ScorePlanAssessment[]; taskIds: readonly string[];
}) {
  amuxPortfolioOwnerId(session);
  await assertRecentAdminAuthentication(session);
  if (!amuxV4PortfolioWriteEnabled(process.env[AMUX_V4_PORTFOLIO_WRITE_ENV])) {
    throw new AmuxPortfolioError("write_disabled");
  }
  const subjects = input.assessments.map((entry) => entry.subject.id);
  if (input.assessments.length + input.taskIds.length === 0 ||
      input.assessments.length > AMUX_V4_SCORE_PLAN_MAX_ASSESSMENTS ||
      input.taskIds.length > AMUX_V4_SCORE_PLAN_MAX_TASKS ||
      new Set(subjects).size !== subjects.length ||
      new Set(input.taskIds).size !== input.taskIds.length ||
      [...subjects, ...input.taskIds].some((id) => !ID.test(id))) {
    throw new AmuxPortfolioError("invalid_input");
  }
  // "initial" for a subject never assessed, an owner override otherwise; the
  // writer refuses either if the fact changed before the transaction.
  const priors = await prisma.amuxPortfolioAssessment.findMany({
    where: { OR: [{ nodeId: { in: subjects } }, { cardId: { in: subjects } }] },
    select: { nodeId: true, cardId: true },
  });
  const assessed = new Set(priors.flatMap((row) => [row.nodeId, row.cardId]).filter(Boolean));
  const digestKey = loadCurrentAmuxContentKeys(process.env);
  // A second in the past, so the writer's "not in the future" check holds on either clock.
  const evidenceAsOf = new Date(Date.now() - 1_000).toISOString();

  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const assessments = [];
      for (const entry of input.assessments) {
        const written = await writeAmuxPortfolioAssessmentInTx(tx, {
          session, request, digestKey, confirmationDigest: null,
          payload: { id: randomUUID(), requestId: randomUUID(), subject: entry.subject,
            metrics: entry.metrics, uncertainty: entry.uncertainty,
            evidenceRefs: entry.evidenceRefs, evidenceAsOf,
            reasonCode: assessed.has(entry.subject.id) ? "operator_override" : "initial",
            modelProposalDigest: entry.modelProposalDigest },
        });
        assessments.push({ subject: entry.subject, assessmentId: written.assessmentId,
          assessmentVersion: written.assessmentVersion });
      }
      const scores = [];
      for (const taskId of input.taskIds) {
        const written = await writeAmuxPortfolioScoreInTx(tx, {
          session, request, digestKey, confirmationDigest: null,
          payload: { id: randomUUID(), requestId: randomUUID(), taskId },
        });
        scores.push({ taskId, scoreId: written.scoreId, total: written.score.total });
      }
      callbackReturned = true;
      return { assessments, scores };
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 60_000 });
  } catch (error) {
    // A refusal inside the callback rolled the whole plan back.
    if (!callbackReturned && error instanceof AmuxPortfolioError) throw error;
    throw new AmuxV4ScorePlanError("outcome_unknown");
  }
}
