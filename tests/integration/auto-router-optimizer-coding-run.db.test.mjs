import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

/**
 * A coding optimizer cycle's run (lib/autoCodingRouterOptimizer.ts,
 * runCodingCycle) against a migrated local database: the shared reservation,
 * recording and provider spend are real. Faked: the router call, the task
 * evaluation's agent runs and the cycle proper, so no provider is reached and
 * no model-written code runs. Each scenario checks what the cycle spent, what
 * it recorded and which paid steps it made.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("a coding cycle's run over the real cycle table", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    Object.assign(process.env, {
        NEXTAUTH_SECRET: "coding-optimizer-local-synthetic-secret",
        ADMIN_AUDIT_INTEGRITY_KEY: "synthetic-coding-optimizer-audit",
        OPENAI_API_KEY: "sk-fixture-openai-server",
        DEEPSEEK_API_KEY: "sk-fixture-deepseek-server",
    });
    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;

    // The router: `routerReply` answers each call.
    const routerCalls = [];
    let routerReply = () => ({ outcome: "error", pick: null, usage: undefined });
    mock.module(mod("lib/autoLlmRouter.ts"), {
        namedExports: {
            callAutoLlmRouter: async (input) => {
                routerCalls.push(input);
                return routerReply(input);
            },
            pickAutoModelWithLlm: async () => null,
        },
    });
    // The task evaluation's agent runs: `evalReply` gives each run's result.
    const evalRuns = [];
    let evalReply = () => null;
    mock.module(mod("lib/codingTaskEval.ts"), {
        namedExports: {
            runCodingEval: async (input) => {
                for (const model of input.models) {
                    if (!(await input.shouldContinue())) break;
                    const result = evalReply(input.tasks[0], model);
                    evalRuns.push({ taskId: input.tasks[0].id, modelId: model.id, limits: input.limits });
                    await input.onResult?.(result);
                }
                return [];
            },
        },
    });
    // The cycle proper: the real one, counted, with every paid call left
    // unsent, so it ends with too few cases and records its summary.
    let cycleRuns = 0;
    const core = await import(mod("lib/autoRouterOptimizerCore.ts"));
    const { optimizerCostFields } = await import(mod("lib/autoOptimizerCost.ts"));
    const unsent = async () => ({ value: null, ...optimizerCostFields({ state: "no_dispatch", reason: "model_unavailable" }), provider: "none" });
    mock.module(mod("lib/autoRouterOptimizerCore.ts"), {
        namedExports: {
            ...core,
            runOptimizerCycle: async (input, deps) => {
                cycleRuns += 1;
                return core.runOptimizerCycle(input, { ...deps, synthesize: unsent, generate: unsent, route: unsent, answer: unsent, judge: unsent });
            },
        },
    });

    const { prisma } = await import(mod("lib/prisma.ts"));
    const { getRuntimeModels } = await import(mod("lib/modelRegistry.ts"));
    const { pricesOf, updateOptimizerModel } = await import(mod("lib/autoRouterOptimizer.ts"));
    const { updateAutoLlmRouterModelId } = await import(mod("lib/autoLlmRouterSettings.ts"));
    const { autoLlmRouterModelAllowed } = await import(mod("lib/autoLlmRouterCore.ts"));
    const { startCodingRouterOptimizerCycle } = await import(mod("lib/autoCodingRouterOptimizer.ts"));

    const session = {
        user: { id: `coding-run-${randomUUID()}`, email: "coding-run@example.test" },
        expires: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/coding-optimizer") };
    const models = await getRuntimeModels();
    const routerModel = models.find(
        (model) => model.enabled && model.provider === "openai" && autoLlmRouterModelAllowed(model) && pricesOf(model)
    );
    assert.ok(routerModel, "a priced OpenAI model to route and optimize with");
    await updateOptimizerModel(actor, routerModel.id);
    await updateAutoLlmRouterModelId(actor, routerModel.id);

    const reset = async () => {
        await prisma.autoRouterOptimizerCycle.deleteMany({});
        routerCalls.length = 0;
        evalRuns.length = 0;
        cycleRuns = 0;
    };
    const run = async () => {
        const started = await startCodingRouterOptimizerCycle(actor, { waitForCompletion: true });
        assert.ok("cycleId" in started, JSON.stringify(started));
        return { ...started, row: await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycleId } }) };
    };
    const usage = { inputTokens: 1_200, outputTokens: 80 };
    const cheapest = (candidates) =>
        [...candidates].sort((a, b) => (a.credits ?? 0) - (b.credits ?? 0) || a.id.localeCompare(b.id))[0].id;

    try {
        await t.test("without an isolated runner, no model-written code runs and the cycle proper goes ahead", async () => {
            await reset();
            delete process.env.CODING_TASK_EVAL_ISOLATED_RUNNER;
            const { row } = await run();
            assert.equal(evalRuns.length, 0, "no agent run");
            assert.equal(routerCalls.length, 0, "no paid call for the evaluation");
            assert.equal(cycleRuns, 1);
            assert.equal(row.summary.taskEvaluationStop, "runner_not_isolated");
            assert.deepEqual(row.summary.taskEvaluation, []);
        });

        await t.test("an evaluation run whose usage is unknown stops the evaluation and the cycle", async () => {
            await reset();
            process.env.CODING_TASK_EVAL_ISOLATED_RUNNER = "true";
            routerReply = (input) => ({ outcome: "picked", pick: { modelId: cheapest(input.candidates) }, usage });
            evalReply = (task, model) => ({
                taskId: task.id, difficulty: task.difficulty, modelId: model.id, passed: false, steps: 3, durationMs: 10,
                inputTokens: 0, outputTokens: 0, failure: "timeout", usageUnknown: true,
            });
            const { row, outcome } = await run();
            assert.deepEqual(outcome, { recorded: true, status: "failed", failure: "cost_unknown" });
            assert.equal(evalRuns.length, 1, "the first unknown cost stops further runs");
            assert.equal(routerCalls.length, 1);
            assert.equal(cycleRuns, 0, "the cycle proper is not run on unconfirmable spend");
            assert.equal(row.status, "failed");
            assert.equal(row.failure, "cost_unknown");
            assert.equal(row.summary.taskEvaluationStop, "cost_unknown");
            assert.ok(row.spentMicroUsd > row.summary.taskEvaluationSpentMicroUsd - 1, "the evaluation's spend is the cycle's");
            assert.ok(row.spentMicroUsd > 1_000, "an unknown run is charged its worst case, not zero");
            assert.deepEqual(evalRuns[0].limits.maxSteps, 8, "the cycle's own evaluation limits");
        });

        await t.test("a router call that reports no usage is charged its worst case and stops the evaluation", async () => {
            await reset();
            process.env.CODING_TASK_EVAL_ISOLATED_RUNNER = "true";
            routerReply = (input) => ({ outcome: "picked", pick: { modelId: cheapest(input.candidates) }, usage: undefined });
            const { row } = await run();
            assert.equal(evalRuns.length, 0);
            assert.equal(routerCalls.length, 1);
            assert.equal(cycleRuns, 0);
            assert.equal(row.failure, "cost_unknown");
            assert.ok(row.spentMicroUsd > 0, "charged, not counted as free");
            const bucket = await prisma.chatUsageBucket.findFirst({ where: { key: `provider:${routerModel.provider}` } });
            assert.ok(bucket && Number(bucket.count) >= row.spentMicroUsd, "booked to the provider's spend");
        });

        await t.test("a router call reporting a negative or non-finite count is unknown, not free", async () => {
            for (const bad of [{ inputTokens: -50, outputTokens: 10 }, { inputTokens: Number.NaN, outputTokens: 10 }]) {
                await reset();
                process.env.CODING_TASK_EVAL_ISOLATED_RUNNER = "true";
                routerReply = (input) => ({ outcome: "picked", pick: { modelId: cheapest(input.candidates) }, usage: bad });
                const { row } = await run();
                assert.equal(row.failure, "cost_unknown", JSON.stringify(bad));
                assert.equal(evalRuns.length, 0);
                assert.ok(row.spentMicroUsd > 0);
                assert.equal(row.summary.costCoverage.complete, false);
            }
        });

        await t.test("known costs run every task, each run's cost counted as it ends", async () => {
            await reset();
            process.env.CODING_TASK_EVAL_ISOLATED_RUNNER = "true";
            routerReply = (input) => ({ outcome: "picked", pick: { modelId: cheapest(input.candidates) }, usage });
            evalReply = (task, model) => ({
                taskId: task.id, difficulty: task.difficulty, modelId: model.id, passed: task.difficulty === "easy", steps: 2,
                durationMs: 10, inputTokens: 2_000, outputTokens: 300, failure: null, usageUnknown: false,
            });
            const { row } = await run();
            assert.equal(cycleRuns, 1, "the cycle proper then runs on what is left");
            const stop = row.summary.taskEvaluationStop;
            assert.ok(stop === null || stop === "budget", `stopped only by the budget, not ${stop}`);
            if (stop === null) assert.equal(routerCalls.length, 6, "one router call per task");
            assert.ok(evalRuns.length >= routerCalls.length - 1, "each routed task was worked");
            assert.equal(row.summary.taskEvaluation.reduce((sum, item) => sum + item.tasks, 0), evalRuns.length);
            assert.ok(row.summary.taskEvaluationSpentMicroUsd > 0);
            assert.ok(row.spentMicroUsd >= row.summary.taskEvaluationSpentMicroUsd);
            assert.equal(row.summary.costCoverage.complete, true, "every evaluation cost known");
        });
    } finally {
        delete process.env.CODING_TASK_EVAL_ISOLATED_RUNNER;
        await prisma.autoRouterOptimizerCycle.deleteMany({});
        await prisma.$disconnect();
    }
});
