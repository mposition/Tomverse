import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_TUNABLES,
  MODEL_EXCLUSION_TUNABLE,
  TIMEOUT_CHANGE_COOLDOWN_AFTER_REVERT_MS,
  TUNABLE_CHANGES_PER_CYCLE,
  activeExclusions,
  admitTunableChanges,
  applyTunableChanges,
  effectiveRouterTimeoutMs,
  parseTunables,
  revertedTimeout,
  routerOutcomeShares,
  tunableChangesSchema,
  tunableRevertDecision,
  withoutExcludedModels,
} from "../lib/autoRouterTunablesCore.ts";
import { autoRouterGeneratorSchema, AUTO_ROUTER_GENERATOR_SYSTEM } from "../lib/autoRouterOptimizerCore.ts";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const CODE_TIMEOUT = 5_000;

const stats = ({ decisions = 100, timeout = 0, error = 0, p90 = 2_000 } = {}) => ({
  decisions,
  outcomes: { picked: decisions - timeout - error, invalid: 0, error, timeout },
  latencyMs: { p50: 1_000, p90 },
});

const candidates = [
  { id: "mini", credits: 9 },
  { id: "luna", credits: 9 },
  { id: "flash", credits: 9 },
  { id: "terra", credits: 12 },
];

const evidence = (overrides = {}) => ({
  routerStats: stats(),
  answerStats: {},
  candidates,
  ...overrides,
});

const timeoutChange = (value, reason = "타임아웃이 잦습니다") => ({
  setting: "routerTimeoutMs",
  value,
  modelId: null,
  hours: null,
  reason,
});
const excludeChange = (modelId, hours = 24) => ({
  setting: "excludeModel",
  value: null,
  modelId,
  hours,
  reason: "답변 실패가 반복됩니다",
});

const admit = (proposed, extra = {}) =>
  admitTunableChanges({
    proposed,
    current: EMPTY_TUNABLES,
    evidence: evidence(),
    codeTimeoutMs: CODE_TIMEOUT,
    now: NOW,
    ...extra,
  });

test("a timeout is raised only when timeouts or errors were frequent, inside its range and steps", () => {
  const busy = evidence({ routerStats: stats({ timeout: 4, error: 2 }) });
  assert.deepEqual(admit([timeoutChange(6_000)], { evidence: busy }).admitted, [
    { setting: "routerTimeoutMs", value: 6_000, reason: "타임아웃이 잦습니다" },
  ]);
  // Calm routing: no evidence to raise it.
  assert.deepEqual(admit([timeoutChange(6_000)]).rejected, [{ setting: "routerTimeoutMs", reason: "no_evidence" }]);
  // Out of range, off the step, unchanged, or too few decisions.
  assert.equal(admit([timeoutChange(9_000)], { evidence: busy }).rejected[0].reason, "out_of_range");
  assert.equal(admit([timeoutChange(2_500)], { evidence: busy }).rejected[0].reason, "out_of_range");
  assert.equal(admit([timeoutChange(6_100)], { evidence: busy }).rejected[0].reason, "out_of_range");
  assert.equal(admit([timeoutChange(CODE_TIMEOUT)], { evidence: busy }).rejected[0].reason, "unchanged");
  const thin = evidence({ routerStats: stats({ decisions: 10, timeout: 5 }) });
  assert.equal(admit([timeoutChange(6_000)], { evidence: thin }).rejected[0].reason, "no_evidence");
});

test("a timeout is lowered only when nothing timed out and p90 sits well under the new value", () => {
  assert.equal(admit([timeoutChange(4_000)], { evidence: evidence({ routerStats: stats({ p90: 2_000 }) }) }).admitted.length, 1);
  assert.equal(
    admit([timeoutChange(4_000)], { evidence: evidence({ routerStats: stats({ p90: 3_000 }) }) }).rejected[0].reason,
    "no_evidence"
  );
  assert.equal(
    admit([timeoutChange(4_000)], { evidence: evidence({ routerStats: stats({ timeout: 1, p90: 1_000 }) }) }).rejected[0].reason,
    "no_evidence"
  );
});

