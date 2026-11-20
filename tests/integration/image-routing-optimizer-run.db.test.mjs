import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

/**
 * An image routing optimizer cycle's run (lib/imageRoutingOptimizer.ts)
 * against a migrated local database: the shared reservation, recording,
 * model and image provider spend are real. Faked: the routing call, the
 * optimizer model's text calls and the image evaluation, so no provider is
 * reached and no image is made.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
test("an image routing cycle's run over the real cycle table", { skip: !databaseUrl }, async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /test/);
    // The run's own audit key signs the rows this suite writes: never overwritten.
    process.env.NEXTAUTH_SECRET ??= "image-optimizer-local-synthetic-secret";
    process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "synthetic-image-optimizer-audit";
    process.env.OPENAI_API_KEY ??= "sk-fixture-openai-server";
    const root = resolve(import.meta.dirname, "../..");
    const mod = (path) => pathToFileURL(resolve(root, path)).href;

    const { CHAT_IMAGE_ROUTING_CRITERIA } = await import(mod("lib/chatImageIntentCore.ts"));
    const PROPOSAL = `${CHAT_IMAGE_ROUTING_CRITERIA}\n- a message about SVG, chart or diagram code is image=false.`;
    const candidates = [
        { id: "gpt-image-2", name: "GPT Image 2", credits: { standard: 70 } },
        { id: "flux-3-image", name: "FLUX 3", credits: { standard: 75 } },
    ];

    // The routing call: the current criteria route "SVG" messages to an image; the proposal does not.
    const probes = [];
    let probeUsage = () => ({ inputTokens: 900, outputTokens: 40 });
    const actualIntent = await import(mod("lib/chatImageIntent.ts"));
    mock.module(mod("lib/chatImageIntent.ts"), {
        namedExports: {
            ...actualIntent,
            chatImageTriageModelId: async () => routerModelId,
            chatImageRoutingCandidates: async () => candidates,
            probeChatImageRouting: async (input) => {
                probes.push(input);
                const usage = probeUsage();
                if (!usage) return { decision: { image: false }, usage: undefined, failed: true };
                const wantsImage = /그려|draw|poster|logo/i.test(input.text) || (input.criteria === CHAT_IMAGE_ROUTING_CRITERIA && /SVG/.test(input.text));
                return {
                    decision: wantsImage ? { image: true, modelId: "gpt-image-2", preset: "standard", prompt: null, edit: false } : { image: false },
                    usage,
                    failed: false,
                };
            },
        },
    });
    // The optimizer model's text calls, told apart by their instructions.
    const { IMAGE_INTENT_SYNTHESIZER_SYSTEM, IMAGE_CRITERIA_GENERATOR_SYSTEM } = await import(mod("lib/imageRoutingOptimizerCore.ts"));
    const intentCases = [];
    for (let index = 0; index < 12; index += 1) {
        intentCases.push({ text: `고양이 ${index} 그려줘`, expectImage: true, kind: "clear" });
        intentCases.push({ text: `이 SVG 코드 ${index} 고쳐줘`, expectImage: false, kind: "near_miss" });
    }
    const actualAi = await import("ai");
    mock.module("ai", {
        namedExports: {
            ...actualAi,
            generateText: async (options) => {
                const output =
                    options.system === IMAGE_INTENT_SYNTHESIZER_SYSTEM
                        ? { cases: intentCases }
                        : options.system === IMAGE_CRITERIA_GENERATOR_SYSTEM
                          ? { findings: ["SVG 코드 요청을 이미지로 보냈습니다."], recommendations: [], criteria: PROPOSAL }
                          : { requests: [{ text: "선명한 글자가 들어간 콘서트 포스터를 그려줘", category: "text_poster" }] };
                return { output, usage: { inputTokens: 2_000, outputTokens: 500 }, finishReason: "stop" };
            },
        },
    });
    // The image evaluation: one case, and an image whose cost is reported or not.
    let imageCostKnown = true;
    let evalRuns = 0;
    mock.module(mod("lib/imageRoutingModelEval.ts"), {
        namedExports: {
            runImageModelEval: async (input) => {
                evalRuns += 1;
                await input.pickFor(input.requests[0]);
                if (!(await input.shouldContinue(53_000))) return { cases: [], stopped: true, unfinished: 1 };
                await input.onCost({ kind: "image", provider: "openai", modelId: "gpt-image-2", microUsd: 53_000, known: imageCostKnown });
                return {
                    cases: [
                        {
                            category: "text_poster",
                            pick: { modelId: "gpt-image-2", generated: true, costMicroUsd: 53_000, durationMs: 9_000 },
                            challenger: { modelId: "flux-3-image", generated: true, costMicroUsd: 48_000, durationMs: 6_000 },
                            outcome: "pick_win",
                            failure: null,
                        },
                    ],
                    stopped: false,
                    unfinished: 0,
                };
            },
            imageWorstCaseMicroUsd: () => 58_000,
        },
    });

    const { prisma } = await import(mod("lib/prisma.ts"));
    const { getRuntimeModels } = await import(mod("lib/modelRegistry.ts"));
    const { pricesOf, updateOptimizerModel } = await import(mod("lib/autoRouterOptimizer.ts"));
    const { autoLlmRouterModelAllowed } = await import(mod("lib/autoLlmRouterCore.ts"));
    const { startImageRoutingOptimizerCycle, updateImageOptimizerAutomation, promoteImageRoutingOptimizerCycle } = await import(
        mod("lib/imageRoutingOptimizer.ts")
    );
    const session = { user: { id: `image-run-${randomUUID()}`, email: "image-run@example.test" }, expires: new Date(Date.now() + 3_600_000).toISOString() };
    const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/image-optimizer") };
    const models = await getRuntimeModels();
    const routerModel = models.find((model) => model.enabled && model.provider === "openai" && autoLlmRouterModelAllowed(model) && pricesOf(model));
    assert.ok(routerModel);
    const routerModelId = routerModel.id;
    await updateOptimizerModel(actor, routerModel.id);
    const spendBefore = await prisma.chatUsageBucket.findMany({ where: { OR: [{ key: { startsWith: "provider:" } }, { key: { startsWith: "image-provider:" } }] } });
    const reset = async () => {
        await prisma.autoRouterOptimizerCycle.deleteMany({});
        probes.length = 0;
        evalRuns = 0;
        probeUsage = () => ({ inputTokens: 900, outputTokens: 40 });
        imageCostKnown = true;
    };
    const run = async () => {
        const started = await startImageRoutingOptimizerCycle(actor, { waitForCompletion: true });
        assert.ok("cycleId" in started, JSON.stringify(started));
        return prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycleId } });
    };

    try {
        await t.test("text only: the proposal fixes the near misses, passes, and can be promoted", async () => {
            await reset();
            const row = await run();
            assert.equal(evalRuns, 0, "no image is made with the image evaluation off");
            assert.equal(row.status, "passed", JSON.stringify({ failure: row.failure, summary: row.summary }));
            assert.equal(row.candidateGuidance, PROPOSAL);
            assert.equal(row.summary.costComplete, true);
            assert.ok(row.summary.intent.candidate.correct > row.summary.intent.incumbent.correct);
            assert.equal(row.summary.intent.candidate.falseImage, 0);
            assert.ok(row.spentMicroUsd > 0);
            assert.ok(probes.every((probe) => probe.text.length > 0), "only synthetic messages are routed");
            assert.deepEqual(await promoteImageRoutingOptimizerCycle(row.id, actor), { ok: true });
            await prisma.appSetting.deleteMany({ where: { key: "auto.llmRouterImageGuidance" } });
        });

        await t.test("a routing call without usage stops the cycle as cost unknown, unpromotable", async () => {
            await reset();
            probeUsage = () => null;
            const row = await run();
            assert.equal(row.status, "failed");
            assert.equal(row.failure, "cost_unknown");
            assert.equal(row.summary.costComplete, false);
            assert.ok(row.spentMicroUsd > 0, "charged its worst case, not free");
            assert.deepEqual(await promoteImageRoutingOptimizerCycle(row.id, actor), { refused: "not_passed" });
        });

        await t.test("the image evaluation runs only when switched on, and books images to the image budget", async () => {
            await reset();
            await updateImageOptimizerAutomation(actor, { daily: true, autoPromote: false, modelEval: true });
            const before = await prisma.chatUsageBucket.findFirst({ where: { key: "image-provider:openai", period: "provider-cost-day" } });
            const row = await run();
            assert.equal(evalRuns, 1);
            assert.equal(row.summary.mode, "intent_and_models");
            assert.equal(row.summary.modelEvaluation.models.length > 0, true);
            const after = await prisma.chatUsageBucket.findFirst({ where: { key: "image-provider:openai", period: "provider-cost-day" } });
            assert.equal(Number(after?.count ?? 0) - Number(before?.count ?? 0), 53_000, "the image's cost, in the image provider's bucket");

            await reset();
            imageCostKnown = false;
            const unknown = await run();
            assert.equal(unknown.failure, "cost_unknown", "an image of unknown cost makes the cycle unpromotable");
            await updateImageOptimizerAutomation(actor, { daily: true, autoPromote: false, modelEval: false });
        });
    } finally {
        await prisma.autoRouterOptimizerCycle.deleteMany({});
        await prisma.appSetting.deleteMany({
            where: { key: { in: ["auto.llmRouterOptimizerModelId", "auto.llmRouterImageGuidance", "auto.llmRouterImageOptimizerAutomation"] } },
        });
        await prisma.chatUsageBucket.deleteMany({ where: { OR: [{ key: { startsWith: "provider:" } }, { key: { startsWith: "image-provider:" } }] } });
        if (spendBefore.length) await prisma.chatUsageBucket.createMany({ data: spendBefore });
        await prisma.$disconnect();
    }
});
