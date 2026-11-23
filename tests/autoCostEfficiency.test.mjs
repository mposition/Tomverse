// Cost-efficiency diagnostic: cheaper challenger, price-blind judge, cost attribution and
// the diagnostic-only boundary. Mock calls only: no provider, no quality claim.
import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_LLM_ROUTER_DEFAULT_GUIDANCE } from "../lib/autoLlmRouterCore.ts";
import {
  AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS,
  AUTO_ROUTER_QUALITY_JUDGE_SYSTEM,
  COST_EFFICIENCY_OBJECTIVE,
  autoRouterJudgeMessage,
  autoRouterQualityJudgeMessage,
  autoRouterQualityJudgeSchema,
  combineQualityOrders,
  costEfficiencyChallenger,
  costEfficiencyDiagnosticOn,
  optimizerPromotionEligibility,
  parseQualityJudgement,
  runOptimizerCycle,
  splitOptimizerDecisionsByFamily,
} from "../lib/autoRouterOptimizerCore.ts";
import { COST_EFFICIENCY_CRITERIA, costEfficiencyReport } from "../lib/autoCostEfficiencyReport.ts";
import { observeOptimizerUsageCost, optimizerSpend } from "../lib/autoOptimizerCost.ts";
import { summarizeChatServingCost, traceAnswerCost } from "../lib/autoChatServingCostCore.ts";
import { actionableRecommendations } from "../lib/autoRouterRecommendationsCore.ts";

const candidate = (id, credits, tier = "standard") => ({
  id, name: id, provider: `${id}-co`, bestFor: "chat", tier, reasoning: null, contextWindowTokens: null, acceptsImages: false, credits,
});
const cheap = candidate("cheap", 1);
const mid = candidate("mid", 5);
const mid2 = candidate("mid2", 5);
const premium = candidate("premium", 9, "premium");
const MENU = [cheap, mid, mid2, premium];
const ESTIMATE = { cheap: 10, mid: 60, mid2: 40, premium: 200 };
const estimate = (id) => ESTIMATE[id] ?? null;

test("the challenger is lower-credit first, then a same-credit lower estimated cost, else a labelled quality comparison", () => {
  // Lower-only: the existing draw found nothing here (no same or higher credits above premium).
  const drawn = [0, 1, 2, 3].map((position) => costEfficiencyChallenger(MENU, "premium", position, estimate));
  assert.ok(drawn.every((item) => item.basis === "lower_credit"));
  // Reproducible order: credits, then id, rotated by the case's position.
  assert.deepEqual(drawn.map((item) => item.modelId), ["cheap", "mid", "mid2", "cheap"]);
  // Lower and same credits both exist: lower wins.
  assert.deepEqual(costEfficiencyChallenger(MENU, "mid", 0, estimate), { modelId: "cheap", basis: "lower_credit" });
  // Same credits only, one priced lower under the shared assumption.
  assert.deepEqual(costEfficiencyChallenger([mid, mid2, premium], "mid", 0, estimate), { modelId: "mid2", basis: "lower_estimated_provider_cost" });
  // Same credits, but the cheaper estimate is unknown: never treated as zero.
  assert.deepEqual(costEfficiencyChallenger([mid, mid2, premium], "mid", 0, (id) => (id === "mid2" ? null : estimate(id))),
    { modelId: "mid2", basis: "quality_comparison" });
  assert.deepEqual(costEfficiencyChallenger([mid, mid2, premium], "mid", 0, () => null), { modelId: "mid2", basis: "quality_comparison" });
  // Nothing cheaper: the existing same/next-higher draw, never a savings sample.
  assert.deepEqual(costEfficiencyChallenger(MENU, "cheap", 0, estimate), { modelId: "mid", basis: "quality_comparison" });
  // Off the menu, or alone on it.
  assert.equal(costEfficiencyChallenger(MENU, "missing", 0, estimate), null);
  assert.equal(costEfficiencyChallenger([premium], "premium", 0, estimate), null);
});

const decisionWith = (routerInput, candidates = MENU) => ({
  id: "d1", routerInput, routerContext: null, routerSession: null, candidates, pickedModelId: null, reason: null,
});

