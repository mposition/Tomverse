import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARISON_REVIEW_ITEM_VERDICTS,
  comparisonReviewItemId,
  comparisonReviewItems,
  isKnownComparisonReviewItem,
  sectionOfItemId,
  summariseItemFeedback,
} from "../lib/comparisonReviewItemFeedback.ts";

const result = (overrides = {}) => ({
  consensus: [{ text: "Both answers give 193 km." }],
  contradictions: [
    { text: "B dates the opening to 1859 while A and C say 1869." },
    { text: "B omits the prescriber warning A gives." },
  ],
  differences: [{ issue: "Whether to adopt Kubernetes now." }],
  missingPoints: ["B never mentions a rollback path."],
  verificationNeeded: ["The 1869 opening date."],
  ...overrides,
});

test("every claim gets an id, and the sections it covers are the claim sections", () => {
  const items = comparisonReviewItems(result());
  assert.equal(items.length, 6);
  assert.deepEqual(
    [...new Set(items.map((item) => item.section))].sort(),
    ["consensus", "contradictions", "differences", "missingPoints", "verificationNeeded"]
  );
  for (const item of items) assert.equal(sectionOfItemId(item.id), item.section);
});

test("the id is stable for the same claim and different for a changed one", () => {
  const first = comparisonReviewItems(result())[0].id;
  const again = comparisonReviewItems(result())[0].id;
  assert.equal(first, again);

  // Whitespace and case are normalised, so a cosmetic reflow keeps a verdict.
  const reflowed = comparisonReviewItems(
    result({ consensus: [{ text: "  Both answers give   193 KM.  " }] })
  )[0].id;
  assert.equal(reflowed, first);

  // A changed claim gets a new id, so an old verdict stops matching rather
  // than silently re-pointing at different text.
  const changed = comparisonReviewItems(
    result({ consensus: [{ text: "Both answers give 190 km." }] })
  )[0].id;
  assert.notEqual(changed, first);
});

test("the same sentence in two sections is two different items", () => {
  const shared = "The two answers disagree.";
  const items = comparisonReviewItems(
    result({ contradictions: [{ text: shared }], missingPoints: [shared] })
  );
  const contradiction = items.find((item) => item.section === "contradictions");
  const missing = items.find((item) => item.section === "missingPoints");
  assert.notEqual(contradiction.id, missing.id);
});

test("the same sentence from the two reviewers is two different items", () => {
  const primary = comparisonReviewItems(result(), "primary")[0].id;
  const secondary = comparisonReviewItems(result(), "secondary")[0].id;
  assert.notEqual(primary, secondary);
  assert.equal(sectionOfItemId(primary), "consensus");
  assert.equal(sectionOfItemId(secondary), "consensus");
});

test("the ordinal separates two claims that read the same in one section", () => {
  const repeated = "They disagree.";
  const items = comparisonReviewItems(
    result({ contradictions: [{ text: repeated }, { text: repeated }] })
  ).filter((item) => item.section === "contradictions");
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
});

test("an id the client invented is not a known item", () => {
  const review = { primary: result(), secondary: null };
  const real = comparisonReviewItems(result(), "primary")[0].id;
  assert.equal(isKnownComparisonReviewItem(review, real), true);
  assert.equal(
    isKnownComparisonReviewItem(review, "primary:consensus:0:0000000000000000"),
    false
  );
  assert.equal(isKnownComparisonReviewItem(review, "nonsense"), false);
  // A secondary-reviewer id is unknown while there is no secondary reviewer.
  assert.equal(
    isKnownComparisonReviewItem(
      review,
      comparisonReviewItems(result(), "secondary")[0].id
    ),
    false
  );
  assert.equal(
    isKnownComparisonReviewItem(
      { primary: result(), secondary: result() },
      comparisonReviewItems(result(), "secondary")[0].id
    ),
    true
  );
});

test("the synthesis, limitations and per-model assessments are not feedback targets", () => {
  const items = comparisonReviewItems(result());
  // Nothing derived from framing the review always carries: a thumbs-down on
  // "this is not external fact verification" would be about the disclaimer.
  assert.equal(
    items.some((item) => item.section === "limitations" || item.section === "synthesis"),
    false
  );
});

test("sectionOfItemId refuses an id whose section is not a real one", () => {
  assert.equal(sectionOfItemId("primary:synthesis:0:abc"), null);
  assert.equal(sectionOfItemId("primary"), null);
});

test("the verdict vocabulary keeps the three negatives apart", () => {
  assert.deepEqual([...COMPARISON_REVIEW_ITEM_VERDICTS], [
    "helpful",
    "incorrect",
    "unclear",
    "missing_point",
  ]);
});

test("a handful of verdicts is not a rate", () => {
  const few = summariseItemFeedback([
    { verdict: "incorrect", section: "contradictions" },
    { verdict: "helpful", section: "consensus" },
  ]);
  assert.equal(few.total, 2);
  assert.equal(few.negativeRate, null);
  assert.equal(few.byVerdict.incorrect, 1);

  const enough = summariseItemFeedback(
    Array.from({ length: 20 }, (_, index) => ({
      verdict: index < 5 ? "incorrect" : "helpful",
      section: "contradictions",
    }))
  );
  assert.equal(enough.negativeRate, 0.25);
  assert.equal(enough.bySection.contradictions, 20);
});

test("an unknown verdict is counted in the total but not credited to a bucket", () => {
  const summary = summariseItemFeedback([
    { verdict: "not_a_verdict", section: "consensus" },
  ]);
  assert.equal(summary.total, 1);
  assert.equal(
    Object.values(summary.byVerdict).reduce((sum, count) => sum + count, 0),
    0
  );
});

test("the id is one string, so a section prefix cannot be spoofed into another", () => {
  // A claim whose own text starts with a section name must not produce an id
  // that reads as that section.
  const spoof = comparisonReviewItemId(
    "primary",
    "consensus",
    0,
    "contradictions: they disagree"
  );
  assert.equal(sectionOfItemId(spoof), "consensus");
});
