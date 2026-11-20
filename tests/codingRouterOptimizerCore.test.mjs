import assert from "node:assert/strict";
import test from "node:test";
import {
    CODING_ROUTER_GENERATOR_SYSTEM,
    CODING_ROUTER_JUDGE_SYSTEM,
    CODING_ROUTER_SYNTHESIZER_SYSTEM,
    CODING_TASK_EVAL_BUDGET_SHARE,
    codingGeneratorEvidence,
    codingTaskEvalRunnerIsolated,
    withTaskEvaluationCost,
} from "../lib/autoCodingRouterOptimizerCore.ts";
import { AUTO_LLM_ROUTER_GUIDANCE_KINDS } from "../lib/autoLlmRouterCore.ts";
import { AUTO_ROUTER_GENERATOR_SYSTEM, AUTO_ROUTER_JUDGE_OUTPUT_RULE } from "../lib/autoRouterOptimizerCore.ts";
import { scheduledOptimizerTarget } from "../lib/autoRewriteOptimizerCore.ts";
import { summarizeCodingRouting } from "../lib/externalApiRoutingReportCore.ts";

/**
 * The coding router optimizer and the coding routing report (owner decision
 * 2026-11-20): a third optimizer target, its coding prompts, and a daily
 * content-free report of what Smart Adaptive did on the external API.
 */

test("coding is a third guidance kind an optimizer cycle may improve", () => {
    assert.deepEqual([...AUTO_LLM_ROUTER_GUIDANCE_KINDS], ["routing", "rewrite", "coding"]);
});

test("the daily run takes the switched-on targets in turn, one a day", () => {
    const pick = (routingDaily, rewriteDaily, codingDaily, lastSystemTarget) =>
        scheduledOptimizerTarget({ routingDaily, rewriteDaily, codingDaily, lastSystemTarget });
    assert.equal(pick(false, false, false, null), null);
    assert.equal(pick(false, false, true, null), "coding");
    assert.equal(pick(false, false, true, "coding"), "coding", "alone, every day");
    // Unchanged for the two existing targets.
    assert.equal(pick(true, true, false, null), "routing");
    assert.equal(pick(true, true, false, "routing"), "rewrite");
    assert.equal(pick(true, true, false, "rewrite"), "routing");
    // All three take turns.
    assert.equal(pick(true, true, true, "routing"), "rewrite");
    assert.equal(pick(true, true, true, "rewrite"), "coding");
    assert.equal(pick(true, true, true, "coding"), "routing");
    // A last target that is now off starts the turn again.
    assert.equal(pick(true, false, true, "rewrite"), "routing");
    assert.equal(pick(true, false, true, "routing"), "coding");
});

test("the coding prompts are about coding, and the generator keeps the shared rules", () => {
    assert.match(CODING_ROUTER_SYNTHESIZER_SYSTEM, /coding agent/);
    assert.match(CODING_ROUTER_SYNTHESIZER_SYSTEM, /Never|no real company/i);
    assert.match(CODING_ROUTER_GENERATOR_SYSTEM, /one request from a coding agent/);
    assert.doesNotMatch(CODING_ROUTER_GENERATOR_SYSTEM, /stock suggestion/);
    assert.doesNotMatch(CODING_ROUTER_GENERATOR_SYSTEM, /which model answers a chat message/);
    assert.match(CODING_ROUTER_GENERATOR_SYSTEM, /taskEvaluation/);
    assert.match(CODING_ROUTER_GENERATOR_SYSTEM, /liveRouting/);
    assert.match(CODING_ROUTER_GENERATOR_SYSTEM, /Leave settingChanges empty/);
    assert.match(CODING_ROUTER_GENERATOR_SYSTEM, /does not license naming a model/, "a synthetic-only cycle names no model");
    // Every other line of the shared instructions is kept as written.
    const shared = AUTO_ROUTER_GENERATOR_SYSTEM.split("\n").filter((line) => !/chat message|stock suggestion/.test(line));
    for (const line of shared) assert.ok(CODING_ROUTER_GENERATOR_SYSTEM.includes(line), line.slice(0, 60));
    assert.match(CODING_ROUTER_JUDGE_SYSTEM, /coding agent/);
    assert.ok(CODING_ROUTER_JUDGE_SYSTEM.endsWith(AUTO_ROUTER_JUDGE_OUTPUT_RULE));
    assert.ok(CODING_TASK_EVAL_BUDGET_SHARE > 0 && CODING_TASK_EVAL_BUDGET_SHARE < 1);
});

