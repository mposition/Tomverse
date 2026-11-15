import assert from "node:assert/strict";
import test from "node:test";
import { observeOptimizerCost, optimizerCostFields, optimizerSpend } from "../lib/autoOptimizerCost.ts";
import { optimizerPromotionEligibility } from "../lib/autoRouterOptimizerCore.ts";
import { verifiedOptimizerSummary } from "./fixtures/optimizerVerifiedSummary.ts";

const prices = { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 1.5 };

test("cost states distinguish reported zero, missing/invalid usage and prices, and verified no-dispatch", async () => {
  assert.equal(observeOptimizerCost({ inputTokens: 0, outputTokens: 0 }, prices).amountMicroUsd, 0);
  assert.equal(observeOptimizerCost({ inputTokens: 300, outputTokens: 50 }, prices).amountMicroUsd, 120);
  for (const usage of [undefined, {}, { inputTokens: 0 }, { outputTokens: 0 }]) {
    assert.deepEqual(observeOptimizerCost(usage, prices), { state: "unknown", dispatch: "dispatched", reason: "missing_usage" });
  }
  for (const n of [NaN, -1, Infinity, null]) for (const field of ["inputTokens", "outputTokens"]) {
    assert.equal(observeOptimizerCost({ inputTokens: 0, outputTokens: 0, [field]: n }, prices).reason, "invalid_usage");
  }
  for (const n of [NaN, -1, Infinity]) for (const field of Object.keys(prices)) {
    assert.equal(observeOptimizerCost({ inputTokens: 0, outputTokens: 0 }, { ...prices, [field]: n }).reason, "invalid_price");
  }
  const spend = optimizerSpend(1000);
  await spend.call("answer", async () => ({ value: null, provider: "test", ...optimizerCostFields({ state: "no_dispatch", reason: "model_unavailable" }) }));
  const cost = spend.totals().costCoverage;
  assert.equal(cost.noDispatchCalls, 1);
  assert.equal(cost.knownCalls, 0);
  assert.equal(cost.complete, true);
  assert.equal(spend.exhausted(), false);
});

test("unknown cost closes new scheduling while in-flight known usage is fully collected", async () => {
  const spend = optimizerSpend(1000);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const ongoing = spend.call("answer", async () => {
    await held;
    return { value: "answer", provider: "p", ...optimizerCostFields(observeOptimizerCost({ inputTokens: 300, outputTokens: 50 }, prices)) };
  });
  await spend.call("judge", async () => ({ value: "B", provider: "p", ...optimizerCostFields(observeOptimizerCost(undefined, prices)) }));
  let called = false;
  assert.equal(await spend.call("generate", async () => { called = true; throw new Error(); }), null);
  assert.equal(called, false);
  release();
  await ongoing;
  const totals = spend.totals();
  assert.equal(spend.closedReason(), "cost_unknown");
  assert.equal(totals.spentMicroUsd, 120);
  assert.equal(totals.spentByProvider.get("p"), 120);
  assert.deepEqual([totals.costCoverage.started, totals.costCoverage.completed, totals.costCoverage.notStarted], [2, 2, 1]);
  assert.equal(totals.costCoverage.usagePricedCalls, 1);
  assert.equal(totals.costCoverage.unknownCalls, 1);
});

test("throw, NaN, negative and absent costs are never promoted to known zero", async () => {
  for (const value of [NaN, -1, undefined, null]) {
    const spend = optimizerSpend(1000);
    await spend.call("route", async () => ({ value: "pick", costMicroUsd: value, provider: "p" }));
    assert.equal(spend.closedReason(), "cost_unknown");
    assert.equal(spend.totals().costCoverage.knownCalls, 0);
  }
  const spend = optimizerSpend(1000);
  await spend.call("route", async () => { throw new Error("secret prompt and credential"); });
  const { costCoverage } = spend.totals();
  assert.deepEqual(costCoverage.calls[0], { kind: "route", provider: "unknown", failed: true, state: "unknown", dispatch: "unknown", reason: "exception" });
  assert.ok(!JSON.stringify(costCoverage).includes("secret"));
});

test("manual and auto promotion share version, independent holdout, cost and existing quality gates", async () => {
  const summary = await verifiedOptimizerSummary();
  const cycle = { status: "passed", candidateGuidance: "Keep all user constraints and choose an eligible low-credit model for simple work.", summary };
  assert.equal(optimizerPromotionEligibility(cycle).eligible, true);
  for (const actor of ["manual", "auto"]) {
    assert.equal(optimizerPromotionEligibility({ ...cycle, actor, summary: { ...summary, costCoverage: { ...summary.costCoverage, complete: false, unknownCalls: 1 } } }).refusal, "cost_unconfirmed");
    assert.equal(optimizerPromotionEligibility({ ...cycle, actor, summary: { ...summary, evaluation: { ...summary.evaluation, independentHoldout: false } } }).refusal, "holdout_unverified");
    assert.equal(optimizerPromotionEligibility({ ...cycle, actor, summary: { ...summary, candidateCredits: 14 } }).refusal, "quality_not_passed");
    assert.equal(optimizerPromotionEligibility({ ...cycle, actor, summary: { ...summary, quality: { status: "failed", failure: "win_share_below" } } }).refusal, "quality_not_passed");
  }
  const legacy = { ...cycle, summary: { evaluated: 12, candidateWins: 12 } };
  const original = JSON.stringify(legacy);
  assert.equal(optimizerPromotionEligibility(legacy).refusal, "legacy_unverified");
  assert.equal(JSON.stringify(legacy), original);
  const invalidCounts = { ...summary, decided: undefined };
  assert.equal(optimizerPromotionEligibility({ ...cycle, summary: invalidCounts }).refusal, "quality_not_passed");
});
