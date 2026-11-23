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

test("an answer that ended in an exception counts at its upper bound and the run goes on", async () => {
  const { optimizerBoundedCost } = await import("../lib/autoOptimizerCost.ts");
  const { optimizerAnswerBound, OPTIMIZER_ANSWER_FRAMING_TOKENS } = await import("../lib/autoRouterOptimizerCore.ts");
  // Every UTF-8 byte is a token (a token is never smaller than a byte), plus framing, plus the whole output cap.
  const bound = optimizerAnswerBound({ system: "sys", prompt: "안녕", maxOutputTokens: 1_000 }, prices);
  assert.equal(bound.state, "bounded");
  assert.equal(bound.bound.inputTokens, 3 + 6 + OPTIMIZER_ANSWER_FRAMING_TOKENS);
  assert.equal(bound.bound.outputTokens, 1_000);
  assert.equal(bound.amountMicroUsd, Math.ceil((3 + 6 + OPTIMIZER_ANSWER_FRAMING_TOKENS) * 0.15 + 1_000 * 1.5));
  // A bound that cannot be priced stays unknown, never zero.
  assert.equal(optimizerBoundedCost({ inputTokens: 1, outputTokens: 1, prices: { ...prices, outputUsdPerMillionTokens: NaN } }).state, "unknown");

  const spend = optimizerSpend(100_000);
  await spend.call("answer", async () => ({ value: null, provider: "slow", ...optimizerCostFields(bound) }));
  assert.equal(spend.exhausted(), false, "a bounded call does not stop the run");
  await spend.call("answer", async () => ({ value: "ok", provider: "fast", ...optimizerCostFields(observeOptimizerCost({ inputTokens: 300, outputTokens: 50 }, prices)) }));
  const totals = spend.totals();
  // The bound counts toward the run's spend, its kind and the provider's bucket; the known total stays known-only.
  assert.equal(totals.spentMicroUsd, bound.amountMicroUsd + 120);
  assert.equal(totals.spentByKind.answer, bound.amountMicroUsd + 120);
  assert.equal(totals.spentByProvider.get("slow"), bound.amountMicroUsd);
  assert.equal(totals.costCoverage.knownMicroUsd, 120);
  assert.equal(totals.costCoverage.boundedMicroUsd, bound.amountMicroUsd);
  assert.equal(totals.costCoverage.boundedCalls, 1);
  assert.equal(totals.costCoverage.unknownCalls, 0);
  assert.equal(totals.costCoverage.complete, true);
  assert.equal(totals.costCoverage.failed, 1);
  // Bounds count toward the budget: once spent reaches it, nothing new starts.
  const tight = optimizerSpend(bound.amountMicroUsd);
  await tight.call("answer", async () => ({ value: null, provider: "slow", ...optimizerCostFields(bound) }));
  assert.equal(await tight.call("answer", async () => { throw new Error("must not start"); }), null);
  assert.equal(tight.closedReason(), "budget_exhausted");
});

test("promotion accepts calls counted at their upper bound and still refuses unknown ones", async () => {
  const summary = await verifiedOptimizerSummary();
  const cycle = { status: "passed", candidateGuidance: "Keep all user constraints and choose an eligible low-credit model for simple work.", summary };
  const cost = summary.costCoverage;
  const withBounded = { ...cost, started: cost.started + 1, completed: cost.completed + 1, failed: cost.failed + 1, boundedCalls: 1, boundedMicroUsd: 1_575 };
  assert.equal(optimizerPromotionEligibility({ ...cycle, summary: { ...summary, costCoverage: withBounded } }).eligible, true);
  // The bounded count must account for the started call, or the coverage does not add up.
  assert.equal(optimizerPromotionEligibility({ ...cycle, summary: { ...summary, costCoverage: { ...withBounded, boundedCalls: 0 } } }).refusal, "cost_unconfirmed");
  assert.equal(optimizerPromotionEligibility({ ...cycle, summary: { ...summary, costCoverage: { ...withBounded, boundedMicroUsd: -1 } } }).refusal, "cost_unconfirmed");
  assert.equal(optimizerPromotionEligibility({ ...cycle, summary: { ...summary, costCoverage: { ...withBounded, complete: false, unknownCalls: 1 } } }).refusal, "cost_unconfirmed");
});

test("every answer adapter turns an exception into the same bounded failure, counted as a failed call", async () => {
  const { optimizerAnswerOrBound } = await import("../lib/autoRouterOptimizerCore.ts");
  const options = { system: "s", prompt: "p", maxOutputTokens: 100 };
  const ok = await optimizerAnswerOrBound(async () => "answer", options, prices, "p");
  assert.deepEqual(ok, { generated: "answer" });
  const timedOut = await optimizerAnswerOrBound(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }, options, prices, "slow");
  assert.equal(timedOut.failed.value, null);
  assert.equal(timedOut.failed.cost.state, "bounded");
  assert.equal(timedOut.failed.costMicroUsd, null, "a bound is never a known subtotal");
  assert.equal(timedOut.failed.provider, "slow");
  const spend = optimizerSpend(100_000);
  await spend.call("answer", async () => timedOut.failed);
  const totals = spend.totals();
  assert.equal(totals.failedByKind.answer, 1);
  assert.equal(totals.failedCalls, 1);
  // The routing, rewrite and coding adapters all go through it.
  const { readFileSync } = await import("node:fs");
  for (const file of ["lib/autoRouterOptimizer.ts", "lib/autoRewriteOptimizer.ts", "lib/autoCodingRouterOptimizer.ts"]) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").includes("optimizerAnswerOrBound(() => traced(\"answer\""), file);
  }
});