const at = (minutes) => new Date(Date.UTC(2026, 10, 20, 0, minutes));
const row = (extra) => ({
    createdAt: at(0),
    modelId: "deepseek-v4-pro",
    protocol: "chat_completions",
    routedBy: "router",
    routedHeld: false,
    routeConversation: "c1",
    errorCode: null,
    finishReason: "stop",
    credits: 1,
    ...extra,
});

test("the coding routing report counts what Smart Adaptive did, from receipts only", () => {
    const report = summarizeCodingRouting(
        [
            row({}),
            row({ createdAt: at(1), routedBy: "continued" }),
            row({ createdAt: at(2), routedBy: "continued", routedHeld: true }),
            row({ createdAt: at(3), modelId: "claude-sonnet-5-5", credits: 16, routeConversation: "c1" }),
            row({ createdAt: at(4), routedBy: "default", modelId: "gpt-6-luna", routeConversation: "c2", errorCode: "provider_error" }),
            row({ createdAt: at(5), routedBy: null, modelId: "gpt-6-2-sol", routeConversation: null }),
        ],
        { since: at(0), until: at(10) }
    );
    assert.equal(report.requests, 5, "named-model requests are counted apart");
    assert.equal(report.namedRequests, 1);
    assert.deepEqual(report.byRoutedBy, { router: 2, continued: 2, default: 1 });
    assert.equal(report.heldShare, 0.2);
    assert.equal(report.byModel[0].modelId, "deepseek-v4-pro");
    assert.equal(report.topModelShare, 0.6);
    assert.deepEqual(report.conversations, { count: 2, meanRequests: 2.5, withModelChange: 1 });
    assert.equal(report.errorShare, 0.2);
    assert.deepEqual(report.errors, [{ code: "provider_error", count: 1 }]);
    assert.equal(report.credits, 1 + 1 + 1 + 16 + 1);
    assert.equal(report.window.since, at(0).toISOString());
    const empty = summarizeCodingRouting([], { since: at(0), until: at(10) });
    assert.equal(empty.requests, 0);
    assert.equal(empty.topModelShare, 0);
});

test("the generator's coding evidence is counts and model ids, never text", () => {
    const report = summarizeCodingRouting([row({})], { since: at(0), until: at(10) });
    const evidence = JSON.parse(
        codingGeneratorEvidence({
            taskEvaluation: [{ modelId: "deepseek-v4-pro", tasks: 6, passed: 2, byDifficulty: { hard: { tasks: 2, passed: 0 } } }],
            liveRouting: report,
        })
    );
    assert.match(evidence.evidenceOrigin, /pre-cycle/);
    assert.deepEqual(Object.keys(evidence.taskEvaluation[0]).sort(), ["byDifficulty", "modelId", "passed", "tasks"]);
    assert.equal(evidence.liveRouting.topModelShare, 1);
    assert.ok(!("errors" in evidence.liveRouting), "error codes stay in Admin");
    assert.equal(JSON.parse(codingGeneratorEvidence({ taskEvaluation: [], liveRouting: null })).liveRouting, null);
});

test("model-written code runs only on a runner the operator marked isolated", () => {
    assert.equal(codingTaskEvalRunnerIsolated({}), false);
    assert.equal(codingTaskEvalRunnerIsolated({ CODING_TASK_EVAL_ISOLATED_RUNNER: "TRUE" }), false);
    assert.equal(codingTaskEvalRunnerIsolated({ CODING_TASK_EVAL_ISOLATED_RUNNER: "true" }), true);
});

test("the task evaluation's calls count in the cycle's cost coverage", () => {
    const coverage = { complete: true, knownMicroUsd: 100, started: 4, completed: 4, knownCalls: 4, unknownCalls: 0, usagePricedCalls: 4, version: "optimizer-cost-v1" };
    const known = withTaskEvaluationCost(coverage, [{ known: true, microUsd: 30 }, { known: true, microUsd: 20 }]);
    assert.deepEqual(
        { ...known },
        { ...coverage, knownMicroUsd: 150, started: 6, completed: 6, knownCalls: 6, usagePricedCalls: 6 }
    );
    const unknown = withTaskEvaluationCost(coverage, [{ known: true, microUsd: 30 }, { known: false, microUsd: 500 }]);
    assert.equal(unknown.complete, false, "one unknown call leaves the coverage incomplete");
    assert.equal(unknown.unknownCalls, 1);
    assert.equal(unknown.knownMicroUsd, 130, "an unknown call's worst case is spend, not known cost");
    assert.equal(unknown.started, unknown.completed);
    assert.deepEqual(withTaskEvaluationCost(coverage, []), coverage);
});
