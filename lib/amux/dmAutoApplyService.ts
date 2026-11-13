import "server-only";

import type { Prisma } from "@prisma/client";

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
import { amuxDmOwnerSettlementAnswerOf, type AmuxDmOwnerSettlementAnswer,
  type AmuxDmOwnerSettlementKind } from "@/lib/amux/dmOwnerSettlementCore";
import { fileAmuxDmOwnerSettlementRemakeIdea } from "@/lib/amux/dmOwnerSettlementRemake";
import { applyAmuxDmOwnerSettlementDecision } from "@/lib/amux/dmOwnerSettlementService";

/**
 * The Decision Maker as the approver (owner decision 2026-11-07: "the
 * Decision Maker replaces the operator for most of the automation"). Behind
 * `TOMVERSE_AMUX_DM_APPROVER=enabled`, default off. A DM proposal on a
 * question the app answers itself -- a v22 worker question, a refused session
 * answer, an idea card close question, a v22 result review, an owner queue
 * settlement (owner decision 2026-11-13) -- is applied without the operator's
 * confirmation in Admin, with the answer source `dm`.
 *
 * What stays with a person: a proposal the DM marked irreversible, an answer
 * that is not one of the question's fixed words, and every question routed to
 * the operator in the first place (the routing term list sends money, outside
 * posts, deletion, credentials and production merges there). The kill switch
 * stops it like any DM path. The request is closed as answered outside the
 * confirm path before the answer applies, so Admin no longer offers it and a
 * person's judgment that came first wins.
 */

type Candidate =
  | { kind: "question"; requestId: string; cardId: string; questionRevision: number;
      questionId: string; message: string }
  | { kind: "refusal"; requestId: string; cardId: string; questionRevision: number;
      refusalId: string; ideaId: string; decision: "retry" | "stop" }
  | { kind: "card_close"; requestId: string; cardId: string; questionRevision: number;
      questionId: string; decision: "close" | "keep" }
  | { kind: "result_review"; requestId: string; cardId: string; questionRevision: number;
      reviewId: string; decision: "approve" | "retry" | "block" }
  | { kind: "owner_settlement"; requestId: string; cardId: string; questionRevision: number;
      settlementId: string; answer: AmuxDmOwnerSettlementAnswer };

type OpenCard = { cardId: string; kind: string; id: string };

/** The open questions of the five types that have a local card, one statement.
 * A settlement's kind rides in its own: `settlement_stopped`, `settlement_t2_pr`. */
async function readOpenAppAnsweredCards(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<OpenCard[]>`
    SELECT * FROM (
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
    UNION ALL
    SELECT "localCardId", 'settlement_' || "kind", "id" FROM "AmuxDmOwnerSettlement"
    WHERE "state" = 'open' AND "handoffAt" IS NULL AND "localCardId" IS NOT NULL
    ) AS open_cards
    -- A random hundred each tick: cards whose proposals cannot be applied
    -- never keep the others out of the sample for good.
    ORDER BY random()
    LIMIT 100`;
}

/** The answer body a select or free-text proposal carries. */
const answerText = (detail: { outputKind: string | null; optionId: string | null },
  dmAnswer: string | undefined) =>
  detail.outputKind === "select" ? detail.optionId : dmAnswer ?? null;

/** The read step: an open proposal the DM may decide alone, or null (also when
 * the one picked this tick is not one it may apply). */
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
    // Only one of the options the worker offered: the routing has already
    // checked those words; a free-text answer goes into the next prompt
    // unchecked, so it stays for the operator's confirmation.
    const body = detail.outputKind === "select" ? answerText(detail, dmAnswer) : null;
    if (!body || !body.trim()) return null;
    const message = `[Decision Maker answer, applied for the owner without a person's confirmation, re ${card.cardId}]\n` +
      `Chosen option: ${body}`;
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
  if (card.kind === "settlement_stopped" || card.kind === "settlement_t2_pr") {
    const kind = card.kind.slice("settlement_".length) as AmuxDmOwnerSettlementKind;
    const answer = amuxDmOwnerSettlementAnswerOf({ kind, ...words });
    return answer ? { kind: "owner_settlement", ...base, settlementId: card.id, answer } : null;
  }
  const decision = amuxV22ResultReviewDecisionFromAnswer(words);
  return decision ? { kind: "result_review", ...base, reviewId: card.id, decision } : null;
}

