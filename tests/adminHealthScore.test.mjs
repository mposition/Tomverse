// The Overview health score, taken apart.
//
// The score was six weighted counts collapsed into one integer with no test
// and no way to see the arithmetic. Two properties are pinned here because
// getting either wrong tells an operator something untrue:
//
//  - an input that could not be read deducts nothing AND says so, rather than
//    counting as zero and quietly improving the score;
//  - once deductions pass 100 the number stops moving, so the breakdown has to
//    admit it instead of letting a flat zero read as a stable reading.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_HEALTH_FACTOR_ORDER,
  ADMIN_HEALTH_WEIGHTS,
  adminHealthBreakdown,
  adminHealthScore,
} from "../lib/adminHealthScore.ts";

const clean = {
  outageCount: 0,
  limitedCount: 0,
  blockingEnvCount: 0,
  alertFailureCount: 0,
  pendingRefundCount: 0,
  openFeedbackCount: 0,
};

test("the weights are the ones the console has always used", () => {
  // Pinned, not because the numbers are sacred but because they were never
  // written down anywhere else and a silent change would move every reading.
  assert.deepEqual(ADMIN_HEALTH_WEIGHTS, {
    outage: 18,
    limited: 8,
    blockingEnv: 10,
    alertFailure: 4,
    pendingRefund: 3,
    openFeedback: 2,
  });
});

test("every weighted factor is rendered, dearest first", () => {
  assert.deepEqual(
    [...ADMIN_HEALTH_FACTOR_ORDER].sort(),
    Object.keys(ADMIN_HEALTH_WEIGHTS).sort()
  );
  const weights = ADMIN_HEALTH_FACTOR_ORDER.map(
    (factor) => ADMIN_HEALTH_WEIGHTS[factor]
  );
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
});

test("a clean deployment scores 100 and deducts nothing", () => {
  const breakdown = adminHealthBreakdown(clean);
  assert.equal(breakdown.score, 100);
  assert.equal(breakdown.totalDeduction, 0);
  assert.equal(breakdown.floored, false);
  assert.equal(breakdown.incomplete, false);
  assert.deepEqual(breakdown.unknownFactors, []);
});

test("each line multiplies its own count by its own weight", () => {
  const breakdown = adminHealthBreakdown({
    ...clean,
    outageCount: 2,
    openFeedbackCount: 3,
  });
  const line = (factor) =>
    breakdown.lines.find((entry) => entry.factor === factor);

  assert.equal(line("outage").deduction, 36);
  assert.equal(line("openFeedback").deduction, 6);
  assert.equal(line("limited").deduction, 0);
  assert.equal(breakdown.totalDeduction, 42);
  assert.equal(breakdown.score, 58);
});

test("the single number and the breakdown cannot disagree", () => {
  const input = { ...clean, limitedCount: 2, pendingRefundCount: 5 };
  assert.equal(adminHealthScore(input), adminHealthBreakdown(input).score);
});

test("an unreadable count deducts nothing and is named as unknown", () => {
  // The rule lib/adminNavigationCounts.ts already states for badges: zero is a
  // claim and an unknown count is not. A failed read that silently scored zero
  // would make a broken monitor look like a healthy platform.
  const breakdown = adminHealthBreakdown({
    ...clean,
    outageCount: null,
    alertFailureCount: null,
    pendingRefundCount: 4,
  });

  const outage = breakdown.lines.find((line) => line.factor === "outage");
  assert.equal(outage.count, null);
  assert.equal(outage.deduction, 0);
  assert.equal(outage.known, false);

  assert.equal(breakdown.incomplete, true);
  assert.deepEqual(breakdown.unknownFactors, ["outage", "alertFailure"]);
  // Only the readable count moved the score.
  assert.equal(breakdown.totalDeduction, 12);
  assert.equal(breakdown.score, 88);
});

test("a score built only from readable inputs is reported as a ceiling", () => {
  const partial = adminHealthBreakdown({ ...clean, outageCount: null });
  assert.equal(partial.score, 100);
  // 100 with an unread input is not the same claim as 100 with all of them.
  assert.equal(partial.incomplete, true);
});

test("past 100 points of deductions the score stops being a signal, and says so", () => {
  const breakdown = adminHealthBreakdown({
    ...clean,
    outageCount: 6, // 108 on its own
  });
  assert.equal(breakdown.totalDeduction, 108);
  assert.equal(breakdown.score, 0);
  assert.equal(breakdown.floored, true);

  // The point of the flag: a seventh outage changes the number not at all.
  const worse = adminHealthBreakdown({ ...clean, outageCount: 7 });
  assert.equal(worse.score, breakdown.score);
  assert.ok(worse.totalDeduction > breakdown.totalDeduction);
});

test("exactly 100 points of deductions is zero but not floored", () => {
  const breakdown = adminHealthBreakdown({ ...clean, blockingEnvCount: 10 });
  assert.equal(breakdown.totalDeduction, 100);
  assert.equal(breakdown.score, 0);
  assert.equal(breakdown.floored, false);
});

test("a nonsense count cannot push the score above 100 or below 0", () => {
  const negative = adminHealthBreakdown({ ...clean, outageCount: -5 });
  assert.equal(negative.score, 100);
  assert.equal(negative.totalDeduction, 0);

  const fractional = adminHealthBreakdown({ ...clean, openFeedbackCount: 2.7 });
  assert.equal(fractional.lines.find((l) => l.factor === "openFeedback").count, 2);

  const notANumber = adminHealthBreakdown({ ...clean, limitedCount: Number.NaN });
  assert.equal(notANumber.incomplete, true);
  assert.equal(notANumber.score, 100);
});
