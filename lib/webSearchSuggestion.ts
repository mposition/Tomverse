// Pure, local heuristic for "web search: auto" mode -- decides whether the
// current draft looks like it needs current/real-world information, so
// ChatInput.tsx can show a dismissible inline suggestion. Deliberately not a
// model call: no extra cost/latency, and it's described to the user as a
// simple heuristic, not an intelligent classifier.
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

export const suggestsCurrentInformationNeeded = (draft: string): boolean => {
  const normalized = draft.trim().toLowerCase();
  if (normalized.length < 4) return false;

  const hasKeyword = RECENCY_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase())
  );
  if (hasKeyword) return true;

  if (RESEARCH_PATTERN.test(normalized)) return true;

  return RECENT_YEAR_PATTERN.test(normalized) && normalized.length <= 200;
};

// Cheap, stable key for "have we already suggested for this exact draft" --
// not cryptographic, just needs to be deterministic per trimmed input.
export const draftSuggestionKey = (draft: string): string => draft.trim().toLowerCase();