test("the quality judge sees no price or model name, and the same bounded message the answer model got", () => {
  // Within the answer model's 4 000-character bound, a requirement in the middle of a long message.
  const constraint = "중간 조건: 표는 만들지 마세요.";
  const message = `${"자료 ".repeat(500)}${constraint}${" 내용".repeat(500)}`;
  const decision = decisionWith(message);
  const a = { modelId: "premium", answer: "A answer" };
  const b = { modelId: "cheap", answer: "B answer" };
  const { prompt } = autoRouterQualityJudgeMessage(decision, a, b);
  const parsed = JSON.parse(prompt);
  assert.equal(parsed.message, message);
  assert.ok(parsed.message.includes(constraint));
  // The existing judge's 2 000-character head-and-tail excerpt drops it.
  assert.ok(!JSON.parse(autoRouterJudgeMessage(decision, a, b)).message.includes("표는 만들지"));
  for (const hidden of ["credits", "creditsA", "creditsB", "premium", "cheap"]) assert.ok(!prompt.includes(hidden), hidden);
  // Changing what the models cost changes nothing the judge reads.
  const repriced = decisionWith(message, MENU.map((item) => ({ ...item, credits: 100 - (item.credits ?? 0) })));
  assert.equal(autoRouterQualityJudgeMessage(repriced, a, b).prompt, prompt);
  assert.ok(!AUTO_ROUTER_QUALITY_JUDGE_SYSTEM.includes("prefer the answer with fewer credits"));
  assert.match(AUTO_ROUTER_QUALITY_JUDGE_SYSTEM, /not told what either answer cost/);
});

test("a long answer is cut where the judge stops reading and marked, never silently", () => {
  const long = "x".repeat(AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS + 10);
  const judged = autoRouterQualityJudgeMessage(decisionWith("q"), { modelId: "a", answer: long }, { modelId: "b", answer: "short" });
  const parsed = JSON.parse(judged.prompt);
  assert.equal(parsed.answerA.length, AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS);
  assert.equal(parsed.answerATruncated, true);
  assert.equal(parsed.answerBTruncated, false);
  assert.deepEqual(judged.truncated, { A: true, B: false });
  // A surrogate pair is never split at the cut.
  const emoji = "x".repeat(AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS - 1) + "😀tail";
  const cut = JSON.parse(autoRouterQualityJudgeMessage(decisionWith("q"), { modelId: "a", answer: emoji }, { modelId: "b", answer: "s" }).prompt).answerA;
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut));
});

test("both orders combine to a/b/equal only when they agree; nothing else becomes equal", () => {
  const j = (quality, A = false, B = false) => ({ quality, constraintFailure: { A, B } });
  assert.equal(combineQualityOrders(j("equal"), j("equal")).quality, "equal");
  assert.equal(combineQualityOrders(j("B"), j("A")).quality, "b");
  assert.equal(combineQualityOrders(j("A"), j("B")).quality, "a");
  assert.equal(combineQualityOrders(j("A"), j("A")).quality, "order_disagreement");
  assert.equal(combineQualityOrders(j("equal"), j("B")).quality, "order_disagreement");
  assert.equal(combineQualityOrders(j("insufficient"), j("equal")).quality, "insufficient");
  assert.deepEqual(combineQualityOrders(null, j("equal")), { quality: "undecided", constraintFailure: { a: null, b: null } });
  // b failed a requirement in both orders (B first, A second); a passed in both.
  assert.deepEqual(combineQualityOrders(j("A", false, true), j("B", true, false)).constraintFailure, { a: false, b: true });
  assert.deepEqual(combineQualityOrders(j("equal", false, true), j("equal", false, false)).constraintFailure, { a: false, b: null });
  assert.equal(parseQualityJudgement({ quality: "equal", constraintFailureA: false }), null);
  assert.equal(parseQualityJudgement({ winner: "A" }), null);
  assert.deepEqual(parseQualityJudgement({ quality: "B", constraintFailureA: true, constraintFailureB: false, reason: "r" }),
    { quality: "B", constraintFailure: { A: true, B: false } });
  assert.deepEqual(autoRouterQualityJudgeSchema().required, ["quality", "constraintFailureA", "constraintFailureB", "reason"]);
});

