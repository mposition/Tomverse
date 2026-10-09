import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_PORTFOLIO_SCORE_VERSION, scoreAmuxPortfolio } from
  "../lib/amux/portfolioScoreCore.ts";

const confirmedAt = new Date("2026-10-01T00:00:00.000Z");
const input = {
  initiativeValue: 5, epicValue: 4, featureValue: 3,
  storyImpact: 4, taskContribution: 5, urgency: 3,
  dependencyUnlock: 2, workerCoverage: 3,
  effort: 2, deliveryRisk: 1, uncertainty: "medium",
  evidenceConfirmedAt: confirmedAt,
};

test("versioned score uses hierarchy and task facts, without touching priority or status", () => {
  const score = scoreAmuxPortfolio(input, new Date("2026-10-02T00:00:00.000Z"));
  assert.equal(score.version, AMUX_PORTFOLIO_SCORE_VERSION);
  assert.equal(score.total, 67);
  assert.equal(score.components.initiative, 20);
  assert.equal(score.components.task, 20);
  assert.deepEqual(Object.keys(score).includes("status"), false);
  assert.deepEqual(Object.keys(score).includes("sev1"), false);
  assert.deepEqual(Object.keys(score).includes("promotionEligibleFromScore"), false);
});

test("Feature-direct Task reallocates Story weight without fabricating a Story", () => {
  const score = scoreAmuxPortfolio({ ...input, storyImpact: null },
    new Date("2026-10-02T00:00:00.000Z"));
  assert.equal(score.components.story, 0);
  assert.equal(score.components.task, 30);
  assert.equal(score.total, 69);
});

test("recalculation never refreshes evidence and active/baseline windows differ", () => {
  const atSeven = scoreAmuxPortfolio(input,
    new Date("2026-10-08T00:00:00.000Z"));
  assert.equal(atSeven.activeFresh, false);
  assert.equal(atSeven.baselineFresh, true);
  assert.equal(atSeven.evidenceConfirmedAt, confirmedAt.toISOString());
  const atTwentyEight = scoreAmuxPortfolio(input,
    new Date("2026-10-29T00:00:00.000Z"));
  assert.equal(atTwentyEight.baselineFresh, false);
});

test("invalid or future evidence fails closed", () => {
  assert.throws(() => scoreAmuxPortfolio({ ...input, urgency: 9 },
    new Date("2026-10-02T00:00:00.000Z")), /invalid_portfolio_score_input/);
  assert.throws(() => scoreAmuxPortfolio(input,
    new Date("2026-09-30T00:00:00.000Z")), /invalid_portfolio_score_input/);
});
