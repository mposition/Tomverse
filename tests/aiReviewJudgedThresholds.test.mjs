import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyJudgedThresholdDraft,
  judgedThresholdProblems,
} from "../lib/aiReviewJudgedThresholds.ts";

export const signedThresholds = () => {
  const draft = emptyJudgedThresholdDraft();
  for (const key of Object.keys(draft.minWilsonLower))
    draft.minWilsonLower[key] = 0.5;
  for (const key of Object.keys(draft.maxWilsonUpper))
    draft.maxWilsonUpper[key] = 0.2;
  return {
    ...draft,
    version: "synthetic-judged",
    approvedBy: "TEST ONLY",
    approvedAt: "2026-10-01T00:00:00Z",
    minBlindReviewedCases: 1,
    maxLanguageArmGap: 0.2,
    maxTaskTypeArmShortfall: 0.1,
    negativeSubset: { policy: "diagnostic" },
  };
};
test("judged thresholds start without inherited bounds or approval", () => {
  const value = emptyJudgedThresholdDraft();
  assert.equal(value.maxWilsonUpper.missedEveryPlantedIssueRate, null);
  assert.equal(value.maxLanguageArmGap, null);
  assert.match(judgedThresholdProblems(value).join("\n"), /unsigned/);
  assert.ok(judgedThresholdProblems(value, false).length);
});
test("a complete unsigned draft is editable but cannot pass the approval gate", () => {
  const value = { ...signedThresholds(), approvedAt: null, approvedBy: null };
  assert.deepEqual(judgedThresholdProblems(value, false), []);
  assert.match(judgedThresholdProblems(value).join("\n"), /unsigned/);
  assert.deepEqual(judgedThresholdProblems(signedThresholds()), []);
});
test("legacy ceilings, invalid numbers and missing subset decisions are refused", () => {
  const good = signedThresholds();
  assert.ok(
    judgedThresholdProblems({
      ...good,
      maxWilsonUpper: { falseConsensusRate: 0.1, inventedIssueRate: 0.1 },
    }).length,
  );
  for (const value of [NaN, Infinity, -1, 2, "0.1"])
    assert.ok(
      judgedThresholdProblems({ ...good, maxLanguageArmGap: value }).length,
    );
  assert.ok(
    judgedThresholdProblems({
      ...good,
      negativeSubset: { policy: "gate", maxWilsonUpper: null },
    }).length,
  );
  assert.ok(
    judgedThresholdProblems({ ...good, approvedAt: "not-a-time" }).length,
  );
});
