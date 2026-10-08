import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD,
  advanceAmuxIdeaAnalysisFailureState,
  assessAmuxIdeaAnalysisBudget,
  assessAmuxIdeaAnalysisSettlement,
} from "../lib/amux/ideaAnalysisBudgetCore.ts";

const basis = (overrides = {}) => ({
  namespace: "agent/amux-intake",
  mode: "subscription_cli",
  provider: "openai",
  modelId: "frontier-model-approved-by-owner",
  pricingVersion: "approved-worst-tier-v1",
  pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
  pricingExpiresAt: "2026-11-01T00:00:00.000Z",
  asOfIso: "2026-10-01T01:00:00.000Z",
  windowStartsAtIso: "2026-10-01T00:00:00.000Z",
  worstTierVerified: true,
  tokenCapsEnforceable: true,
  billableToolsDisabled: true,
  inputTokensCap: 1_000,
  outputTokensCap: 2_000,
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 2_000_000,
  consumedMicroUsd: "10000000",
  reservedMicroUsd: "5000000",
  usageState: "known",
  ...overrides,
});

test("v4 analysis budget is a separate USD 50 shadow reservation candidate, not CLI billing", () => {
  assert.equal(AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD, "50000000");
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis()), {
    decision: "reservation_candidate",
    namespace: "agent/amux-intake",
    mode: "subscription_cli",
    provider: "openai",
    modelId: "frontier-model-approved-by-owner",
    worstCaseMicroUsd: "5000",
    remainingAfterMicroUsd: "34995000",
    pricingVersion: "approved-worst-tier-v1",
    windowStartsAtIso: "2026-10-01T00:00:00.000Z",
    amountMeaning: "cli_api_conversion_estimate",
  });
  assert.equal(assessAmuxIdeaAnalysisBudget(basis({ mode: "api" })).amountMeaning,
    "api_price_reservation_ceiling");
});

test("consumed and in-flight reservations both count; the exact cap is allowed", () => {
  assert.equal(assessAmuxIdeaAnalysisBudget(basis({
    consumedMicroUsd: "49994000", reservedMicroUsd: "1000",
  })).decision, "reservation_candidate");
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({
    consumedMicroUsd: "49994001", reservedMicroUsd: "1000",
  })), { decision: "hold", reason: "monthly_cap_exceeded" });
});

test("small token categories round upward; cache discounts never enter the bound", () => {
  const result = assessAmuxIdeaAnalysisBudget(basis({
    inputTokensCap: 1, outputTokensCap: 1,
    inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1,
    consumedMicroUsd: "0", reservedMicroUsd: "0",
  }));
  assert.equal(result.worstCaseMicroUsd, "2");
});

test("unknown usage, unenforceable caps and missing worst-tier prices fail closed", () => {
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({ usageState: "unknown" })),
    { decision: "hold", reason: "usage_unknown" });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({ tokenCapsEnforceable: false })),
    { decision: "hold", reason: "caps_unenforceable" });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({ billableToolsDisabled: false })),
    { decision: "hold", reason: "non_token_cost_unbounded" });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({ worstTierVerified: false })),
    { decision: "hold", reason: "price_unverified" });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({ outputMicroUsdPerMillion: 0 })),
    { decision: "hold", reason: "price_unverified" });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({
    pricingVerifiedAt: "2026-10-02T00:00:00.000Z",
  })), { decision: "hold", reason: "price_unverified" });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis({
    pricingExpiresAt: "2026-10-01T01:00:00.000Z",
  })), { decision: "hold", reason: "price_unverified" });
});

test("malformed or cross-namespace ledger values never become zero", () => {
  for (const overrides of [
    { namespace: "chat" }, { consumedMicroUsd: null },
    { consumedMicroUsd: "-1" }, { reservedMicroUsd: "1.2" },
    { consumedMicroUsd: "9223372036854775808" },
    { inputMicroUsdPerMillion: "1000000" },
    { outputMicroUsdPerMillion: Number.NaN },
    { inputTokensCap: Number.NaN }, { outputTokensCap: 0 },
    { usageState: "missing" }, { pricingVersion: "" },
    { pricingVersion: "line\nbreak" },
    { asOfIso: "not-an-instant" }, { provider: "unknown" },
    { pricingExpiresAt: "not-an-instant" },
    { windowStartsAtIso: "2026-09-01T00:00:00.000Z" },
    { extra: true },
  ]) {
    assert.deepEqual(assessAmuxIdeaAnalysisBudget(basis(overrides)),
      { decision: "hold", reason: "basis_invalid" });
  }
});