// The incumbent guidance overpays: it sends everything to premium. The proposal sends greetings to cheap.
const NEW_GUIDANCE = "Send greetings and small talk to the lightest model.\nSend code to the strongest model.";
const decisions = Array.from({ length: 24 }, (_, index) => ({
  id: `d${index}`, family: `conversation-${index}`,
  routerInput: index % 4 === 1 ? `hard code question ${index}` : `hello ${index}`,
  routerContext: null, routerSession: null, candidates: MENU, pickedModelId: "premium", reason: "r",
}));
const ANSWER_COST = { cheap: 5, mid: 30, mid2: 20, premium: 100 };
const known = (amountMicroUsd) => ({
  costMicroUsd: amountMicroUsd,
  cost: { state: "known", amountMicroUsd, usage: { inputTokens: 1, outputTokens: 1 }, prices: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
});
const costDeps = (overrides = {}) => {
  const calls = { route: 0, answer: 0, judge: 0, qualityJudge: 0, generate: 0 };
  const seen = { qualityPrompts: [] };
  return {
    calls, seen,
    deps: {
      synthesize: async () => ({ value: { messages: [] }, ...known(1), provider: "opt" }),
      candidatesFor: () => MENU,
      generate: async () => { calls.generate++; return { value: { findings: [], recommendations: [], guidance: NEW_GUIDANCE }, ...known(100), provider: "opt" }; },
      route: async (guidance, decision) => {
        calls.route++;
        return { value: guidance === NEW_GUIDANCE && decision.routerInput.startsWith("hello") ? "cheap" : "premium", ...known(10), provider: "rtr" };
      },
      answer: async (modelId) => { calls.answer++; return { value: `${modelId} answer`, ...known(ANSWER_COST[modelId]), provider: `${modelId}-co` }; },
      judge: async () => { calls.judge++; throw new Error("the price-aware judge must not run"); },
      qualityJudge: async (message) => {
        calls.qualityJudge++;
        seen.qualityPrompts.push(message);
        return { value: { quality: "equal", constraintFailure: { A: false, B: false } }, ...known(20), provider: "opt" };
      },
      estimateAnswerMicroUsd: (modelId) => estimate(modelId),
      budgetMicroUsd: 1_000_000,
      ...overrides,
    },
  };
};
const costInput = (extra = {}) => ({
  decisions, incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE, objective: "chat_cost_efficiency",
  familyOf: (decision) => decision.family ?? decision.id, ...extra,
});

test("a cost-efficiency cycle compares cheaper candidates in the one slot, keeps equal as equal and is diagnostic only", async () => {
  const { calls, deps } = costDeps();
  const result = await runOptimizerCycle(costInput(), deps);
  assert.equal(result.status, "diagnostic");
  assert.equal(result.failure, null);
  assert.equal(result.gate, null);
  assert.deepEqual(result.objective, COST_EFFICIENCY_OBJECTIVE);
  assert.equal(result.quality.status, "unmeasured");
  // The existing price-aware judge never runs; the quality judge runs in the same two orders.
  assert.equal(calls.judge, 0);
  const compared = result.comparisons.filter((item) => item.costEfficiency);
  assert.equal(compared.length, 12);
  assert.ok(compared.every((item) => item.costEfficiency.basis === "lower_credit" && item.a === "premium"));
  // An equal judgement stays a tie: a cheaper model's equal answer is not its win.
  assert.ok(compared.every((item) => item.verdict === "tie" && item.costEfficiency.quality === "equal"));
  const report = result.costEfficiency;
  assert.equal(report.candidateDiagnosis.savingsSamples, 12);
  assert.equal(report.candidateDiagnosis.quality.equal, 12);
  assert.equal(report.candidateDiagnosis.quality.challengerBetter, 0);
  // Observed answer cost: premium 100 against cheaper answers, all known.
  assert.equal(report.candidateDiagnosis.observedAnswerCost.pairsKnown, 12);
  assert.equal(report.candidateDiagnosis.observedAnswerCost.incumbentMicroUsd, 12 * 100);
  assert.equal(report.candidateDiagnosis.observedAnswerCost.challengerLower, 12);
  // The replay reuses answers and judgements the direct comparison already paid for, and says so.
  const changed = result.cases.filter((item) => item.costEfficiency);
  assert.ok(changed.length > 0);
  assert.ok(changed.every((item) => item.costEfficiency.reusedAnswers.a));
  assert.ok(changed.some((item) => item.costEfficiency.reusedAnswers.b));
  // Each (case, model) answer is paid once, and each ordered judgement once.
  const answerCalls = result.costCoverage.calls.filter((call) => call.kind === "answer");
  const keys = new Set(answerCalls.map((call) => `${call.identity.caseId}/${call.identity.modelId}`));
  assert.equal(answerCalls.length, keys.size);
  assert.equal(calls.answer, keys.size);
  const judgeKeys = new Set(result.costCoverage.calls.filter((call) => call.kind === "judge").map((call) => call.identity.caseId + call.identity.arm));
  assert.ok(judgeKeys.size > 0);
  // Every evaluation call carries its identity; experiment cost is the whole known spend.
  assert.ok(result.costCoverage.calls.filter((call) => ["route", "answer", "judge"].includes(call.kind))
    .every((call) => call.identity?.objective === "chat_cost_efficiency" && call.identity.caseId));
  assert.equal(report.experimentCost.knownMicroUsd, result.spentMicroUsd);
  assert.equal(report.servingCost.coverage, "partial_serving_cost");
  assert.equal(report.servingCost.complete, true);
  assert.ok(report.servingCost.router.baseline.calls === 12 && report.servingCost.router.candidate.calls === 12);
  assert.equal(report.taskCost.status, "unlinked");
  assert.equal(report.applicability.applicable, false);
  assert.ok(report.applicability.reasons.includes("diagnostic_only"));
  assert.ok(!report.applicability.reasons.includes("criteria_unconfirmed"));
  // The family split keeps a conversation in one half.
  const evaluated = new Set(result.cases.map((item) => item.decisionId));
  assert.equal(evaluated.size, 12);
});

test("a diagnostic result is refused by the shared promotion check, whatever its status says", async () => {
  const { deps } = costDeps();
  const result = await runOptimizerCycle(costInput(), deps);
  const summary = { ...result.summary, objective: result.objective, costEfficiency: result.costEfficiency };
  for (const status of ["diagnostic", "passed"]) {
    assert.deepEqual(optimizerPromotionEligibility({ status, candidateGuidance: NEW_GUIDANCE, summary }), { eligible: false, refusal: "diagnostic_only" });
  }
  assert.deepEqual(optimizerPromotionEligibility({ status: "passed", candidateGuidance: NEW_GUIDANCE, summary: { costEfficiency: {} } }).refusal, "diagnostic_only");
  // A routing cycle with no objective keeps its existing checks.
  assert.equal(optimizerPromotionEligibility({ status: "passed", candidateGuidance: NEW_GUIDANCE, summary: {} }).refusal, "legacy_unverified");
  // A diagnostic cycle's recommendations are never actionable by an agent or a send.
  assert.deepEqual(actionableRecommendations({ objective: COST_EFFICIENCY_OBJECTIVE, report: { recommendations: [{ kind: "code", text: "x" }] } }), []);
  assert.equal(actionableRecommendations({ report: { recommendations: [{ kind: "code", text: "x" }] } }).length, 1);
});

test("the default routing cycle is unchanged by the new objective", async () => {
  const { calls, deps } = costDeps({
    judge: async (message) => ({ value: JSON.parse(message).answerA === "cheap answer" ? "A" : "B", ...known(20), provider: "opt" }),
  });
  const result = await runOptimizerCycle({ decisions, incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE }, deps);
  assert.notEqual(result.status, "diagnostic");
  assert.equal(result.objective, undefined);
  assert.equal(result.costEfficiency, undefined);
  assert.equal(calls.qualityJudge, 0);
  assert.ok(result.comparisons.every((item) => item.costEfficiency === undefined));
  assert.ok(result.costCoverage.calls.every((call) => call.identity === undefined));
  // The existing draw still finds no same-credit or higher model above premium.
  assert.ok(result.comparisons.every((item) => item.verdict === "no_alternative" || item.verdict === "unrouted"));
  await assert.rejects(runOptimizerCycle(costInput(), { ...deps, qualityJudge: undefined }), /quality_judge_required/);
});

test("order disagreement, insufficient evidence and critical constraint failures stay apart", async () => {
  const judgeAlways = (value) => costDeps({ qualityJudge: async () => ({ value, ...known(20), provider: "opt" }) }).deps;
  const disagreed = await runOptimizerCycle(costInput(), judgeAlways({ quality: "A", constraintFailure: { A: false, B: false } }));
  assert.equal(disagreed.costEfficiency.candidateDiagnosis.quality.orderDisagreement, 12);
  assert.equal(disagreed.costEfficiency.candidateDiagnosis.quality.equal, 0);
  assert.ok(disagreed.comparisons.filter((item) => item.costEfficiency).every((item) => item.verdict === "undecided"));
  assert.ok(disagreed.costEfficiency.applicability.reasons.includes("undecided_above_tolerance"));
  const insufficient = await runOptimizerCycle(costInput(), judgeAlways({ quality: "insufficient", constraintFailure: { A: false, B: false } }));
  assert.equal(insufficient.costEfficiency.candidateDiagnosis.quality.insufficient, 12);
  // The cheaper answer (A in the second order) fails a requirement in both orders.
  const { deps } = costDeps({
    qualityJudge: async (message) => {
      const { answerA } = JSON.parse(message);
      const cheaperFirst = !answerA.startsWith("premium");
      return { value: { quality: cheaperFirst ? "B" : "A", constraintFailure: cheaperFirst ? { A: true, B: false } : { A: false, B: true } }, ...known(20), provider: "opt" };
    },
  });
  const regressed = await runOptimizerCycle(costInput(), deps);
  assert.equal(regressed.costEfficiency.candidateDiagnosis.quality.incumbentBetter, 12);
  assert.equal(regressed.costEfficiency.candidateDiagnosis.criticalRegressions, 12);
  assert.ok(regressed.costEfficiency.applicability.reasons.includes("critical_regression_observed"));
  assert.ok(regressed.costEfficiency.applicability.reasons.includes("quality_loss_above_tolerance"));
});

test("an exact-answer case is graded by the existing grader beside the judge", async () => {
  const exactDecisions = decisions.map((decision) => ({ ...decision, expected: { value: 437 } }));
  const { deps } = costDeps({
    answer: async (modelId) => ({ value: modelId === "premium" ? '{"value":437}' : '{"value":436}', ...known(ANSWER_COST[modelId]), provider: `${modelId}-co` }),
    gradeExact: (decision, answer) => JSON.stringify(JSON.parse(answer)) === JSON.stringify(decision.expected),
  });
  const result = await runOptimizerCycle(costInput({ decisions: exactDecisions }), deps);
  const exact = result.costEfficiency.candidateDiagnosis.exact;
  assert.equal(exact.graded, 12);
  assert.equal(exact.incumbentPassed, 12);
  assert.equal(exact.challengerPassed, 0);
  assert.equal(result.costEfficiency.candidateDiagnosis.criticalRegressions, 12);
});

test("a retried answer pays both tries, and unknown cost stops scheduling without becoming zero", async () => {
  const tries = new Map();
  const { deps } = costDeps({
    answer: async (modelId, turn) => {
      const key = `${modelId}/${turn.message}`;
      tries.set(key, (tries.get(key) ?? 0) + 1);
      // Cheap answers empty on its first try, at a known cost.
      const value = modelId === "cheap" && tries.get(key) === 1 ? "" : `${modelId} answer`;
      return { value, ...known(ANSWER_COST[modelId]), provider: `${modelId}-co` };
    },
  });
  const retried = await runOptimizerCycle(costInput(), deps);
  const cheapPairs = retried.comparisons.filter((item) => item.b === "cheap");
  assert.ok(cheapPairs.length > 0);
  assert.ok(cheapPairs.every((item) => item.costEfficiency.answerCost.b.attempts === 2 && item.costEfficiency.answerCost.b.microUsd === 10));
  assert.ok(retried.costEfficiency.experimentCost.answerRetries >= cheapPairs.length);

  const unknown = costDeps({
    answer: async (modelId) => modelId === "cheap"
      ? { value: "cheap answer", costMicroUsd: null, cost: { state: "unknown", dispatch: "dispatched", reason: "missing_usage" }, provider: "cheap-co" }
      : { value: `${modelId} answer`, ...known(ANSWER_COST[modelId]), provider: `${modelId}-co` },
  });
  const stopped = await runOptimizerCycle(costInput(), unknown.deps);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.failure, "cost_unknown");
  assert.ok(stopped.costEfficiency.experimentCost.unknownCalls >= 1);
  assert.equal(stopped.costEfficiency.experimentCost.complete, false);
  for (const reason of ["cycle_incomplete", "cost_coverage_incomplete"]) assert.ok(stopped.costEfficiency.applicability.reasons.includes(reason));
});

