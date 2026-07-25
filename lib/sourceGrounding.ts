// The reviewer pipeline stores this signal under the legacy field name
// `confidence` (lib/comparisonReview.ts). That name never matched what the
// value measures: the share of the reviewer's quotes that could be matched
// verbatim against the response they were attributed to -- an exact quote
// match rate, not a probability that the answer is true and not the model's
// own certainty.
//
// Renaming the stored field would invalidate every cached review row (the
// persisted result is validated on read against the schemas in
// lib/comparisonReview.ts), so the rename stops at this boundary: storage and
// the API keep `confidence`, everything from here up talks about *source
// grounding*, and this module is the only place that translates between them.

export type SourceGroundingLevel = "low" | "medium" | "high";

export type SourceGroundingStats = {
  totalCitations: number;
  verifiedCitations: number;
};

export type SourceGrounding = {
  /** False when nothing was quoted, so there is no rate to report at all. */
  available: boolean;
  /** The stored bucket, surfaced only when a rate could actually be computed. */
  level: SourceGroundingLevel | null;
  matchedQuotes: number;
  totalQuotes: number;
  /** Raw exact-quote-match rate in [0, 1]; null when nothing was quoted. */
  exactQuoteMatchRate: number | null;
  /** Rounded rate for display; null when nothing was quoted. */
  percent: number | null;
};

// Rounding is display-only -- exactQuoteMatchRate keeps the untouched value.
// The two clamps exist so the rounded number can never claim more than the
// underlying counts do: a single unmatched quote must not round up to a clean
// "100%", and a quote that did match must not disappear into "0%".
const toDisplayPercent = (matched: number, total: number) => {
  if (total <= 0) return null;
  const rounded = Math.round((matched / total) * 100);
  if (rounded >= 100 && matched < total) return 99;
  if (rounded <= 0 && matched > 0) return 1;
  return rounded;
};

export const toSourceGrounding = (input: {
  confidence?: SourceGroundingLevel | null;
  groundingStats?: Partial<SourceGroundingStats> | null;
}): SourceGrounding => {
  const rawTotal = Number(input.groundingStats?.totalCitations);
  const rawMatched = Number(input.groundingStats?.verifiedCitations);
  const totalQuotes =
    Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 0;
  const matchedQuotes = Number.isFinite(rawMatched)
    ? Math.min(Math.max(Math.floor(rawMatched), 0), totalQuotes)
    : 0;

  if (totalQuotes === 0) {
    // deriveConfidence() falls back to "medium" for an empty citation list.
    // That is a storage default, not a measurement, so it is dropped here
    // rather than shown as if the reviewer had scored anything.
    return {
      available: false,
      level: null,
      matchedQuotes: 0,
      totalQuotes: 0,
      exactQuoteMatchRate: null,
      percent: null,
    };
  }

  return {
    available: true,
    level: input.confidence ?? null,
    matchedQuotes,
    totalQuotes,
    exactQuoteMatchRate: matchedQuotes / totalQuotes,
    percent: toDisplayPercent(matchedQuotes, totalQuotes),
  };
};
