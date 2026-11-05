import type { AmuxAnalysisSchemaRejectAt } from "./ideaAnalysisChunkCore.ts";
import type { AmuxSessionReviewDetail } from "./ideaSessionReviewCore.ts";
import { AMUX_V22_PROVIDERS, amuxV22Provider } from "./v22WorkerClaimCore.ts";

/**
 * A session answer the plan check refused (owner decision 2026-11-05). Nothing
 * reruns by itself: the reason goes to the Decision Maker as a typed-ask card,
 * and a person's confirmation of its proposal, or the owner's choice in Admin,
 * decides. Everything here is built from the check's closed words, so no idea
 * text, plan text or model output reaches the card or the next prompt.
 */

export const AMUX_PLAN_REFUSAL_DECISIONS = ["retry", "stop"] as const;
export type AmuxPlanRefusalDecision = (typeof AMUX_PLAN_REFUSAL_DECISIONS)[number];

/** The lane a refusal's card is filed under: the analysis runner has no worker
 * session, and a confirmed answer never goes to a terminal. */
export const AMUX_PLAN_REFUSAL_CARD_WORKER = "session-analysis";

export type AmuxPlanRefusalReason = {
  detail: AmuxSessionReviewDetail | "chunk_unreadable";
  at?: AmuxAnalysisSchemaRejectAt;
};

const place = (at: AmuxAnalysisSchemaRejectAt | undefined): string => !at ? "" :
  [`, rule ${at.rule}`, at.field ? `, field ${at.field}` : "",
    at.unit !== undefined ? `, unit ${at.unit}` : "",
    at.kind ? ` (${at.kind})` : ""].join("");

/** The card the relay files. Its text avoids the routing term list on purpose:
 * only closed words of the check and fixed sentences. */
export function amuxPlanRefusalCard(input: { refusalId: string; ideaId: string;
  claimProvider: string; chunkIndex: number; priorRetries: number;
  reason: AmuxPlanRefusalReason }) {
  const provider = amuxV22Provider(input.claimProvider);
  if (!provider) return null;
  return {
    question_id: input.refusalId,
    worker: AMUX_PLAN_REFUSAL_CARD_WORKER,
    provider: AMUX_V22_PROVIDERS[provider].providerClass,
    title: `Session analysis answer refused, idea ${input.ideaId}`,
    question: `The plan check refused a session analysis answer on page ${
      input.chunkIndex}: ${input.reason.detail}${place(input.reason.at)}. This page has been run again ${
      input.priorRetries} time(s) so far. Another run uses the subscription and takes minutes, and its prompt carries this reason. Should the analysis run again, or stop here and leave the idea for the operator?`,
    unblocks: "The idea stays out of the analysis queue until this is decided.",
    options: [
      { id: "retry", label: "Run the analysis again with this reason in its prompt" },
      { id: "stop", label: "Stop and leave the idea for the operator" },
    ],
  };
}

/** What the next run of the page is told about the answer before it. */
export const amuxPlanRefusalPromptNote = (reason: AmuxPlanRefusalReason): string =>
  `A previous answer for this page was refused by the plan check: ${
    reason.detail}${place(reason.at)}. Answer again in full, and check that point against the rules above before you answer.`;

/** A confirmed proposal's decision: the option a select chose, or an answer
 * that is exactly one option id. Anything else is no decision, and the refusal
 * stays open for the owner in Admin. */
export function amuxPlanRefusalDecisionOfAnswer(input: {
  judgmentKind: string; optionId: string | null;
  outputKind: string | null; dmAnswer?: string; operatorAnswer?: string;
}): AmuxPlanRefusalDecision | null {
  const answer = input.judgmentKind === "edit_confirm" ? input.operatorAnswer :
    input.outputKind === "select" ? input.optionId : input.dmAnswer;
  const word = answer?.trim().toLowerCase();
  return AMUX_PLAN_REFUSAL_DECISIONS.find((decision) => decision === word) ?? null;
}