test("an answer that was never sent is not asked for again, and its pair is no answer, not a known US$0", async () => {
  const tries = new Map();
  const { deps } = costDeps({
    answer: async (modelId, turn) => {
      const key = `${modelId}/${turn.message}`;
      tries.set(key, (tries.get(key) ?? 0) + 1);
      return modelId === "cheap"
        ? { value: null, costMicroUsd: 0, cost: { state: "no_dispatch", reason: "model_unavailable" }, provider: "unknown" }
        : { value: `${modelId} answer`, ...known(ANSWER_COST[modelId]), provider: `${modelId}-co` };
    },
  });
  const result = await runOptimizerCycle(costInput(), deps);
  const cheapPairs = result.comparisons.filter((item) => item.b === "cheap");
  assert.ok(cheapPairs.length > 0);
  assert.ok([...tries].filter(([key]) => key.startsWith("cheap/")).every(([, count]) => count === 1));
  assert.ok(cheapPairs.every((item) => item.costEfficiency.answerCost.b.attempts === 1));
  const observed = result.costEfficiency.candidateDiagnosis.observedAnswerCost;
  assert.equal(observed.pairsUnanswered, cheapPairs.length);
  // Only the pairs where both sides answered are cost pairs; a missing cheap answer is never "cheaper".
  assert.equal(observed.pairsKnown, result.costEfficiency.candidateDiagnosis.savingsSamples - cheapPairs.length);
  assert.equal(observed.challengerLower, observed.pairsKnown);
});

