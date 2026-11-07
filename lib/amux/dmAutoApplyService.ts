import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerBodies, readDecisionMakerResultDetail } from
  "@/lib/amux/decisionMakerBodyStore";
import { closeDecisionMakerRequestOnDirectAnswer, readDecisionMakerRequestState,
  readNextDecisionMakerOpenProposal } from "@/lib/amux/decisionMakerRequestStore";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { amuxIdeaCardCloseDecisionFromAnswer } from "@/lib/amux/ideaCardCloseCore";
import { applyAmuxIdeaCardCloseDmAnswer } from "@/lib/amux/ideaCardCloseService";
import { amuxPlanRefusalDecisionOfAnswer } from "@/lib/amux/ideaSessionPlanRefusalCore";
import { applyAmuxPlanRefusalDmDecision, readOpenAmuxPlanRefusalOfCard } from
  "@/lib/amux/ideaSessionPlanRefusalService";
import { amuxDatabaseDiagnosticCode } from "@/lib/amux/readFailureCore";
import { amuxDmApproverEnabled, amuxDmProposalAutoApplicable,
  amuxV22ResultReviewDecisionFromAnswer } from "@/lib/amux/v22ResultReviewCore";
import { applyAmuxV22ResultReviewDecision } from "@/lib/amux/v22ResultReviewService";
import { applyAmuxV22DmAnswer } from "@/lib/amux/v22OwnerQuestionDmService";

/**
 * The Decision Maker as the approver (owner decision 2026-11-07: "the
 * Decision Maker replaces the operator for most of the automation"). Behind
 * `TOMVERSE_AMUX_DM_APPROVER=enabled`, default off. A DM proposal on a
 * question the app answers itself -- a v22 worker question, a refused session
 * answer, an idea card close question, a v22 result review -- is applied
 * without the operator's confirmation in Admin, with the answer source `dm`.
 *
 * What stays with a person: a proposal the DM marked irreversible, an answer
 * that is not one of the question's fixed words, and every question routed to
 * the operator in the first place (the routing term list sends money, outside
 * posts, deletion, credentials and production merges there). The kill switch
 * stops it like any DM path. After the answer applies, the request is closed
 * as answered outside the confirm path, so Admin no longer offers it.
 */

type Candidate =
  | { kind: "question"; requestId: string; cardId: string; questionRevision: number;
      questionId: string; message: string }
  | { kind: "refusal"; requestId: string; cardId: string; questionRevision: number;
      refusalId: string; ideaId: string; decision: "retry" | "stop" }
  | { kind: "card_close"; requestId: string; cardId: string; questionRevision: number;
      questionId: string; decision: "close" | "keep" }
  | { kind: "result_review"; requestId: string; cardId: string; questionRevision: number;
      reviewId: string; decision: "approve" | "retry" | "block" };

type OpenCard = { cardId: string; kind: string; id: string };

/** The open questions of the four types that have a local card, one statement. */
async function readOpenAppAnsweredCards(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<OpenCard[]>`
    SELECT "localCardId" AS "cardId", 'question' AS "kind", "id" FROM "AmuxV22TaskQuestion"
    WHERE "state" = 'open' AND "localCardId" IS NOT NULL
    UNION ALL
    SELECT "localCardId", 'refusal', "id" FROM "AmuxIdeaSessionPlanRefusal"
    WHERE "state" = 'open' AND "localCardId" IS NOT NULL
    UNION ALL
    SELECT "localCardId", 'card_close', "id" FROM "AmuxIdeaCardCloseQuestion"
    WHERE "state" = 'open' AND "handoffAt" IS NULL AND "localCardId" IS NOT NULL
    UNION ALL
    SELECT "localCardId", 'result_review', "id" FROM "AmuxV22ResultReview"
    WHERE "state" = 'open' AND "handoffAt" IS NULL AND "localCardId" IS NOT NULL
    LIMIT 100`;
}

/** The answer body a select or free-text proposal carries. */
const answerText = (detail: { outputKind: string | null; optionId: string | null },
  dmAnswer: string | undefined) =>
  detail.outputKind === "select" ? detail.optionId : dmAnswer ?? null;

