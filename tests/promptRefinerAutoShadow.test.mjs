import assert from "node:assert/strict";
import test from "node:test";

import { assessPromptRefinerAutoShadow } from "../lib/promptRefinerAutoShadow.ts";

const original = Object.freeze({
  qualityScore: 0.8,
  costMicroUsd: 100,
  preparationLatencyMs: 20,
});
const candidate = Object.freeze({
  qualityScore: 0.8,
  costMicroUsd: 100,
  preparationLatencyMs: 20,
});
const pair = (overrides = {}) => ({
  original,
  candidate,
  candidateOutcome: "completed",
  ...overrides,
});

test("complete paired measurements produce only an unauthorised shadow signal", () => {
  const result = assessPromptRefinerAutoShadow(pair());
  assert.equal(result.futureInputSignal, "no_recorded_regression");
  assert.equal(result.preparationLatencyDeltaMs, 0);
  assert.equal(result.evidenceAuthority, "caller_supplied_unverified");
  assert.equal(result.dispatchAuthorized, false);
});

test("quality, cost and measured preparation latency regressions keep the original", () => {
  const cases = [
    [{ qualityScore: 0.79 }, "quality_regressed", 0],
    [{ costMicroUsd: 101 }, "cost_regressed", 0],
    [{ preparationLatencyMs: 21 }, "latency_regressed", 1],
  ];
  for (const [change, reason, delta] of cases) {
    const result = assessPromptRefinerAutoShadow(
      pair({ candidate: { ...candidate, ...change } })
    );
    assert.equal(result.futureInputSignal, "keep_original");
    assert.equal(result.reason, reason);
    assert.equal(result.preparationLatencyDeltaMs, delta);
    assert.equal(result.dispatchAuthorized, false);
  }
});

test("missing, invalid, non-integer or unbounded measurements never claim improvement", () => {
  for (const change of [
    { qualityScore: null },
    { qualityScore: Number.NaN },
    { qualityScore: 1.1 },
    { costMicroUsd: null },
    { costMicroUsd: -1 },
    { costMicroUsd: 0.5 },
    { costMicroUsd: Number.MAX_SAFE_INTEGER + 1 },
    { preparationLatencyMs: null },
    { preparationLatencyMs: -1 },
    { preparationLatencyMs: Number.POSITIVE_INFINITY },
    { preparationLatencyMs: 1.5 },
  ]) {
    const result = assessPromptRefinerAutoShadow(
      pair({ candidate: { ...candidate, ...change } })
    );
    assert.equal(result.futureInputSignal, "keep_original");
    assert.equal(result.reason, "measurement_missing_or_invalid");
    assert.equal(result.preparationLatencyDeltaMs, null);
  }
  assert.equal(
    assessPromptRefinerAutoShadow(pair({ original: { ...original, qualityScore: null } }))
      .futureInputSignal,
    "keep_original"
  );
  for (const malformed of [null, undefined, {}]) {
    for (const key of ["original", "candidate"]) {
      const result = assessPromptRefinerAutoShadow(pair({ [key]: malformed }));
      assert.equal(result.futureInputSignal, "keep_original");
      assert.equal(result.reason, "measurement_missing_or_invalid");
    }
  }
});

test("a pre-dispatch failure may retain original, but dispatch failure or unknown stops", () => {
  for (const candidateOutcome of ["not_attempted", "failed_before_dispatch"]) {
    const result = assessPromptRefinerAutoShadow(pair({ candidateOutcome }));
    assert.equal(result.futureInputSignal, "keep_original");
    assert.equal(result.preparationLatencyDeltaMs, null);
  }
  for (const candidateOutcome of ["failed_after_dispatch", "unknown_after_dispatch"]) {
    const result = assessPromptRefinerAutoShadow(pair({ candidateOutcome }));
    assert.equal(result.futureInputSignal, "stop_and_reconcile");
    assert.equal(result.dispatchAuthorized, false);
  }
});

test("unrecognised outcome cannot authorize or certify a candidate", () => {
  const result = assessPromptRefinerAutoShadow(pair({ candidateOutcome: "success_or_something" }));
  assert.equal(result.futureInputSignal, "stop_and_reconcile");
  assert.equal(result.reason, "candidate_outcome_unknown");
  for (const malformed of [null, undefined]) {
    const result = assessPromptRefinerAutoShadow(malformed);
    assert.equal(result.futureInputSignal, "stop_and_reconcile");
    assert.equal(result.reason, "candidate_outcome_unknown");
  }
});