test("fewer credits with a higher observed answer cost is not a saving", () => {
  const unknownView = { state: "unknown", microUsd: null, attempts: 1, failedAttempts: 0 };
  const view = (microUsd) => ({ state: "known", microUsd, attempts: 1, failedAttempts: 0 });
  const observation = { quality: "equal", qualityOrders: [null, null], constraintFailure: { a: false, b: false }, truncated: { a: false, b: false } };
  const comparison = (b, costB) => ({
    kind: "easy", a: "premium", b, verdict: "tie", answerMs: { a: 100, b: 80 },
    costEfficiency: { basis: "lower_credit", credits: { a: 9, b: 1 }, estimatedMicroUsd: { a: 200, b: 10 }, answerCost: { a: view(10), b: costB }, ...observation },
  });
  const spend = optimizerSpend(1_000).totals();
  const report = costEfficiencyReport({
    comparisons: [comparison("cheap", view(50)), comparison("mid", unknownView)], cases: [],
    coverage: spend.costCoverage, spentByKind: spend.spentByKind, criteria: COST_EFFICIENCY_CRITERIA, failure: null,
    summary: { incumbentCredits: 9, candidateCredits: 9 },
  });
  const observed = report.candidateDiagnosis.observedAnswerCost;
  assert.deepEqual(observed, { pairsKnown: 1, pairsUnknown: 1, pairsUnanswered: 0, incumbentMicroUsd: 10, challengerMicroUsd: 50, challengerLower: 0, challengerHigher: 1, same: 0 });
  assert.deepEqual(report.candidateDiagnosis.credits, { pairs: 2, incumbent: 18, challenger: 2 });
  assert.ok(report.applicability.reasons.includes("no_observed_saving"));
  assert.ok(report.applicability.reasons.includes("guidance_not_cheaper"));
  assert.equal(report.applicability.measuredWithinCriteria, false);
  // No routed arm, or a cycle that did not finish: the serving cost is unmeasured, never a complete US$0.
  assert.equal(report.servingCost.complete, false);
  assert.equal(report.servingCost.baselineKnownMicroUsd, 0);
});