test("a model is excluded only after its answers kept failing, and only while a same-credit choice remains", () => {
  // answered counts successes only: mini failed 2 of 4 tries, luna 2 of 6.
  const failing = evidence({ answerStats: { mini: { answered: 2, failed: 2 }, luna: { answered: 4, failed: 2 } } });
  assert.deepEqual(admit([excludeChange("mini")], { evidence: failing }).admitted, [
    { setting: "excludeModel", modelId: "mini", hours: 24, reason: "답변 실패가 반복됩니다" },
  ]);
  // Two failures in six tries is not a failing model.
  assert.equal(admit([excludeChange("luna")], { evidence: failing }).rejected[0].reason, "no_evidence");
  // Not a candidate, or hours out of range.
  assert.equal(admit([excludeChange("ghost")], { evidence: failing }).rejected[0].reason, "not_a_candidate");
  assert.equal(admit([excludeChange("mini", 72)], { evidence: failing }).rejected[0].reason, "out_of_range");
  assert.equal(admit([excludeChange("mini", 0)], { evidence: failing }).rejected[0].reason, "out_of_range");
  // The only 12-credit candidate cannot be left out: nothing would take its place.
  const terraFailing = evidence({ answerStats: { terra: { answered: 2, failed: 2 } } });
  assert.equal(admit([excludeChange("terra")], { evidence: terraFailing }).rejected[0].reason, "no_same_credit_alternative");
});

test("no more than the cycle limit is applied, nor more exclusions than allowed at once", () => {
  const all = evidence({
    routerStats: stats({ timeout: 10 }),
    answerStats: { mini: { answered: 2, failed: 2 }, luna: { answered: 2, failed: 2 } },
  });
  const outcome = admit([timeoutChange(6_000), excludeChange("mini"), excludeChange("luna")], { evidence: all });
  assert.equal(outcome.admitted.length, TUNABLE_CHANGES_PER_CYCLE);
  assert.deepEqual(outcome.rejected, [{ setting: "excludeModel", reason: "over_cycle_limit" }]);

  const full = {
    routerTimeoutMs: null,
    timeoutRevertedAt: null,
    excluded: Array.from({ length: MODEL_EXCLUSION_TUNABLE.maxActive }, (_, index) => ({
      modelId: `x${index}`,
      until: new Date(NOW + 3_600_000).toISOString(),
      setAt: new Date(NOW).toISOString(),
      cycleId: "c0",
      reason: "r",
    })),
  };
  assert.equal(admit([excludeChange("mini")], { evidence: all, current: full }).rejected[0].reason, "too_many_exclusions");
});

test("anything off the closed list or off its shape is refused, never applied", () => {
  const outcome = admit([
    { setting: "maxCredits", value: 1, modelId: null, hours: null, reason: "x" },
    { setting: "routerTimeoutMs", value: "6000", modelId: null, hours: null },
    "free text",
  ]);
  assert.equal(outcome.admitted.length, 0);
  assert.deepEqual(
    outcome.rejected.map((item) => item.reason),
    ["unknown_setting", "malformed", "unknown_setting"]
  );
});

test("applied settings round-trip through storage; expired exclusions end on their own", () => {
  const applied = applyTunableChanges({
    current: EMPTY_TUNABLES,
    changes: [
      { setting: "routerTimeoutMs", value: 6_000, reason: "r1" },
      { setting: "excludeModel", modelId: "mini", hours: 2, reason: "r2" },
    ],
    cycleId: "c1",
    now: NOW,
    codeTimeoutMs: CODE_TIMEOUT,
    before: { decisions: 100, timeoutOrErrorShare: 0.08, p90LatencyMs: 4_800 },
  });
  const stored = parseTunables(JSON.stringify(applied));
  assert.deepEqual(stored, applied);
  assert.equal(stored.routerTimeoutMs.previous, CODE_TIMEOUT);
  assert.equal(effectiveRouterTimeoutMs(stored, CODE_TIMEOUT), 6_000);
  assert.deepEqual(activeExclusions(stored, NOW + 3_600_000).map((item) => item.modelId), ["mini"]);
  assert.deepEqual(activeExclusions(stored, NOW + 3 * 3_600_000), []);
  // Unreadable storage is no setting at all, never a guess.
  assert.deepEqual(parseTunables("not json"), EMPTY_TUNABLES);
  assert.deepEqual(parseTunables(JSON.stringify({ routerTimeoutMs: { value: 99_000 } })), EMPTY_TUNABLES);
});

