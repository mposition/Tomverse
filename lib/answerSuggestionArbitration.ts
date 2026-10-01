/**
 * Which of the two post-answer offers a finished turn is allowed to show.
 *
 * ## The defect this exists for
 *
 * `lib/webSearchRetrySuggestion.ts` and `lib/deepResearchSuggestion.ts` each
 * decide their own offer, and both shells rendered the two results as two
 * independent `if`s. Both modules -- and the comment above the render site --
 * asserted the two could never be on screen together. Nothing enforced it, and
 * the assertion did not follow from the rules:
 *
 *   "recency alone is the only thing this needs and the one thing that module
 *    will not act on alone"
 *
 * Needing *only* recency is not the same as firing *only* on recency. The web
 * search offer fires whenever the turn needs current information, however many
 * other signals also fired; the Deep Research offer refuses recency *alone* but
 * accepts recency plus any depth signal. A question carrying both therefore
 * satisfies both, and "2026년 전고체 배터리 시장의 최신 자료를 비교해서
 * 정리해줘" is exactly that shape -- `recency` from "최신" and the year,
 * `multi_source_comparison` from "비교" -- so it drew two cards, two prices and
 * two dismiss buttons for one goal.
 *
 * ## The rule
 *
 * Deep Research wins. That is what the render-site comment already said the
 * product wanted ("A question with both goes to Deep Research, which is the
 * deeper of the two answers"), and it is the safe direction on cost as well:
 * the offer that wins is the one whose card states its own price and time, and
 * the person can still ask for the cheaper thing by turning the switch on
 * themselves.
 *
 * ## Why the failure states survive it
 *
 * A card in `error` or `blocked` after a re-run *this page started* is not an
 * offer -- it is the outcome of a button the person already pressed, and
 * swallowing it would leave them with no account of what happened to their
 * request. That is reachable rather than theoretical: a Deep Research job that
 * is still running refuses the expansion offer with `deep_research_in_progress`,
 * so the web search card is shown and can be pressed; when the job finishes the
 * expansion becomes offerable, and unconditional suppression would take the
 * failed re-run's report off screen at that moment.
 *
 * So the caller passes the same `retryFailure` it passes to
 * `deriveWebSearchSuggestion`, and a turn carrying one is never suppressed.
 *
 * ## Why it is here and not in either module
 *
 * Neither module can answer this question without importing the other's rules,
 * and folding one into the other would put a presentation decision inside a
 * classifier whose signals are recorded against analytics identifiers. This
 * gates nothing, prices nothing and decides nothing about what a request may
 * do: it chooses which of two already-decided offers is drawn.
 *
 * It also stays out of `lib/webSearchRetrySuggestion.ts`'s own refusal union.
 * The suppression is not a reading of the question -- that module read it and
 * said yes -- so the reason for it belongs with the rule that produced it.
 *
 * ## Where the caller must apply it
 *
 * Before the impression bookkeeping, never only at the render site. Being shown
 * the card is what writes `offeredTopics`, and a card that was suppressed was
 * not shown: recording it would refuse the offer on a later turn for a question
 * nobody was ever asked about.
 *
 * Pure and synchronous. No database, no clock, no I/O.
 */

import type { DeepResearchSuggestion } from "@/lib/deepResearchSuggestion";
import type {
  WebSearchRetryFailure,
  WebSearchSuggestion,
  WebSearchSuggestionRefusal,
} from "@/lib/webSearchRetrySuggestion";

/** The web search offer was fit for this turn, and Deep Research outranked it. */
export const WEB_SEARCH_SUPERSEDED_BY_DEEP_RESEARCH =
  "superseded_by_deep_research" as const;

export type ArbitratedWebSearchRefusal =
  | WebSearchSuggestionRefusal
  | typeof WEB_SEARCH_SUPERSEDED_BY_DEEP_RESEARCH;

/**
 * The same shape `deriveWebSearchSuggestion` returns, with one more reason it
 * can carry. Widened here rather than in that module so its refusal union keeps
 * meaning "what this classifier concluded about the question".
 */
export type ArbitratedWebSearchSuggestion = Omit<
  WebSearchSuggestion,
  "refusal"
> & {
  refusal: ArbitratedWebSearchRefusal | null;
};

export type AnswerSuggestionArbitrationInput = {
  webSearch: WebSearchSuggestion;
  deepResearch: DeepResearchSuggestion;
  /**
   * How a re-run this page started ended, or null. The same value the caller
   * passes to `deriveWebSearchSuggestion` -- see the note above on why a turn
   * carrying one is never suppressed.
   */
  retryFailure: WebSearchRetryFailure | null;
};

/**
 * The single decision both shells read.
 *
 * Deep Research is returned untouched by construction: it is the offer that
 * wins, so there is no branch in which this function alters it, and the
 * signature says so by not returning it.
 */
export const arbitrateWebSearchOffer = (
  input: AnswerSuggestionArbitrationInput
): ArbitratedWebSearchSuggestion => {
  if (!input.webSearch.offered) return input.webSearch;
  if (!input.deepResearch.offered) return input.webSearch;
  if (input.retryFailure) return input.webSearch;

  return {
    offered: false,
    state: null,
    refusal: WEB_SEARCH_SUPERSEDED_BY_DEEP_RESEARCH,
    promptId: null,
    text: null,
    topicKey: null,
    signals: [],
  };
};