test("usage priced by the existing helper counts cache reads once and refuses an unpriced cache write", () => {
  const prices = { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8, cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: null };
  const cached = observeOptimizerUsageCost({ inputTokens: 1_000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 800 }, outputTokenDetails: { reasoningTokens: 60 } }, prices);
  assert.equal(cached.state, "known");
  // 200 uncached x 2 + 800 cached x 0.2 + 100 output (reasoning inside) x 8.
  assert.equal(cached.amountMicroUsd, 400 + 160 + 800);
  assert.equal(cached.usage.cachedInputTokens, 800);
  assert.equal(cached.usage.reasoningTokens, 60);
  assert.equal(observeOptimizerUsageCost({ inputTokens: 1_000, outputTokens: 0 }, prices).amountMicroUsd, 2_000);
  assert.deepEqual(observeOptimizerUsageCost({ inputTokens: 1_000, outputTokens: 0, inputTokenDetails: { cacheWriteTokens: 500 } }, prices),
    { state: "unknown", dispatch: "dispatched", reason: "unpriced_cache_write" });
  assert.equal(observeOptimizerUsageCost({ inputTokens: 1_000, outputTokens: 0, inputTokenDetails: { cacheWriteTokens: 500 } },
    { ...prices, cacheWriteUsdPerMillionTokens: 2.5 }).amountMicroUsd, 1_000 + 1_250);
  assert.equal(observeOptimizerUsageCost(undefined, prices).state, "unknown");
  assert.equal(observeOptimizerUsageCost({ inputTokens: 1, outputTokens: 1, inputTokenDetails: { cacheReadTokens: -1 } }, prices).reason, "invalid_usage");
});

