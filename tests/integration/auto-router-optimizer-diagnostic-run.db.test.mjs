import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

/**
 * A cost-efficiency diagnostic run (lib/autoRouterOptimizer.ts) against a
 * migrated local database: the start, audit, recording and provider spend are
 * real. Faked: the model calls (`ai`'s generateText) and the router call, so no
 * provider is reached. With automatic promotion and the optimizer's own
 * setting changes switched on, a diagnostic still promotes nothing and changes
 * no setting.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("a diagnostic cycle's run over the real cycle table", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    process.env.NEXTAUTH_SECRET ??= "diagnostic-optimizer-local-synthetic-secret";
    process.env.OPENAI_API_KEY ??= "sk-fixture-openai-server";
    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;
    const core = await import(mod("lib/autoRouterOptimizerCore.ts"));

    // The router: the frozen baseline picks the dearest candidate, the proposal the cheapest.
    const byCredits = (candidates, dir) =>
        [...candidates].sort((a, b) => dir * ((a.credits ?? 0) - (b.credits ?? 0)) || a.id.localeCompare(b.id))[0].id;
    const routed = [];
    mock.module(mod("lib/autoLlmRouter.ts"), {
        namedExports: {
            callAutoLlmRouter: async (input) => {
                routed.push(input.guidance);
                const baseline = input.guidance !== PROPOSAL;
                return { outcome: "picked", pick: { modelId: byCredits(input.candidates, baseline ? -1 : 1) }, usage: { inputTokens: 900, outputTokens: 30 } };
            },
            pickAutoModelWithLlm: async () => null,
        },
    });
    const PROPOSAL = "Send greetings and small talk to a lower-credit model.\nKeep hard reasoning on a higher tier.";
    const prompts = { synthesize: 0, generate: 0, answer: 0, quality: 0, legacyJudge: 0 };
    const real = await import("ai");
    mock.module("ai", {
        namedExports: {
            ...real,
            generateText: async (input) => {
                const usage = { inputTokens: 500, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 100 } };
                if (input.system === core.AUTO_ROUTER_SYNTHESIZER_SYSTEM) {
                    prompts.synthesize += 1;
                    const messages = Array.from({ length: 24 }, (_, index) => ({ text: `${index % 2 ? "hard proof" : "hello"} ${index}`, kind: index % 2 ? "hard" : "easy" }));
                    return { output: { messages }, finishReason: "stop", usage };
                }
                if (input.system === core.AUTO_ROUTER_GENERATOR_SYSTEM) {
                    prompts.generate += 1;
                    // A setting change the optimizer may apply on its own -- never from a diagnostic.
                    return { output: { findings: [], recommendations: [{ kind: "code", text: "x" }], guidance: PROPOSAL,
                        settingChanges: [{ setting: "router_timeout_ms", value: 5_000, reason: "r" }] }, finishReason: "stop", usage };
                }
                if (input.system === core.AUTO_ROUTER_QUALITY_JUDGE_SYSTEM) {
                    prompts.quality += 1;
                    return { output: { quality: "equal", constraintFailureA: false, constraintFailureB: false, reason: "r" }, finishReason: "stop", usage };
                }
                if (input.system === core.AUTO_ROUTER_JUDGE_SYSTEM) {
                    prompts.legacyJudge += 1;
                    return { output: { winner: "equal" }, finishReason: "stop", usage };
                }
                prompts.answer += 1;
                return { text: "an answer", finishReason: "stop", usage };
            },
        },
    });

    const { prisma } = await import(mod("lib/prisma.ts"));
    const { getRuntimeModels } = await import(mod("lib/modelRegistry.ts"));
    const optimizer = await import(mod("lib/autoRouterOptimizer.ts"));
    const { updateAutoLlmRouterModelId } = await import(mod("lib/autoLlmRouterSettings.ts"));
    const { autoLlmRouterModelAllowed } = await import(mod("lib/autoLlmRouterCore.ts"));
    const { readActiveRouterGuidance } = await import(mod("lib/autoLlmRouterGuidance.ts"));
    const { updateSettingAutoApply } = await import(mod("lib/autoRouterTunables.ts"));
    const { readAutoRouterTunables } = await import(mod("lib/autoRouterTunablesRead.ts"));

    const session = {
        user: { id: `diagnostic-run-${randomUUID()}`, email: "diagnostic-run@example.test" },
        expires: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer") };
    const models = await getRuntimeModels();
    const model = models.find((item) => item.enabled && item.provider === "openai" && autoLlmRouterModelAllowed(item) && optimizer.pricesOf(item));
    assert.ok(model, "a priced OpenAI model to route and optimize with");
    await optimizer.updateOptimizerModel(actor, model.id);
    await updateAutoLlmRouterModelId(actor, model.id);
    await optimizer.updateOptimizerAutomation(actor, { daily: true, autoPromote: true });
    await updateSettingAutoApply(actor, true);
    const before = process.env.AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC;
    const tunablesBefore = JSON.stringify(await readAutoRouterTunables());
    try {
        await prisma.autoRouterOptimizerCycle.deleteMany({});
        process.env.AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC = "on";
        await t.test("a person's diagnostic records a diagnostic-only result and promotes nothing", async () => {
            const started = await optimizer.startAutoRouterOptimizerCycle(actor, { waitForCompletion: true, objective: "chat_cost_efficiency" });
            assert.ok("cycleId" in started, JSON.stringify(started));
            assert.deepEqual(started.outcome, { recorded: true, status: "diagnostic", failure: null });
            const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycleId } });
            assert.equal(row.status, "diagnostic");
            assert.equal(row.promotedAt, null);
            assert.deepEqual(row.summary.objective, core.COST_EFFICIENCY_OBJECTIVE);
            assert.equal(row.summary.costEfficiency.version, "auto-cost-efficiency-report-v1");
            assert.equal(row.summary.manifest.execution, "live");
            assert.equal(row.summary.manifest.criteria.status, "proposed_unconfirmed");
            assert.ok(row.summary.manifest.models.answering.length > 0);
            // The price-blind judge only; cache reads were priced by the existing helper.
            assert.ok(prompts.quality > 0);
            assert.equal(prompts.legacyJudge, 0);
            const answerCall = row.summary.costCoverage.calls.find((call) => call.kind === "answer" && call.state === "known");
            assert.equal(answerCall.usage.cachedInputTokens, 100);
            assert.equal(answerCall.identity.objective, "chat_cost_efficiency");
            // No promotion, no setting change, no actionable recommendation, despite every switch being on.
            assert.equal((await readActiveRouterGuidance()).cycleId, null);
            assert.equal(JSON.stringify(await readAutoRouterTunables()), tunablesBefore);
            assert.equal(await prisma.adminAuditLog.count({ where: { targetId: row.id, action: "auto.llm_router_guidance.promoted" } }), 0);
            assert.deepEqual((await optimizer.promoteAutoRouterOptimizerCycle(row.id, actor)), { refused: "diagnostic_only" });
            const state = await optimizer.readAutoRouterOptimizerState();
            assert.equal(state.costEfficiencyDiagnostic.available, true);
            const shown = state.cycles.find((cycle) => cycle.id === row.id);
            assert.deepEqual(shown.promotionEligibility, { eligible: false, refusal: "diagnostic_only" });
            assert.deepEqual(shown.implementations, {});
            assert.notEqual(state.servingCost, undefined);
            // Spend reached the provider buckets like any cycle's.
            assert.ok(row.spentMicroUsd > 0);
        });
    } finally {
        if (before === undefined) delete process.env.AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC;
        else process.env.AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC = before;
        await optimizer.updateOptimizerAutomation(actor, { daily: false, autoPromote: false });
        await updateSettingAutoApply(actor, false);
        await prisma.autoRouterOptimizerCycle.deleteMany({});
        await prisma.$disconnect();
    }
});
