import assert from "node:assert/strict";
import test from "node:test";
import { assessSessionShadowBudget, settleSessionShadowUsage } from
  "../lib/amux/ideaSessionShadowBudgetCore.ts";

const basis = (change = {}) => ({
  mode: "subscription_cli", provider: "anthropic",
  asOfIso: "2026-10-18T00:00:00.000Z",
  pricingVerifiedAt: "2026-10-17T00:00:00.000Z",
  pricingExpiresAt: "2026-10-19T00:00:00.000Z",
  inputMicroUsdPerMillion: 3000000, outputMicroUsdPerMillion: 15000000,
  worstTierVerified: true, billableToolsDisabled: true,
  consumedMicroUsd: "10000000", reservedMicroUsd: "5000000",
  shadowOverrunMicroUsd: "0", monthlyLimitMicroUsd: "50000000",
  usageState: "known", ...change,
});

test("Max shadow admission occupies all remaining headroom without asserting a hard cap", () => {
  assert.deepEqual(assessSessionShadowBudget(basis()), {
    decision: "occupy_headroom", reservedMicroUsd: "35000000",
    amountMeaning: "cli_shadow_headroom_not_ceiling",
  });
  assert.deepEqual(assessSessionShadowBudget(basis({
    shadowOverrunMicroUsd: "35000000",
  })), { decision: "hold", reason: "monthly_shadow_reached" });
});

test("Max exception refuses API, non-Anthropic, unknown and unpriced calls", () => {
  for (const [change, reason] of [
    [{ mode: "api" }, "basis_invalid"],
    [{ provider: "openai" }, "basis_invalid"],
    [{ usageState: "unknown" }, "usage_unknown"],
    [{ billableToolsDisabled: false }, "non_token_cost_unbounded"],
    [{ worstTierVerified: false }, "price_unverified"],
    [{ pricingExpiresAt: "2026-10-18T00:00:00.000Z" }, "price_unverified"],
  ]) assert.deepEqual(assessSessionShadowBudget(basis(change)),
    { decision: "hold", reason });
});

test("observed CLI overrun is retained rather than clamped to reserved headroom", () => {
  assert.deepEqual(settleSessionShadowUsage({
    reservedMicroUsd: "10", inputTokens: 10, outputTokens: 10,
    inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  }), { decision: "measured", settledMicroUsd: "20",
    boundedSpentMicroUsd: "10", shadowOverrunMicroUsd: "10" });
  assert.deepEqual(settleSessionShadowUsage({
    reservedMicroUsd: "30", inputTokens: 10, outputTokens: 10,
    inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  }), { decision: "measured", settledMicroUsd: "20",
    boundedSpentMicroUsd: "20", shadowOverrunMicroUsd: "0" });
  assert.deepEqual(settleSessionShadowUsage({
    reservedMicroUsd: "30", inputTokens: null, outputTokens: null,
    inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  }), { decision: "hold", reason: "usage_unknown" });
});