test("accessors are refused and a Proxy get trap cannot change the checked calculation", () => {
  const accessed = basis();
  Object.defineProperty(accessed, "consumedMicroUsd", { get: () => "0", enumerable: true });
  assert.deepEqual(assessAmuxIdeaAnalysisBudget(accessed),
    { decision: "hold", reason: "basis_invalid" });

  const changingGet = new Proxy(basis(), {
    get(target, key) {
      if (key === "consumedMicroUsd") return "99999999";
      return Reflect.get(target, key);
    },
  });
  const result = assessAmuxIdeaAnalysisBudget(changingGet);
  assert.equal(result.decision, "reservation_candidate");
  assert.equal(result.remainingAfterMicroUsd, "34995000");
});

test("only a verified successful invocation resets the agent-wide failure streak", () => {
  let state = { consecutiveFailures: 0, haltReason: null };
  state = advanceAmuxIdeaAnalysisFailureState(state, "invocation_failed");
  assert.deepEqual(state, { consecutiveFailures: 1, haltReason: null });
  state = advanceAmuxIdeaAnalysisFailureState(state, "preflight_refusal");
  state = advanceAmuxIdeaAnalysisFailureState(state, "owner_cancelled");
  assert.deepEqual(state, { consecutiveFailures: 1, haltReason: null });
  state = advanceAmuxIdeaAnalysisFailureState(state, "invocation_failed");
  state = advanceAmuxIdeaAnalysisFailureState(state, "invocation_failed");
  assert.deepEqual(state, { consecutiveFailures: 3, haltReason: "three_failures" });
  assert.equal(advanceAmuxIdeaAnalysisFailureState(state, "verified_success"), null);
  assert.deepEqual(advanceAmuxIdeaAnalysisFailureState(state, "preflight_refusal"), state);
  assert.deepEqual(advanceAmuxIdeaAnalysisFailureState(state, "owner_cancelled"), state);
  assert.equal(advanceAmuxIdeaAnalysisFailureState(state, "outcome_unknown"), null);
  assert.equal(advanceAmuxIdeaAnalysisFailureState(state, "unknown_event"), null);
  assert.deepEqual(advanceAmuxIdeaAnalysisFailureState({
    consecutiveFailures: 2, haltReason: null,
  }, "verified_success"), { consecutiveFailures: 0, haltReason: null });
});

test("outcome_unknown stops at once and cannot be self-cleared", () => {
  const state = advanceAmuxIdeaAnalysisFailureState({
    consecutiveFailures: 1, haltReason: null,
  }, "outcome_unknown");
  assert.deepEqual(state, { consecutiveFailures: 1, haltReason: "outcome_unknown" });
  assert.equal(advanceAmuxIdeaAnalysisFailureState(state, "verified_success"), null);
  assert.equal(advanceAmuxIdeaAnalysisFailureState({ ...state, other: true }, "owner_cancelled"), null);
});

test("invalid failure state is rejected and cannot become an extra invocation", () => {
  assert.equal(advanceAmuxIdeaAnalysisFailureState({
    consecutiveFailures: 3, haltReason: null,
  }, "invocation_failed"), null);
  assert.equal(advanceAmuxIdeaAnalysisFailureState({
    consecutiveFailures: 3, haltReason: "outcome_unknown",
  }, "invocation_failed"), null);
});

const settlement = (overrides = {}) => ({
  outcome: "verified_success", reservedMicroUsd: "5000",
  inputTokensCap: 1_000, outputTokensCap: 2_000,
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 2_000_000,
  inputTokens: 200, outputTokens: 300, ...overrides,
});

test("verified usage settles a bounded amount and frees only the unused reservation", () => {
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement()), {
    decision: "settlement_candidate", status: "succeeded",
    settledMicroUsd: "800", releasedMicroUsd: "4200",
  });
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    outcome: "invocation_failed", inputTokens: 200, outputTokens: 0,
  })), { decision: "settlement_candidate", status: "failed",
    settledMicroUsd: "200", releasedMicroUsd: "4800" });
});

test("unknown or unmeasured invocation never settles as zero", () => {
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    outcome: "outcome_unknown", inputTokens: null, outputTokens: null,
  })), { decision: "hold", reason: "usage_unknown" });
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    inputTokens: 0, outputTokens: 0,
  })), { decision: "hold", reason: "basis_invalid" });
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    outcome: "outcome_unknown", inputTokens: 1,
  })), { decision: "hold", reason: "basis_invalid" });
});

test("a provider over cap or a mismatched reservation blocks settlement", () => {
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    inputTokens: 1_001,
  })), { decision: "hold", reason: "usage_exceeds_cap" });
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    reservedMicroUsd: "799",
  })), { decision: "hold", reason: "reservation_mismatch" });
  assert.deepEqual(assessAmuxIdeaAnalysisSettlement(settlement({
    extra: true,
  })), { decision: "hold", reason: "basis_invalid" });
});