test("the family split never puts one family in both halves", () => {
  const items = ["c1", "c1", "c2", "c3", "c3", "c3", "c4"].map((family, index) => ({ id: index, family }));
  const { train, evaluate } = splitOptimizerDecisionsByFamily(items, (item) => item.family);
  const trainFamilies = new Set(train.map((item) => item.family));
  assert.ok(evaluate.every((item) => !trainFamilies.has(item.family)));
  assert.equal(train.length + evaluate.length, items.length);
});

test("the diagnostic switch is on only when set to on", () => {
  assert.equal(costEfficiencyDiagnosticOn({}), false);
  assert.equal(costEfficiencyDiagnosticOn({ AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC: "true" }), false);
  assert.equal(costEfficiencyDiagnosticOn({ AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC: " On " }), true);
});

test("real Chat serving cost links answers by trace and keeps router, Refiner and search unknown", () => {
  const record = (overrides) => ({
    traceId: "t", pickedModelId: "cheap", outcome: "picked", router: { inputTokens: 300, outputTokens: 20 },
    reservations: [{ id: "r1", status: "settled", settledCredits: 2 }],
    attempts: [{ reservationId: "r1", modelId: "cheap", outcome: "completed", costMicroUsd: 120n, estimated: false }],
    routingRun: true, firstContentMs: 900, ...overrides,
  });
  assert.deepEqual(traceAnswerCost(record({})), { state: "known", microUsd: 120 });
  assert.deepEqual(traceAnswerCost(record({ reservations: [] })), { state: "unlinked" });
  assert.deepEqual(traceAnswerCost(record({ attempts: [{ reservationId: "r1", modelId: "cheap", outcome: "failed", costMicroUsd: 500n, estimated: true }] })), { state: "unknown" });
  assert.deepEqual(traceAnswerCost(record({ reservations: [{ id: "r1", status: "reserved", settledCredits: 0 }] })), { state: "unknown" });
  const retried = record({ traceId: "t2", attempts: [
    { reservationId: "r1", modelId: "mid", outcome: "failed", costMicroUsd: 40n, estimated: false },
    { reservationId: "r1", modelId: "cheap", outcome: "completed", costMicroUsd: 120n, estimated: false },
  ] });
  const summary = summarizeChatServingCost([record({}), retried, record({ traceId: "t3", reservations: [], attempts: [] })], { since: "s", until: "u" });
  assert.equal(summary.coverage, "answer_cost_only");
  assert.equal(summary.components.router, "tokens_recorded_without_price_snapshot");
  assert.equal(summary.components.promptRefiner, "unattributed");
  assert.equal(summary.components.appManagedSearch, "unattributed");
  assert.equal(summary.components.nativeSearch, "inside_attempt_cost");
  assert.equal(summary.total.traces, 3);
  assert.equal(summary.total.linked, 2);
  // A failed try is real spend: it stays in the request's cost.
  assert.equal(summary.total.answer.knownMicroUsd, 120 + 160);
  assert.equal(summary.total.answer.failedAttempts, 1);
  assert.equal(summary.total.answer.retriedTraces, 1);
  assert.equal(summary.total.router.tokenTraces, 3);
  assert.equal(summary.total.firstContentMsP50, 900);
  // Two reservations on one trace: one with no attempts leaves the trace unknown, not partly known.
  assert.deepEqual(traceAnswerCost(record({ reservations: [
    { id: "r1", status: "settled", settledCredits: 2 }, { id: "r2", status: "settled", settledCredits: 1 },
  ] })), { state: "unknown" });
});