/** Thrown inside the one transaction to roll the claim back with the answer. */
class AmuxDmAutoApplyHeld extends Error {}

/**
 * One step: the read, then ONE transaction that claims the request and
 * applies the answer. The claim (the direct-answer close) takes the audit
 * chain lock and is refused when the request is no longer open, so a person's
 * judgment that came first wins. The answer applies in the same transaction;
 * when it cannot (the kill switch, the question no longer open, a refused
 * answer) or anything fails, both roll back and the proposal stays open for
 * the operator. Its statement ceiling is the close's and the applier's
 * together (docs/policy/amux-decision-maker.md §0a).
 */
export async function runAmuxDmAutoApplyStep(env: Record<string, string | undefined> = process.env):
  Promise<null | { requestId: string; kind: Candidate["kind"]; applied: boolean }> {
  if (!amuxDmApproverEnabled(env)) return null;
  const candidate = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerAutoApplyRead,
    (tx, context) => readAmuxDmAutoApplyCandidate(tx, context.dbNow));
  if (!candidate) return null;
  const result = { requestId: candidate.requestId, kind: candidate.kind };
  // A remake's idea is filed before the claim: a closed card always has its
  // idea, and an outcome nobody knows waits for the next tick's read-back.
  const remake = candidate.kind === "owner_settlement" && candidate.answer.decision === "remake" ?
    await fileAmuxDmOwnerSettlementRemakeIdea({ settlementId: candidate.settlementId,
      ideaText: candidate.answer.ideaText }).catch(() => ({ pending: true as const })) : undefined;
  if (remake && "pending" in remake) return { ...result, applied: false };
  try {
    const applied = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerAutoApply,
      async (tx, context) => {
        const claimed = await closeDecisionMakerRequestOnDirectAnswer(tx,
          { cardId: candidate.cardId, questionRevision: candidate.questionRevision });
        if (!claimed.recorded) return false;
        const now = context.dbNow;
        let effect: boolean;
        if (candidate.kind === "question") {
          effect = (await applyAmuxV22DmAnswer(tx, { questionId: candidate.questionId,
            requestId: candidate.requestId, message: candidate.message, now, source: "dm" })).applied;
        } else if (candidate.kind === "refusal") {
          effect = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch === false &&
            (await applyAmuxPlanRefusalDmDecision(tx, { refusalId: candidate.refusalId,
              ideaId: candidate.ideaId, requestId: candidate.requestId,
              decision: candidate.decision, now, source: "dm" })).applied;
        } else if (candidate.kind === "card_close") {
          effect = (await applyAmuxIdeaCardCloseDmAnswer(tx, { questionId: candidate.questionId,
            requestId: candidate.requestId, decision: candidate.decision, now,
            source: "dm" })).applied;
        } else if (candidate.kind === "owner_settlement") {
          const settled = await applyAmuxDmOwnerSettlementDecision(tx, {
            settlementId: candidate.settlementId, answer: candidate.answer, source: "dm",
            requestId: candidate.requestId, now, remake });
          // As a result review: a moved Task or a hand-off is kept with the
          // request closed; only the kill switch (no outcome) rolls back.
          if (settled.outcome === null) throw new AmuxDmAutoApplyHeld();
          return settled.applied && settled.outcome !== "cancelled";
        } else {
          const review = await applyAmuxV22ResultReviewDecision(tx, { reviewId: candidate.reviewId,
            decision: candidate.decision, source: "dm", requestId: candidate.requestId, now });
          // A Task that moved on cancels the review, and a result nobody can
          // read goes to the person: both are kept, with the request closed;
          // only the kill switch (no outcome) rolls back.
          if (review.outcome === null) throw new AmuxDmAutoApplyHeld();
          return review.applied && review.outcome !== "cancelled";
        }
        if (!effect) throw new AmuxDmAutoApplyHeld();
        return true;
      });
    return { ...result, applied };
  } catch (error) {
    // Held, or a refused answer (the Task moved, the answer too long): rolled
    // back, open for the operator. Any other failure is logged without content.
    if (!(error instanceof AmuxDmAutoApplyHeld) && !(error instanceof BoardImportError))
      console.warn(JSON.stringify({ subsystem: "amux", event: "dm_auto_apply_failed",
        kind: candidate.kind, sqlState: amuxDatabaseDiagnosticCode(error) }));
    return { ...result, applied: false };
  }
}
