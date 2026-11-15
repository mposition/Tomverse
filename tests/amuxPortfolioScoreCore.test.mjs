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
  // The legacy-limits switch keeps the 2026-11-14 rule: off unless exactly
  // "enabled".
  assert.equal(amuxScoreAutoRefreshEnabled(undefined, true), false);
  assert.equal(amuxScoreAutoRefreshEnabled("true", true), false);
  assert.equal(amuxScoreAutoRefreshEnabled("enabled", true), true);
  // A refresh binds a snapshot like a confirmation; nothing else does.
  assert.equal(amuxScoreAuditActionBinds("amux.v4.portfolio.score.confirm"), true);
  assert.equal(amuxScoreAuditActionBinds("amux.v4.portfolio.score.refresh"), true);
  assert.equal(amuxScoreAuditActionBinds("amux.v4.portfolio.assessment.approve"), false);
  assert.equal(amuxScoreAuditActionBinds(null), false);
});

test("owner direction 2026-11-15: the refresh is on by default and only exactly \"disabled\" turns it off", async () => {
  const { amuxScoreAutoRefreshEnabled } = await import("../lib/amux/portfolioScoreCore.ts");
  assert.equal(amuxScoreAutoRefreshEnabled(undefined, false), true);
  assert.equal(amuxScoreAutoRefreshEnabled("", false), true);
  assert.equal(amuxScoreAutoRefreshEnabled("enabled", false), true);
  assert.equal(amuxScoreAutoRefreshEnabled("off", false), true);
  assert.equal(amuxScoreAutoRefreshEnabled("disabled", false), false);
  // Without an explicit mode the intake switch decides: unset is the new rule.
  const previous = process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS;
  try {
    delete process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS;
    assert.equal(amuxScoreAutoRefreshEnabled(undefined), true);
    process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS = "enabled";
    assert.equal(amuxScoreAutoRefreshEnabled(undefined), false);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS;
    else process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS = previous;
  }
});

test("owner direction 2026-11-15: an unchanged score's windows both move forward, so seven and 28 days never stop it", async () => {
  const { amuxRefreshedScoreWindows, AMUX_ACTIVE_SCORE_MAX_AGE_MS,
    AMUX_BASELINE_SCORE_MAX_AGE_MS } = await import("../lib/amux/portfolioScoreCore.ts");
  const day = 86_400_000;
  const now = new Date("2026-11-15T02:00:00.000Z");
  const at = (days) => new Date(now.getTime() + days * day);
  const moved = { activeStaleAt: at(7), baselineStaleAt: at(28) };
  // Due within the lead, before its baseline: both windows move.
  assert.deepEqual(amuxRefreshedScoreWindows({ now, activeStaleAt: at(0.5),
    baselineStaleAt: at(20), legacy: false }), moved);
  // Near the baseline: no longer capped there.
  assert.deepEqual(amuxRefreshedScoreWindows({ now, activeStaleAt: at(-1),
    baselineStaleAt: at(2), legacy: false }), moved);
  // Both windows lapsed long ago (evidence 40 days old): due, and reopened.
  assert.deepEqual(amuxRefreshedScoreWindows({ now, activeStaleAt: at(-33),
    baselineStaleAt: at(-12), legacy: false }), moved);
  // A legacy capped score (active at its baseline) is due again.
  assert.deepEqual(amuxRefreshedScoreWindows({ now, activeStaleAt: at(0.5),
    baselineStaleAt: at(0.5), legacy: false }), moved);
  // Repeated over months of ticks, an unchanged score always comes back fresh.
  let windows = { activeStaleAt: at(0.5), baselineStaleAt: at(20) };
  for (let tick = 0; tick < 20; tick += 1) {
    const clock = new Date(windows.activeStaleAt.getTime() - 0.25 * day);
    const next = amuxRefreshedScoreWindows({ now: clock, ...windows, legacy: false });
    assert.ok(next, `tick ${tick} refreshed`);
    assert.ok(next.activeStaleAt.getTime() > clock.getTime());
    assert.ok(next.baselineStaleAt.getTime() > clock.getTime());
    assert.ok(next.baselineStaleAt.getTime() >= windows.baselineStaleAt.getTime());
    windows = next;
  }
  assert.ok(windows.baselineStaleAt.getTime() - at(0).getTime() >
    AMUX_BASELINE_SCORE_MAX_AGE_MS + 100 * day);
  // Not yet due, or unreadable clocks: nothing to write.
  assert.equal(amuxRefreshedScoreWindows({ now, activeStaleAt: at(1.5),
    baselineStaleAt: at(20), legacy: false }), null);
  assert.equal(amuxRefreshedScoreWindows({ now: new Date(Number.NaN),
    activeStaleAt: at(0), baselineStaleAt: at(5), legacy: false }), null);
  // The new windows fit the database's shape: active seven days past now,
  // at most the baseline; baseline at most 28 days past now.
  assert.equal(moved.activeStaleAt.getTime() - now.getTime(), AMUX_ACTIVE_SCORE_MAX_AGE_MS);
  assert.equal(moved.baselineStaleAt.getTime() - now.getTime(), AMUX_BASELINE_SCORE_MAX_AGE_MS);
});

test("with the legacy-limits switch the refresh keeps the 2026-11-14 baseline cap", async () => {
  const { amuxRefreshedScoreWindows } = await import("../lib/amux/portfolioScoreCore.ts");
  const day = 86_400_000;
  const now = new Date("2026-11-15T02:00:00.000Z");
  const at = (days) => new Date(now.getTime() + days * day);
  assert.deepEqual(amuxRefreshedScoreWindows({ now, activeStaleAt: at(0.5),
    baselineStaleAt: at(20), legacy: true }), { activeStaleAt: at(7), baselineStaleAt: at(20) });
  assert.deepEqual(amuxRefreshedScoreWindows({ now, activeStaleAt: at(-1),
    baselineStaleAt: at(2), legacy: true }), { activeStaleAt: at(2), baselineStaleAt: at(2) });
  assert.equal(amuxRefreshedScoreWindows({ now, activeStaleAt: at(-9),
    baselineStaleAt: at(-1), legacy: true }), null);
});