test("the offline dry run builds a complete manifest and runs the real cycle on mock calls only", async () => {
  const { runCostEfficiencyDryRun, costEfficiencyCorpus } = await import("../scripts/auto-cost-efficiency-dry-run.mjs");
  const corpus = costEfficiencyCorpus();
  // Tool-contract fixtures (search, files, long-tail delivery) are left to Chat E2E.
  assert.ok(corpus.cases.every((item) => !/tools|freshness|long-tail/.test(item.kind)));
  const run = await runCostEfficiencyDryRun();
  assert.match(run.notice, /^MOCK/);
  const { manifest, result } = run;
  assert.equal(manifest.execution, "mock");
  assert.equal(manifest.promotion, "refused_diagnostic_only");
  assert.equal(manifest.criteria.status, "confirmed");
  assert.equal(manifest.criteria.confirmedOn, "2026-11-23");
  assert.match(manifest.criteriaDigest, /^[a-f0-9]{64}$/);
  assert.ok(manifest.models.answering.length > 2 && manifest.models.answering.every((model) => model.modelId && model.provider && "apiModel" in model));
  assert.ok(manifest.allowedProviders.length > 0);
  assert.equal(manifest.holdout.currentResultsEnterGenerator, false);
  assert.ok(manifest.corpus.train > 0 && manifest.corpus.evaluate >= 10);
  assert.ok(Number.isSafeInteger(manifest.plan.worstCaseMicroUsd) && manifest.plan.worstCaseMicroUsd > 0);
  assert.equal(manifest.plan.calls.judge, 4 * manifest.corpus.evaluate);
  assert.equal(result.status, "diagnostic");
  const c = result.costEfficiency.candidateDiagnosis;
  assert.ok(c.savingsSamples > 0);
  // The mock's wrong calculation on the lowest tier is caught by the existing exact grader.
  assert.ok(c.exact.graded > 0 && c.exact.challengerPassed < c.exact.incumbentPassed);
  assert.ok(!result.costEfficiency.applicability.reasons.includes("criteria_unconfirmed"));
  assert.equal(result.costEfficiency.applicability.applicable, false);
});