test("the live router drops excluded models, but never below two candidates", () => {
  const tunables = {
    routerTimeoutMs: null,
    timeoutRevertedAt: null,
    excluded: [{ modelId: "mini", until: new Date(NOW + 60_000).toISOString(), setAt: "", cycleId: "c", reason: "r" }],
  };
  assert.deepEqual(withoutExcludedModels(candidates, tunables, NOW).map((item) => item.id), ["luna", "flash", "terra"]);
  const two = [{ id: "mini" }, { id: "luna" }];
  assert.deepEqual(withoutExcludedModels(two, tunables, NOW).map((item) => item.id), ["mini", "luna"]);
  assert.deepEqual(withoutExcludedModels(candidates, tunables, NOW + 120_000).length, 4);
});

test("a tuned timeout is undone when timeouts and errors rose after it, and only with enough decisions", () => {
  const tuned = {
    value: 6_000,
    previous: 5_000,
    setAt: new Date(NOW).toISOString(),
    cycleId: "c1",
    reason: "r",
    before: { decisions: 100, timeoutOrErrorShare: 0.06, p90LatencyMs: 4_900 },
  };
  assert.equal(tunableRevertDecision(tuned, routerOutcomeShares(stats({ decisions: 50, timeout: 10 }))), "revert");
  assert.equal(tunableRevertDecision(tuned, routerOutcomeShares(stats({ decisions: 50, timeout: 2 }))), "keep");
  assert.equal(tunableRevertDecision(tuned, routerOutcomeShares(stats({ decisions: 5, timeout: 5 }))), "wait");
  assert.equal(tunableRevertDecision(null, null), "keep");
  // Undoing goes back to the code's default, not to an earlier tuned value.
  const undone = revertedTimeout({ routerTimeoutMs: tuned, excluded: [], timeoutRevertedAt: null }, NOW);
  assert.equal(undone.routerTimeoutMs, null);
  assert.equal(undone.timeoutRevertedAt, new Date(NOW).toISOString());
});

test("the analysis call is asked for setting changes in a strict, all-required shape", () => {
  const schema = autoRouterGeneratorSchema();
  assert.ok(schema.required.includes("settingChanges"));
  assert.deepEqual(schema.properties.settingChanges, tunableChangesSchema());
  assert.deepEqual(tunableChangesSchema().items.required, ["setting", "value", "modelId", "hours", "reason"]);
  assert.match(AUTO_ROUTER_GENERATOR_SYSTEM, /settingChanges/);
});

test("after a tuned timeout is undone, no timeout change is taken for a week, so the bad stretch never becomes the baseline", () => {
  const busy = evidence({ routerStats: stats({ timeout: 8, error: 4 }) });
  const reverted = { routerTimeoutMs: null, excluded: [], timeoutRevertedAt: new Date(NOW - 60_000).toISOString() };
  assert.deepEqual(admit([timeoutChange(6_500)], { evidence: busy, current: reverted }).rejected, [
    { setting: "routerTimeoutMs", reason: "recently_reverted" },
  ]);
  const later = { ...reverted, timeoutRevertedAt: new Date(NOW - TIMEOUT_CHANGE_COOLDOWN_AFTER_REVERT_MS - 1).toISOString() };
  assert.equal(admit([timeoutChange(6_500)], { evidence: busy, current: later }).admitted.length, 1);
  // The cooldown survives storage.
  assert.equal(parseTunables(JSON.stringify(reverted)).timeoutRevertedAt, reverted.timeoutRevertedAt);
});

test("a model that answered four times and failed twice is not excluded: half of all tries must fail", () => {
  const healthy = evidence({ answerStats: { mini: { answered: 4, failed: 2 } } });
  assert.equal(admit([excludeChange("mini")], { evidence: healthy }).rejected[0].reason, "no_evidence");
  const failing = evidence({ answerStats: { mini: { answered: 2, failed: 2 } } });
  assert.equal(admit([excludeChange("mini")], { evidence: failing }).admitted.length, 1);
});
