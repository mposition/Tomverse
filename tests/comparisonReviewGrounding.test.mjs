import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateComparisonReviewTokens,
  verifyComparisonReviewResult,
  verifyQuickComparisonSummaryResult,
} from "../lib/comparisonReview.ts";

const contentByResponseId = {
  A: "The capital of France is Paris. It has a population of about 2 million people.",
  B: "Paris is the capital of France, and it's known for the Eiffel Tower.",
};

const baseFullResult = (overrides = {}) => ({
  consensus: [],
  differences: [],
  contradictions: [],
  missingPoints: [],
  verificationNeeded: [],
  modelAssessments: [
    { responseId: "A", strengths: [], cautions: [] },
    { responseId: "B", strengths: [], cautions: [] },
  ],
  synthesis: "",
  limitations: [],
  ...overrides,
});

test("verified citations are marked verified when the quote appears verbatim in the source", () => {
  const verified = verifyComparisonReviewResult(
    baseFullResult({
      consensus: [
        {
          text: "Both responses agree Paris is the capital of France.",
          citations: [
            { responseId: "A", quote: "The capital of France is Paris." },
            { responseId: "B", quote: "Paris is the capital of France" },
          ],
        },
      ],
    }),
    contentByResponseId
  );
  assert.equal(verified.consensus[0].verified, true);
  assert.equal(verified.consensus[0].citations[0].verified, true);
  assert.equal(verified.consensus[0].citations[1].verified, true);
  assert.equal(verified.groundingStats.totalCitations, 2);
  assert.equal(verified.groundingStats.verifiedCitations, 2);
  assert.equal(verified.confidence, "high");
});

test("a fabricated quote that doesn't appear in the source is flagged unverified, not dropped", () => {
  const verified = verifyComparisonReviewResult(
    baseFullResult({
      consensus: [
        {
          text: "Both responses claim the Eiffel Tower is the tallest building in the world.",
          citations: [{ responseId: "B", quote: "tallest building in the world" }],
        },
      ],
    }),
    contentByResponseId
  );
  assert.equal(verified.consensus.length, 1, "the claim itself is kept, not dropped");
  assert.equal(verified.consensus[0].verified, false);
  assert.equal(verified.consensus[0].citations[0].verified, false);
  assert.equal(verified.confidence, "low");
});

test("quote matching tolerates whitespace and smart-quote differences but still requires the same wording", () => {
  const content = {
    A: "This is a “smart quoted”   sentence   with   extra spacing.",
  };
  const verified = verifyComparisonReviewResult(
    baseFullResult({
      consensus: [
        {
          text: "x",
          citations: [
            { responseId: "A", quote: 'a "smart quoted" sentence with extra spacing' },
          ],
        },
      ],
      modelAssessments: [{ responseId: "A", strengths: [], cautions: [] }],
    }),
    content
  );
  assert.equal(verified.consensus[0].citations[0].verified, true);
});

test("differences positions are verified independently and unverified ones still appear", () => {
  const verified = verifyComparisonReviewResult(
    baseFullResult({
      differences: [
        {
          issue: "population estimate",
          positions: [
            { responseId: "A", position: "about 2 million", quote: "about 2 million people" },
            { responseId: "B", position: "not mentioned", quote: "definitely ten million" },
          ],
        },
      ],
    }),
    contentByResponseId
  );
  assert.equal(verified.differences[0].positions[0].verified, true);
  assert.equal(verified.differences[0].positions[1].verified, false);
  assert.equal(verified.differences[0].positions.length, 2, "unverified position is kept, not dropped");
  assert.equal(verified.groundingStats.totalCitations, 2);
  assert.equal(verified.groundingStats.verifiedCitations, 1);
  assert.equal(verified.confidence, "low");
});

test("confidence is medium when a result has no citations at all", () => {
  const verified = verifyComparisonReviewResult(baseFullResult({ modelAssessments: [] }), {});
  assert.equal(verified.groundingStats.totalCitations, 0);
  assert.equal(verified.confidence, "medium");
});

test("quick summary claims are verified against the correct per-response source text", () => {
  const verified = verifyQuickComparisonSummaryResult(
    {
      commonConclusions: [],
      importantDifferences: [],
      modelKeyClaims: [
        {
          responseId: "A",
          claims: [{ claim: "Paris is the capital", quote: "The capital of France is Paris" }],
        },
        {
          responseId: "B",
          claims: [{ claim: "fabricated claim", quote: "this text does not exist anywhere" }],
        },
      ],
      verificationNeeded: [],
    },
    contentByResponseId
  );
  assert.equal(verified.modelKeyClaims[0].claims[0].verified, true);
  assert.equal(verified.modelKeyClaims[1].claims[0].verified, false);
  assert.equal(verified.confidence, "low");
});

test("CJK input is estimated at roughly 1.5 tokens per character instead of bytes/4", () => {
  const koreanText = "가".repeat(10_000);
  const tokens = estimateComparisonReviewTokens("", [
    { messageId: "a", modelId: "m", modelName: "M", provider: "openai", content: koreanText },
  ]);
  // A naive utf8-bytes/4 estimate would land around 7,500 + 1,200 reserve;
  // the CJK-aware estimate should be well above that (close to 15,000+1,200).
  assert.ok(tokens >= 15_000, `expected >= 15000, got ${tokens}`);
});

test("English input still estimates close to the bytes/4 heuristic", () => {
  const englishText = "word ".repeat(1_000);
  const tokens = estimateComparisonReviewTokens("", [
    { messageId: "a", modelId: "m", modelName: "M", provider: "openai", content: englishText },
  ]);
  assert.ok(tokens < 3_000, `expected a modest estimate for plain ASCII text, got ${tokens}`);
});
