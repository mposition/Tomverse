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

test("an unchanged score's active window is extended a day before it closes, never past its baseline", async () => {
  const { amuxRefreshedActiveStaleAt, amuxScoreAutoRefreshEnabled,
    amuxScoreAuditActionBinds } = await import("../lib/amux/portfolioScoreCore.ts");
  const day = 86_400_000;
  const now = new Date("2026-11-14T02:00:00.000Z");
  const at = (days) => new Date(now.getTime() + days * day);
  // Due within the lead, or already lapsed: seven days past now.
  assert.deepEqual(amuxRefreshedActiveStaleAt({ now, activeStaleAt: at(0.5),
    baselineStaleAt: at(20) }), at(7));
  assert.deepEqual(amuxRefreshedActiveStaleAt({ now, activeStaleAt: at(-3),
    baselineStaleAt: at(20) }), at(7));
  // Capped at the evidence's 28-day baseline.
  assert.deepEqual(amuxRefreshedActiveStaleAt({ now, activeStaleAt: at(-1),
    baselineStaleAt: at(2) }), at(2));
  // Not yet due, at the cap already, or past the baseline: nothing to write.
  assert.equal(amuxRefreshedActiveStaleAt({ now, activeStaleAt: at(1.5),
    baselineStaleAt: at(20) }), null);
  assert.equal(amuxRefreshedActiveStaleAt({ now, activeStaleAt: at(0.5),
    baselineStaleAt: at(0.5) }), null);
  assert.equal(amuxRefreshedActiveStaleAt({ now, activeStaleAt: at(-9),
    baselineStaleAt: at(-1) }), null);
  assert.equal(amuxRefreshedActiveStaleAt({ now: new Date(Number.NaN),
    activeStaleAt: at(0), baselineStaleAt: at(5) }), null);
  // Default off: only the exact value turns it on.
  assert.equal(amuxScoreAutoRefreshEnabled(undefined), false);
  assert.equal(amuxScoreAutoRefreshEnabled("true"), false);
  assert.equal(amuxScoreAutoRefreshEnabled("enabled"), true);
  // A refresh binds a snapshot like a confirmation; nothing else does.
  assert.equal(amuxScoreAuditActionBinds("amux.v4.portfolio.score.confirm"), true);
  assert.equal(amuxScoreAuditActionBinds("amux.v4.portfolio.score.refresh"), true);
  assert.equal(amuxScoreAuditActionBinds("amux.v4.portfolio.assessment.approve"), false);
  assert.equal(amuxScoreAuditActionBinds(null), false);
});
