import assert from "node:assert/strict";
import test from "node:test";
import { assessSessionShadowBudget, resolveSessionUnknownClaim,
  settleSessionShadowUsage } from "../lib/amux/ideaSessionShadowBudgetCore.ts";

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

test("every subscription CLI channel may occupy headroom (owner decision 2026-10-20)", () => {
  for (const provider of ["openai", "anthropic", "github-copilot", "cursor"]) {
    assert.deepEqual(assessSessionShadowBudget(basis({ provider })), {
      decision: "occupy_headroom", reservedMicroUsd: "35000000",
      amountMeaning: "cli_shadow_headroom_not_ceiling",
    }, provider);
  }
});

test("subscription exception refuses API, unknown channels, unknown usage and unpriced calls", () => {
  for (const [change, reason] of [
    [{ mode: "api" }, "basis_invalid"],
    [{ provider: "xai" }, "basis_invalid"],
    [{ provider: "Anthropic" }, "basis_invalid"],
    [{ usageState: "unknown" }, "usage_unknown"],
    [{ billableToolsDisabled: false }, "non_token_cost_unbounded"],
    [{ worstTierVerified: false }, "price_unverified"],
    [{ pricingExpiresAt: "2026-10-18T00:00:00.000Z" }, "price_unverified"],
  ]) assert.deepEqual(assessSessionShadowBudget(basis(change)),
    { decision: "hold", reason });
});

test("an unproven subscription closure returns its headroom; a bounded one consumes it", () => {
  // Owner decision 2026-10-20: a subscription run spends no money, so its
  // occupied headroom is not counted as this month's usage.
  assert.deepEqual(resolveSessionUnknownClaim({ budgetMode: "max_shadow",
    verification: "not_proven", reservedMicroUsd: "35000000" }), {
    decision: "resolve", status: "owner_consumed", settledMicroUsd: "0",
    spentIncrementMicroUsd: "0", shadowUsage: "unknown" });
  assert.deepEqual(resolveSessionUnknownClaim({ budgetMode: "bounded",
    verification: "not_proven", reservedMicroUsd: "5000" }), {
    decision: "resolve", status: "owner_consumed", settledMicroUsd: "5000",
    spentIncrementMicroUsd: "5000", shadowUsage: null });
  for (const budgetMode of ["bounded", "max_shadow"]) {
    assert.deepEqual(resolveSessionUnknownClaim({ budgetMode,
      verification: "proven_not_started", reservedMicroUsd: "5000" }), {
      decision: "resolve", status: "released", settledMicroUsd: "0",
      spentIncrementMicroUsd: "0", shadowUsage: null }, budgetMode);
  }
});

test("an unknown closure refuses an unknown mode, verification or amount", () => {
  const valid = { budgetMode: "max_shadow", verification: "not_proven",
    reservedMicroUsd: "1" };
  for (const raw of [null, [], "max_shadow",
    { ...valid, budgetMode: "api" }, { ...valid, budgetMode: "Max_shadow" },
    { ...valid, verification: "proven" }, { ...valid, reservedMicroUsd: "0" },
    { ...valid, reservedMicroUsd: 1 }, { ...valid, reservedMicroUsd: "-1" },
    { ...valid, reservedMicroUsd: "9223372036854775808" },
    { ...valid, extra: true }, { budgetMode: "max_shadow", verification: "not_proven" }]) {
    assert.deepEqual(resolveSessionUnknownClaim(raw), { decision: "refuse" },
      JSON.stringify(raw));
  }
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