/** The read step: the next open proposal the DM may decide alone, or null. */
export async function readAmuxDmAutoApplyCandidate(tx: Prisma.TransactionClient, now: Date):
  Promise<Candidate | null> {
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return null;
  const cards = await readOpenAppAnsweredCards(tx);
  const requestId = await readNextDecisionMakerOpenProposal(tx,
    [...new Set(cards.map((card) => card.cardId))]);
  if (!requestId) return null;
  const state = await readDecisionMakerRequestState(tx, requestId);
  if (!state || state.route !== "dm_proposal" || state.closing !== null ||
      state.terminal?.resultKind !== "proposal") return null;
  const card = cards.find((entry) => entry.cardId === state.binding.cardId);
  const detail = await readDecisionMakerResultDetail(tx, requestId);
  if (!card || !detail || !amuxDmProposalAutoApplicable({ resultKind: "proposal",
    outputKind: detail.outputKind, irreversible: detail.irreversible })) return null;
  let dmAnswer: string | undefined;
  for (const body of await readDecisionMakerBodies(tx, requestId))
    if (body.field === "dm_answer") dmAnswer = body.text;
  const base = { requestId, cardId: card.cardId,
    questionRevision: state.binding.questionRevision };
  const words = { judgmentKind: "confirm", outputKind: detail.outputKind,
    optionId: detail.optionId, dmAnswer };
  if (card.kind === "question") {
    const body = answerText(detail, dmAnswer);
    if (!body || !body.trim()) return null;
    const message = `[Decision Maker answer, applied for the owner without a person's confirmation, re ${card.cardId}]\n` +
      (detail.outputKind === "select" ? `Chosen option: ${body}` : body);
    return { kind: "question", ...base, questionId: card.id, message };
  }
  if (card.kind === "refusal") {
    const refusal = await readOpenAmuxPlanRefusalOfCard(tx, card.cardId, now);
    const decision = refusal ? amuxPlanRefusalDecisionOfAnswer(words) : null;
    return refusal && decision ? { kind: "refusal", ...base, refusalId: refusal.id,
      ideaId: refusal.ideaId, decision } : null;
  }
  if (card.kind === "card_close") {
    const decision = amuxIdeaCardCloseDecisionFromAnswer(words);
    return decision ? { kind: "card_close", ...base, questionId: card.id, decision } : null;
  }
  const decision = amuxV22ResultReviewDecisionFromAnswer(words);
  return decision ? { kind: "result_review", ...base, reviewId: card.id, decision } : null;
}

/**
 * One step, each part its own transaction within the DM policy's twelve
 * statements: the read; the answer in the question type's own boundary (each
 * applier takes the audit chain lock and reads the kill switch again); then
 * the request's close. A proposal that cannot be applied stays where it is,
 * for the operator's confirmation as before. A lost close leaves a request
 * whose question is no longer open, which the next read no longer finds.
 */
export async function runAmuxDmAutoApplyStep(env: Record<string, string | undefined> = process.env):
  Promise<null | { requestId: string; kind: Candidate["kind"]; applied: boolean }> {
  if (!amuxDmApproverEnabled(env)) return null;
  const candidate = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerAutoApplyRead,
    (tx, context) => readAmuxDmAutoApplyCandidate(tx, context.dbNow));
  if (!candidate) return null;
  let applied = false;
  try {
    if (candidate.kind === "question") {
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionAnswer,
        (tx, context) => applyAmuxV22DmAnswer(tx, { questionId: candidate.questionId,
          requestId: candidate.requestId, message: candidate.message, now: context.dbNow,
          source: "dm" }));
      applied = result.applied;
    } else if (candidate.kind === "refusal") {
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerPlanRefusalDecide,
        async (tx, context) => {
          await takeAuditChainLock(tx);
          if ((await readDecisionMakerSwitchesOrThrow(tx)).killSwitch !== false)
            return { applied: false as const };
          return applyAmuxPlanRefusalDmDecision(tx, { refusalId: candidate.refusalId,
            ideaId: candidate.ideaId, requestId: candidate.requestId,
            decision: candidate.decision, now: context.dbNow, source: "dm" });
        });
      applied = result.applied;
    } else if (candidate.kind === "card_close") {
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseApply,
        (tx, context) => applyAmuxIdeaCardCloseDmAnswer(tx, { questionId: candidate.questionId,
          requestId: candidate.requestId, decision: candidate.decision, now: context.dbNow,
          source: "dm" }));
      applied = result.applied;
    } else {
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22ResultReviewApply,
        (tx, context) => applyAmuxV22ResultReviewDecision(tx, { reviewId: candidate.reviewId,
          decision: candidate.decision, source: "dm", requestId: candidate.requestId,
          now: context.dbNow }));
      applied = result.applied;
    }
  } catch (error) {
    // A refused answer (the Task moved, the answer too long) rolls back and
    // stays for the operator; any other failure is logged without content.
    if (!(error instanceof BoardImportError))
      console.warn(JSON.stringify({ subsystem: "amux", event: "dm_auto_apply_failed",
        kind: candidate.kind, sqlState: amuxDatabaseDiagnosticCode(error) }));
    return { requestId: candidate.requestId, kind: candidate.kind, applied: false };
  }
  if (applied) {
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerAutoApplyClose,
      (tx) => closeDecisionMakerRequestOnDirectAnswer(tx, { cardId: candidate.cardId,
        questionRevision: candidate.questionRevision })).catch((error) => {
      console.warn(JSON.stringify({ subsystem: "amux", event: "dm_auto_apply_close_failed",
        sqlState: amuxDatabaseDiagnosticCode(error) }));
    });
  }
  return { requestId: candidate.requestId, kind: candidate.kind, applied };
}
