// Pure, local heuristics for "does this turn want the web?" -- deliberately not
// a model call: no extra cost or latency, and they are described to the user as
// simple heuristics, not an intelligent classifier.
//
// Two questions, two functions, and they are not the same question.
//
// `hasExplicitSourceOrSearchIntent` asks whether the person *said* they want
// sources, citations or a search. It has no length floor, because "출처" is a
// complete request and its length says nothing about how sure we are.
//
// `suggestsWebSearchInComposer` asks whether ChatInput should offer an inline
// "use web search" nudge while somebody is still typing. It folds the explicit
// intent together with softer recency wording, and it ignores drafts shorter
// than four characters -- a suggestion that appears after two keystrokes is
// noise, and a nudge that is wrong costs the user a glance.
//
// They were one function, and the routing path reused it. That put a
// typing-time floor -- an anti-nagging rule -- inside a safety boundary: the
// task profile's `needsCurrentInformation` drives the Router's web-search hard
// filter, so a two-character request for sources produced `false`, the filter
// never ran, and a model with no search path stayed eligible for a turn that
// had asked for sources. Splitting them is what keeps a UI comfort rule out of
// a capability decision. Whether a *selected* model then really searches is a
// separate check again, at dispatch: see
// `docs/policy/tomverse-chat-router-score-policy.md` §8.
import { RESEARCH_PATTERN } from "@/lib/modelFinder";

const RECENCY_KEYWORDS = [
  // Korean
  "오늘", "어제", "최신", "현재", "지금", "이번 주", "이번주", "이번 달", "이번달",
  "요즘", "실시간", "속보", "최근", "환율", "주가", "시세", "날씨",
  // English
  "today", "yesterday", "latest", "current", "currently", "this week",
  "this month", "right now", "recent", "recently", "breaking", "live",
  "exchange rate", "stock price", "weather forecast", "news",
];

// A bare year (e.g. "2026") is only a signal alongside other context --
// matched separately so it never fires alone on something like "iPhone 15".
const RECENT_YEAR_PATTERN = /\b20(2[4-9]|3[0-9])\b/;

/**
 * The person asked for sources, citations, research or a web search.
 *
 * No length floor and no upper bound: this is a statement of intent, not a
 * guess from context, so its strength does not depend on how much else was
 * typed. Used for routing and capability decisions, where treating a short
 * request as no request is a safety hole rather than a quiet UI.
 */
export const hasExplicitSourceOrSearchIntent = (text: string): boolean =>
  RESEARCH_PATTERN.test(text.trim());

/**
 * Softer wording that only *suggests* the answer needs to be fresh.
 *
 * Keeps its floor wherever it is used, including on the routing path. A bare
 * "오늘" is ambiguous in a way "출처" is not -- it is a guess about what the
 * turn needs rather than something the person asked for -- so it stays a
 * suggestion, and widening it is a separate decision with its own evidence.
 */
export const suggestsRecentInformationNeeded = (text: string): boolean => {
  const normalized = text.trim().toLowerCase();
  if (normalized.length < 4) return false;

  const hasKeyword = RECENCY_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase())
  );
  if (hasKeyword) return true;

  return RECENT_YEAR_PATTERN.test(normalized) && normalized.length <= 200;
};

/**
 * Whether the composer should offer its inline "use web search" nudge.
 *
 * Both signals, and the floor applies to both here: while somebody is typing,
 * even an explicit two-character request is more likely to be the start of a
 * longer word than a finished instruction, and the cost of guessing early is a
 * suggestion that flickers in and out under the cursor.
 */
export const suggestsWebSearchInComposer = (draft: string): boolean => {
  const normalized = draft.trim();
  if (normalized.length < 4) return false;
  return (
    suggestsRecentInformationNeeded(normalized) ||
    hasExplicitSourceOrSearchIntent(normalized)
  );
};

// Cheap, stable key for "have we already suggested for this exact draft" --
// not cryptographic, just needs to be deterministic per trimmed input.
export const draftSuggestionKey = (draft: string): string => draft.trim().toLowerCase();
