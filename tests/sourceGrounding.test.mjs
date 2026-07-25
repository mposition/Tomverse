import assert from "node:assert/strict";
import test from "node:test";
import { toSourceGrounding } from "../lib/sourceGrounding.ts";
import { verifyComparisonReviewResult } from "../lib/comparisonReview.ts";

test("an empty citation list reports no measurement instead of a zero rate", () => {
  const grounding = toSourceGrounding({
    confidence: "medium",
    groundingStats: { totalCitations: 0, verifiedCitations: 0 },
  });
  assert.equal(grounding.available, false);
  assert.equal(grounding.percent, null, "0% would read as 'nothing matched'");
  assert.equal(grounding.exactQuoteMatchRate, null);
  assert.equal(
    grounding.level,
    null,
    "the stored 'medium' default is not a measurement and must not surface"
  );
});

test("a missing groundingStats block is treated as unmeasured, not as a score", () => {
  const grounding = toSourceGrounding({ confidence: "high" });
  assert.equal(grounding.available, false);
  assert.equal(grounding.percent, null);
  assert.equal(grounding.level, null);
});

test("the stored level is passed through untouched once a rate exists", () => {
  const grounding = toSourceGrounding({
    confidence: "high",
    groundingStats: { totalCitations: 4, verifiedCitations: 4 },
  });
  assert.equal(grounding.available, true);
  assert.equal(grounding.level, "high");
  assert.equal(grounding.matchedQuotes, 4);
  assert.equal(grounding.totalQuotes, 4);
  assert.equal(grounding.exactQuoteMatchRate, 1);
  assert.equal(grounding.percent, 100);
});

test("the displayed percentage is the exact quote match rate, rounded", () => {
  const grounding = toSourceGrounding({
    confidence: "medium",
    groundingStats: { totalCitations: 5, verifiedCitations: 4 },
  });
  assert.equal(grounding.exactQuoteMatchRate, 0.8);
  assert.equal(grounding.percent, 80);
});

test("a single unmatched quote can never round up to a clean 100%", () => {
  const grounding = toSourceGrounding({
    confidence: "high",
    groundingStats: { totalCitations: 1000, verifiedCitations: 999 },
  });
  assert.equal(grounding.percent, 99);
  assert.equal(
    grounding.exactQuoteMatchRate,
    0.999,
    "only the display value is clamped; the underlying rate is untouched"
  );
});

test("a quote that did match can never round down to 0%", () => {
  const grounding = toSourceGrounding({
    confidence: "low",
    groundingStats: { totalCitations: 1000, verifiedCitations: 1 },
  });
  assert.equal(grounding.percent, 1);
});

test("counts outside the possible range are clamped instead of over-reporting", () => {
  const grounding = toSourceGrounding({
    confidence: "high",
    groundingStats: { totalCitations: 2, verifiedCitations: 9 },
  });
  assert.equal(grounding.matchedQuotes, 2);
  assert.equal(grounding.percent, 100);

  const negative = toSourceGrounding({
    confidence: "low",
    groundingStats: { totalCitations: 2, verifiedCitations: -3 },
  });
  assert.equal(negative.matchedQuotes, 0);
  assert.equal(negative.percent, 0);
});

test("relabelling the metric does not change the verifier's own numbers", () => {
  const contentByResponseId = {
    A: "The capital of France is Paris.",
    B: "Paris is the capital of France.",
  };
  const verified = verifyComparisonReviewResult(
    {
      consensus: [
        {
          text: "Both name Paris.",
          citations: [
            { responseId: "A", quote: "The capital of France is Paris." },
            { responseId: "B", quote: "this quote was never written" },
          ],
        },
      ],
      differences: [],
      contradictions: [],
      missingPoints: [],
      verificationNeeded: [],
      modelAssessments: [],
      synthesis: "",
      limitations: [],
    },
    contentByResponseId
  );

  // The verifier is the source of truth and is untouched by this change.
  assert.equal(verified.groundingStats.totalCitations, 2);
  assert.equal(verified.groundingStats.verifiedCitations, 1);
  assert.equal(verified.confidence, "low");

  // The UI layer only relabels what the verifier already produced.
  const grounding = toSourceGrounding(verified);
  assert.equal(grounding.matchedQuotes, verified.groundingStats.verifiedCitations);
  assert.equal(grounding.totalQuotes, verified.groundingStats.totalCitations);
  assert.equal(grounding.exactQuoteMatchRate, 0.5);
  assert.equal(grounding.percent, 50);
  assert.equal(grounding.level, verified.confidence);
});
