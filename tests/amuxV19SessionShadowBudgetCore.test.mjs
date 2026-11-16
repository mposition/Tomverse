import assert from "node:assert/strict";
import test from "node:test";
import { assessSessionShadowBudget, resolveSessionUnknownClaim,
  settleSessionShadowUsage } from "../lib/amux/ideaSessionShadowBudgetCore.ts";

const basis = (change = {}) => ({
  mode: "subscription_cli", provider: "anthropic",
  billableToolsDisabled: true, ...change,
});
const recordOnly = { decision: "record_only", reservedMicroUsd: "0",
  amountMeaning: "cli_shadow_record_only" };

// Operator, 2026-11-16: a subscription call spends no money, so its shadow
// estimate is a record, never a stop.
test("subscription admission reserves nothing and never holds on the month", () => {
  assert.deepEqual(assessSessionShadowBudget(basis()), recordOnly);
  // The month's spending, reservation, shadow total and another claim's
  // unknown outcome are not part of the decision any more.
  for (const extra of [{ consumedMicroUsd: "50000000" }, { usageState: "unknown" },
    { monthlyLimitMicroUsd: "1" }]) {
    assert.deepEqual(assessSessionShadowBudget(basis(extra)),
      { decision: "hold", reason: "basis_invalid" }, JSON.stringify(extra));
  }
});

test("every subscription CLI channel is admitted the same way (owner decision 2026-10-20)", () => {
  for (const provider of ["openai", "anthropic", "github-copilot", "cursor"]) {
    assert.deepEqual(assessSessionShadowBudget(basis({ provider })), recordOnly, provider);
  }
});

test("subscription admission refuses API, unknown channels and billable tools", () => {
  for (const [change, reason] of [
    [{ mode: "api" }, "basis_invalid"],
    [{ provider: "xai" }, "basis_invalid"],
    [{ provider: "Anthropic" }, "basis_invalid"],
    [{ billableToolsDisabled: "yes" }, "basis_invalid"],
    [{ billableToolsDisabled: false }, "non_token_cost_unbounded"],
  ]) assert.deepEqual(assessSessionShadowBudget(basis(change)),
    { decision: "hold", reason });
  assert.deepEqual(assessSessionShadowBudget(null), { decision: "hold", reason: "basis_invalid" });
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

test("a subscription claim that reserved nothing closes at zero too", () => {
  assert.deepEqual(resolveSessionUnknownClaim({ budgetMode: "max_shadow",
    verification: "not_proven", reservedMicroUsd: "0" }), {
    decision: "resolve", status: "owner_consumed", settledMicroUsd: "0",
    spentIncrementMicroUsd: "0", shadowUsage: "unknown" });
});

test("an unknown closure refuses an unknown mode, verification or amount", () => {
  const valid = { budgetMode: "max_shadow", verification: "not_proven",
    reservedMicroUsd: "1" };
  for (const raw of [null, [], "max_shadow",
    { ...valid, budgetMode: "api" }, { ...valid, budgetMode: "Max_shadow" },
    { ...valid, verification: "proven" },
    { ...valid, budgetMode: "bounded", reservedMicroUsd: "0" },
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

test("a result with no reported tokens settles at zero, and nothing reserved spends nothing", () => {
  assert.deepEqual(settleSessionShadowUsage({
    reservedMicroUsd: "0", inputTokens: 0, outputTokens: 0,
    inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  }), { decision: "measured", settledMicroUsd: "0",
    boundedSpentMicroUsd: "0", shadowOverrunMicroUsd: "0" });
  assert.deepEqual(settleSessionShadowUsage({
    reservedMicroUsd: "0", inputTokens: 10, outputTokens: 10,
    inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  }), { decision: "measured", settledMicroUsd: "20",
    boundedSpentMicroUsd: "0", shadowOverrunMicroUsd: "20" });
  assert.deepEqual(settleSessionShadowUsage({
    reservedMicroUsd: "0", inputTokens: -1, outputTokens: 0,
    inputMicroUsdPerMillion: 1000000, outputMicroUsdPerMillion: 1000000,
  }), { decision: "hold", reason: "usage_unknown" });
});
