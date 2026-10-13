import assert from "node:assert/strict";
import test from "node:test";
import { buildAdaptiveStatistics } from "../lib/adaptiveStatisticsCore.ts";

test("empty windows remain unknown rather than invented rates", () => {
  const report = buildAdaptiveStatistics([], []);
  assert.equal(report.refiner.requests, 0);
  assert.deepEqual(report.refiner.suggestionLatencyMs, { population: 0, p50: null, p95: null });
  assert.deepEqual(report.refiner.actualCostMicroUsd, { population: 0, reported: 0, missing: 0, total: "0" });
  assert.equal(report.autoRouter.totalLatencyMs.p95, null);
});

test("Auto consumption is not counted as explicit user acceptance and missing cost is not zero", () => {
  const base = {
    outcome: "suggested", failureCode: null, preparationLatencyMs: 100,
    actualCostMicroUsd: 17n, inputTokens: 10n, outputTokens: 4n,
    dispositions: [{ outcome: "accepted" }],
  };
  const report = buildAdaptiveStatistics([
    { ...base, productContext: { mode: "explicit" } },
    { ...base, productContext: { mode: "auto" }, actualCostMicroUsd: null },
    { ...base, outcome: "refused_before_dispatch", failureCode: "eligibility_refused", productContext: null, actualCostMicroUsd: null, inputTokens: null, outputTokens: null, dispositions: [] },
  ], []);
  assert.deepEqual(report.refiner.explicitChoice, { accepted: 1, denominator: 1 });
  assert.equal(report.refiner.explicitDispositions.accepted, 1);
  assert.equal(report.refiner.autoDispositions.accepted, 1);
  assert.equal(report.refiner.dispatched, 2);
  assert.deepEqual(report.refiner.actualCostMicroUsd, { population: 3, reported: 1, missing: 2, total: "17" });
  assert.equal(report.refiner.byMode.unrecorded, 1);
});

test("actual Router runs keep version, fallback and attempt outcomes separate", () => {
  const report = buildAdaptiveStatistics([], [{
    plan: "Guest", reservationId: "reservation-1", estimatedInputTokens: 14,
    profileKind: "writing", selectionPolicyVersion: "v2",
    selectionReason: "fallback_order", eligibleCount: 2,
    rejectedByReason: { disabled: 3, "raw prompt must not escape": 9 }, initialModelId: "one", finalModelId: "two",
    rerouteCount: 1, fallbackState: "fallback_used", settlementOutcome: "unknown",
    decisionMicros: 1500, totalLatencyMs: null, firstTokenMs: null,
    routingAttempts: [{ outcome: "failed_pre_token", failureLayer: "provider" }, { outcome: "succeeded", failureLayer: "none" }],
  }], [{
    reservationId: "reservation-1", costMicroUsd: 12n, costSource: "reserved_upper_bound",
    inputTokens: null, outputTokens: null, adjustments: [{ costDeltaMicroUsd: -7n }],
  }]);
  assert.equal(report.autoRouter.rerouted, 1);
  assert.equal(report.autoRouter.policyVersions.v2, 1);
  assert.equal(report.autoRouter.attemptOutcomes.failed_pre_token, 1);
  assert.equal(report.autoRouter.attemptFailureLayers.provider, 1);
  assert.equal(report.autoRouter.rejectedReasons.disabled, 3);
  assert.equal(report.autoRouter.rejectedReasons["raw prompt must not escape"], undefined);
  assert.equal(report.autoRouter.totalLatencyMs.missing, 1);
  assert.equal(report.autoRouter.settlementOutcomes.unknown, 1);
  assert.equal(report.autoRouter.providerUsage.costSources.late_provider_actual, 1);
  assert.equal(report.autoRouter.providerUsage.measuredOrTokenEstimatedCostMicroUsd.total, "5");
  assert.equal(report.autoRouter.providerUsage.inputTokens.missing, 1);
});

test("crash upper-bound cost is kept separate from observed or token-priced cost", () => {
  const sample = {
    plan: "Free", reservationId: "hold-1", estimatedInputTokens: 20,
    profileKind: "coding", selectionPolicyVersion: "v2", selectionReason: "ranked",
    eligibleCount: 1, rejectedByReason: {}, initialModelId: "one", finalModelId: null,
    rerouteCount: 0, fallbackState: "none", settlementOutcome: "unknown",
    decisionMicros: 500, totalLatencyMs: null, firstTokenMs: null, routingAttempts: [],
  };
  const report = buildAdaptiveStatistics([], [sample], [{
    reservationId: "hold-1", costMicroUsd: 30n, costSource: "reserved_upper_bound",
    inputTokens: null, outputTokens: null, adjustments: [],
  }]);
  assert.equal(report.autoRouter.providerUsage.upperBoundCostRows, 1);
  assert.equal(report.autoRouter.providerUsage.measuredOrTokenEstimatedCostMicroUsd.total, "0");
  assert.equal(report.autoRouter.providerUsage.runsWithoutUsage, 0);
});
