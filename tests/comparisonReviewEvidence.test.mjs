import test from "node:test";
import assert from "node:assert/strict";
import { reviewEvidenceItems, reviewQuoteRange } from "../lib/comparisonReviewEvidence.ts";

test("evidence navigation preserves reviewer sections, ordinals and unverified quotations", () => {
  const result = { contradictions: [{ text: "different dates", citations: [{ responseId: "B", quote: "three weeks", verified: false }] }], differences: [{ issue: "timing", positions: [{ responseId: "A", position: "soon", quote: "two weeks", verified: true }] }], consensus: [], missingPoints: ["deadline"], verificationNeeded: ["check date"] };
  const items = reviewEvidenceItems(result);
  assert.deepEqual(items.map(({id}) => id), ["contradictions:0", "differences:0", "missingPoints:0", "verificationNeeded:0"]);
  assert.equal(items[0].citations[0].verified, false);
  assert.equal(items[1].citations[0].responseId, "A");
  assert.deepEqual(items[2].citations, []);
});

test("source highlighting never substitutes a synonym, a different answer or an empty quote", () => {
  assert.deepEqual(reviewQuoteRange("It takes two weeks to ship.", "two weeks"), {start: 9, end: 18});
  assert.equal(reviewQuoteRange("It takes two weeks.", "14 days"), null);
  assert.equal(reviewQuoteRange("It takes two weeks.", "three weeks"), null);
  assert.equal(reviewQuoteRange("Anything", ""), null);
  assert.equal(reviewQuoteRange("Anything", "   "), null);
});
