import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { writeAutoRouterOptimizerSystemAudit } from "@/lib/autoRouterOptimizerSystemAudit";
import { callAutoLlmRouter } from "@/lib/autoLlmRouter";
import {
    AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
    autoLlmRouterCandidates,
    resolveAutoLlmRouterModel,
    type AutoLlmRouterCandidate,
    type AutoLlmRouterSession,
} from "@/lib/autoLlmRouterCore";
import { autoCohortConfig } from "@/lib/autoCohort";
import { preflightInputEstimate } from "@/lib/autoDispatchPreflight";
import { decideRouterModel } from "@/lib/routerDecision";
import { getRouterRuntimeSignals } from "@/lib/routerRuntimeSignals";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import {
    DEFAULT_ROUTER_GUIDANCE,
    readActiveRouterGuidance,
    writeActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import {
    AUTO_ROUTER_GENERATOR_SYSTEM,
    AUTO_ROUTER_JUDGE_SYSTEM,
    AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX,
    AUTO_ROUTER_OPTIMIZER_STALE_RUNNING_MS,
    AUTO_ROUTER_SYNTHESIZER_SYSTEM,
    optimizerCycleView,
    admitOptimizerCycle,
    autoRouterAnswerSystem,
    autoRouterGeneratorSchema,
    autoRouterJudgeSchema,
    autoRouterSynthesizerSchema,
    callCostMicroUsd,
    parseJudgeWinner,
    promotedRouterGuidance,
    rolledBackRouterGuidance,
    runOptimizerCycle,
    guidanceRejection,
    optimizerCallFailureDetail,
    syntheticCaseViews,
    type OptimizerCallKind,
    type OptimizerDecision,
    type SyntheticCaseView,
} from "@/lib/autoRouterOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";
import { DEFAULT_MODEL_ID, type AiModel, type ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * Runs, promotes and rolls back Auto router guidance cycles (Admin › Routing).
 *
 * The optimizer model setting is the switch. No row is off, and turning it on
 * in Admin is the owner's approval for the calls a cycle makes -- including
 * the synthetic messages and the picked models' answers (owner, 2026-10-20):
 * every call is recorded in its provider's budget and bounded by the CHAT-01
 * caps in lib/autoRouterOptimizerCore.ts, judged on actual spend (owner,
 * 2026-10-19: no worst-case reservation). A cycle only proposes; a person, or
 * the owner-enabled automatic promotion, promotes.
 */
export const AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY = "auto.llmRouterOptimizerModelId";

/**
 * Room for the longest admitted guidance in any script plus its JSON wrapper:
 * 3 000 characters of Korean can take more than 4 000 tokens. At 1 200 the
 * first Test cycle (2026-10-19, Claude Opus 4.8) threw before admission.
 */
const GENERATOR_MAX_OUTPUT_TOKENS = 6_000;
const GENERATOR_TIMEOUT_MS = 90_000;
/** Room for up to 24 messages of a few hundred characters each. */
const SYNTHESIZER_MAX_OUTPUT_TOKENS = 8_000;
const SYNTHESIZER_TIMEOUT_MS = 150_000;
/** An answer long enough to judge, not a full reply (owner, 2026-10-20). */
/**
 * A reasoning model spends its output budget on reasoning first: on Test
 * (2026-10-20) deepseek-v4-pro used all of 1 500 and returned no text.
 */
const ANSWER_MAX_OUTPUT_TOKENS = 4_000;
const ANSWER_TIMEOUT_MS = 60_000;
/** Room for a model that writes anything before the one-word object. */
const JUDGE_MAX_OUTPUT_TOKENS = 400;
const JUDGE_TIMEOUT_MS = 30_000;
/** A cycle still `running` after this was cut off by a restart. */
const STALE_RUNNING_MS = AUTO_ROUTER_OPTIMIZER_STALE_RUNNING_MS;
const OPTIMIZER_LOCK = "auto-router-optimizer";

export async function readOptimizerModelId(): Promise<string | null> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY },
            select: { value: true },
        });
        const value = row?.value.trim();
        return value ? value : null;
    } catch {
        return null;
    }
}

async function writeOptimizerModelId(tx: Prisma.TransactionClient, modelId: string | null): Promise<void> {
    if (modelId === null) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY } });
        return;
    }
    await tx.appSetting.upsert({
        where: { key: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY },
        create: { key: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY, value: modelId },
        update: { value: modelId },
    });
}

/**
 * What the optimizer may do without a click: start one cycle a day (from the
 * daily maintenance run) and promote a cycle that passed. Both off by default;
 * no row is off. Every automatic step is audited as the system actor, and
 * promotion still goes through the same compare-and-set as a person's click,
 * so rollback undoes it the same way.
 */
export const AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY = "auto.llmRouterOptimizerAutomation";

export type OptimizerAutomation = { daily: boolean; autoPromote: boolean };

export async function readOptimizerAutomation(
    db: Pick<Prisma.TransactionClient, "appSetting"> = prisma
): Promise<OptimizerAutomation> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY },
            select: { value: true },
        });
        const value = row ? (JSON.parse(row.value) as Partial<OptimizerAutomation>) : null;
        return { daily: value?.daily === true, autoPromote: value?.autoPromote === true };
    } catch {
        return { daily: false, autoPromote: false };
    }
}

async function writeOptimizerAutomation(
    tx: Prisma.TransactionClient,
    value: OptimizerAutomation
): Promise<void> {
    if (!value.daily && !value.autoPromote) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify({ daily: value.daily, autoPromote: value.autoPromote });
    await tx.appSetting.upsert({
        where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY },
        create: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY, value: stored },
        update: { value: stored },
    });
}

/**
 * The daily maintenance run's step: one cycle when the daily switch is on.
 * Off, or any refusal, starts nothing and costs nothing.
 */
export async function runScheduledAutoRouterOptimizerCycle(): Promise<
    { started: false; reason: "daily_off" | OptimizerStartRefusal } | { started: true; cycleId: string }
> {
    if (!(await readOptimizerAutomation()).daily) return { started: false, reason: "daily_off" };
    const result = await startAutoRouterOptimizerCycle("system");
    return "refused" in result
        ? { started: false, reason: result.refused }
        : { started: true, cycleId: result.cycleId };
}

type Prices = { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };

/** Null when the price cannot be resolved; a cycle then does not start. */
const pricesOf = (model: AiModel): Prices | null => {
    try {
        const pricing = resolveModelPricing(model);
        const prices = {
            inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        };
        return Number.isFinite(prices.inputUsdPerMillionTokens) &&
            Number.isFinite(prices.outputUsdPerMillionTokens) &&
            prices.inputUsdPerMillionTokens > 0 &&
            prices.outputUsdPerMillionTokens > 0
            ? prices
            : null;
    } catch {
        return null;
    }
};

const isCandidate = (value: unknown): value is AutoLlmRouterCandidate => {
    const candidate = value as Partial<AutoLlmRouterCandidate> | null;
    return (
        typeof candidate?.id === "string" &&
        typeof candidate.name === "string" &&
        typeof candidate.bestFor === "string" &&
        typeof candidate.tier === "string"
    );
};

const asSession = (value: unknown): AutoLlmRouterSession | null => {
    const session = value as Partial<AutoLlmRouterSession> | null;
    return session && Array.isArray(session.recentPicks)
        ? { topic: typeof session.topic === "string" ? session.topic : null, recentPicks: session.recentPicks }
        : null;
};

async function loadDecisions(): Promise<OptimizerDecision[]> {
    const rows = await prisma.autoRouterDecision.findMany({
        where: { outcome: "picked" },
        orderBy: { createdAt: "desc" },
        take: AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX,
        select: {
            id: true,
            routerInput: true,
            routerContext: true,
            routerSession: true,
            candidates: true,
            pickedModelId: true,
            reason: true,
        },
    });
    return rows.flatMap((row) => {
        const candidates = Array.isArray(row.candidates) ? row.candidates.filter(isCandidate) : [];
        if (candidates.length < 2) return [];
        return [{
            id: row.id,
            routerInput: row.routerInput,
            routerContext: row.routerContext,
            routerSession: asSession(row.routerSession),
            candidates,
            pickedModelId: row.pickedModelId,
            reason: row.reason,
        }];
    });
}

/** What cycles since `from` have actually spent. */
const spentSince = (cycles: readonly { createdAt: Date; spentMicroUsd: number }[], from: Date) =>
    cycles
        .filter((cycle) => cycle.createdAt >= from)
        .reduce((sum, cycle) => sum + cycle.spentMicroUsd, 0);

const utcDayStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const utcMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Closes cycles cut off by a restart. What they spent is unknown, so they
 * keep the spend they had recorded. Conditional as well as locked: only a
 * row still running is closed.
 */
async function closeStaleCycles(tx: Prisma.TransactionClient, now: Date) {
    await tx.autoRouterOptimizerCycle.updateMany({
        where: { status: "running", createdAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
        data: { status: "error", failure: "interrupted", finishedAt: now },
    });
}

// The provider's own operational budget, shared with chat and memory
// extraction (docs/policy/credit-and-cost-limits.md): the same ChatUsageBucket
// keys, so what an optimizer cycle spends shows up there.
const PROVIDER_DAY = "provider-cost-day";
const PROVIDER_MONTH = "provider-cost-month";

/**
 * Adds spend that has already happened to a provider bucket. No limit: the
 * money is gone, and the budget must see it regardless.
 */
async function addProviderSpend(
    tx: Prisma.TransactionClient,
    provider: string,
    period: string,
    start: Date,
    amount: number
) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const microUsd = Math.ceil(amount);
    await tx.$executeRaw`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${`provider:${provider}`}, ${period}, ${start}, ${microUsd}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET "count" = "ChatUsageBucket"."count" + ${microUsd}, "updatedAt" = NOW()
    `;
}

type Reserved =
    | { refused: "already_running" | "daily_done" | "day_cap" | "month_cap" }
    | { cycle: { id: string; budgetMicroUsd: number } };

/**
 * The money step of starting a cycle: one at a time, refused once the
 * optimizer's day or month cap is reached by actual spend, and the audit row
 * commits with the cycle row -- a cycle never spends without a record of who
 * started it. Nothing is reserved: the cycle's budget is the room left under
 * the caps. Exported for the database test; the route goes through
 * startAutoRouterOptimizerCycle.
 */
export async function reserveOptimizerCycle(input: {
    actor: OptimizerActor;
    optimizerModelId: string;
    routerModelId: string;
    incumbentGuidance: string;
    now?: Date;
}): Promise<Reserved> {
    const now = input.now ?? new Date();
    const dayStart = utcDayStart(now);
    const monthStart = utcMonthStart(now);
    return prisma.$transaction(async (tx): Promise<Reserved> => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        await closeStaleCycles(tx, now);
        const running = await tx.autoRouterOptimizerCycle.count({ where: { status: "running" } });
        if (running > 0) return { refused: "already_running" };
        // "One cycle a day" is a count, not only a spend cap: under the
        // same lock, the system may start at most one cycle per UTC day,
        // however often the maintenance run is retried.
        if (input.actor === "system") {
            const startedToday = await tx.autoRouterOptimizerCycle.count({
                where: { startedBy: "system", createdAt: { gte: dayStart } },
            });
            if (startedToday > 0) return { refused: "daily_done" };
        }
        const recent = await tx.autoRouterOptimizerCycle.findMany({
            where: { createdAt: { gte: monthStart } },
            select: { createdAt: true, spentMicroUsd: true },
        });
        const admitted = admitOptimizerCycle({
            spentTodayMicroUsd: spentSince(recent, dayStart),
            spentThisMonthMicroUsd: spentSince(recent, monthStart),
        });
        if ("refused" in admitted) return admitted;

        // reservedMicroUsd and providerReservations stay in the table for
        // older rows; a cycle reserves nothing now.
        const cycle = await tx.autoRouterOptimizerCycle.create({
            data: {
                status: "running",
                optimizerModelId: input.optimizerModelId,
                routerModelId: input.routerModelId,
                incumbentGuidance: input.incumbentGuidance,
                reservedMicroUsd: 0,
                startedBy: input.actor === "system" ? "system" : "person",
            },
            select: { id: true },
        });
        await writeOptimizerAudit(tx, input.actor, {
            action: "auto.llm_router_optimizer.cycle_started",
            targetId: cycle.id,
            summary: "Started an Auto router optimizer cycle.",
            metadata: { budgetMicroUsd: admitted.budgetMicroUsd },
        });
        return { cycle: { id: cycle.id, budgetMicroUsd: admitted.budgetMicroUsd } };
    });
}

/**
 * Records a finished cycle and adds what each provider was actually paid to
 * that provider's day and month buckets, in one transaction. Only a cycle
 * still `running` is recorded: one already closed as interrupted is left as
 * it is, and a second finish changes nothing.
 */
export async function finishOptimizerCycle(input: {
    cycleId: string;
    data: Prisma.AutoRouterOptimizerCycleUpdateManyMutationInput & { spentMicroUsd: number };
    spentByProvider: ReadonlyMap<string, number>;
}): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        // The same lock as the stale-cycle close in reserveOptimizerCycle, so a
        // finishing cycle and a close of it as interrupted cannot interleave.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: input.cycleId },
            select: { status: true, createdAt: true },
        });
        if (cycle?.status !== "running") return false;
        const closed = await tx.autoRouterOptimizerCycle.updateMany({
            where: { id: input.cycleId, status: "running" },
            data: input.data,
        });
        if (closed.count !== 1) return false;
        // Booked to the periods the cycle started in, as its caps count it.
        const dayStart = utcDayStart(cycle.createdAt);
        const monthStart = utcMonthStart(cycle.createdAt);
        for (const [provider, microUsd] of input.spentByProvider) {
            await addProviderSpend(tx, provider, PROVIDER_DAY, dayStart, microUsd);
            await addProviderSpend(tx, provider, PROVIDER_MONTH, monthStart, microUsd);
        }
        return true;
    });
}

export type OptimizerStartRefusal =
    | "optimizer_off"
    | "router_off"
    | "pricing_unavailable"
    | "already_running"
    | "daily_done"
    | "day_cap"
    | "month_cap";

const AUTO_PLANS_WIDEST_FIRST: readonly ModelTier[] = ["Max", "Pro", "Free"];

/**
 * The Auto candidates a signed-in account's turn would get for a message: the
 * same Router decision and credit estimate selectAutoModel
 * (lib/autoModelSelection.ts) makes for the chat route once the cohort, the
 * conversation's mode and attachments have let a turn through -- runtime
 * models, health and tie-break signals, no web search, the default model's
 * output cap. The plan is the widest the Auto cohort admits (Max when none is
 * configured), so the menu is the fullest one Auto offers.
 */
async function autoCandidateMenu(runtimeModels: readonly AiModel[]) {
    const models = runtimeModels.filter((model) => model.enabled && !model.catalogDeleted);
    const signals = await getRouterRuntimeSignals();
    const eligiblePlans = autoCohortConfig().eligiblePlans;
    const plan = AUTO_PLANS_WIDEST_FIRST.find((tier) => eligiblePlans.includes(tier)) ?? "Max";
    const requested = models.find((model) => model.id === DEFAULT_MODEL_ID) ?? models[0];
    const requestOutputCapTokens = requested ? resolveModelPricing(requested).maxOutputTokens : 0;
    const searchBackendReadiness = resolveWebSearchBackendReadiness();
    return (text: string): AutoLlmRouterCandidate[] => {
        const reservedInputTokens = preflightInputEstimate([{ role: "user", content: text }])
            .estimatedInputTokens;
        const decision = decideRouterModel({
            text,
            attachments: [],
            webSearchRequested: false,
            searchBackendReadiness,
            models,
            plan,
            reservedInputTokens,
            requestOutputCapTokens,
            unhealthyModelIds: signals.unhealthyModelIds,
            signals: signals.signals,
            sticky: null,
        });
        const estimate = estimateRequestCredits({
            models,
            estimatedInputTokens: reservedInputTokens,
            webSearchMode: "off",
            backendReadiness: searchBackendReadiness,
        });
        return autoLlmRouterCandidates(
            decision.record.eligibleModelIds,
            models,
            Object.fromEntries(estimate.models.map((model) => [model.modelId, model.totalCredits]))
        );
    };
}

/**
 * Starts one cycle and returns at once; the calls run in the background and
 * the row is updated when they finish. Refusals cost nothing. Too few recent
 * decisions is no longer a refusal: the cycle writes synthetic messages.
 */
export async function startAutoRouterOptimizerCycle(actor: OptimizerActor): Promise<
    { cycleId: string } | { refused: OptimizerStartRefusal }
> {
    const models = await getRuntimeModels();
    const optimizerModel = resolveAutoLlmRouterModel(models, (await readOptimizerModelId()) ?? undefined);
    if (!optimizerModel) return { refused: "optimizer_off" };
    const routerModel = resolveAutoLlmRouterModel(models, (await readAutoLlmRouterModelId()) ?? undefined);
    if (!routerModel) return { refused: "router_off" };

    const decisions = await loadDecisions();

    // Actual cost is priced from reported usage, so a cycle needs both prices.
    const optimizerPrices = pricesOf(optimizerModel);
    const routerPrices = pricesOf(routerModel);
    if (!optimizerPrices || !routerPrices) return { refused: "pricing_unavailable" };

    const active = await readActiveRouterGuidance();
    const started = await reserveOptimizerCycle({
        actor,
        optimizerModelId: optimizerModel.id,
        routerModelId: routerModel.id,
        incumbentGuidance: active.guidance,
    });
    if ("refused" in started) return started;

    void runInBackground({
        cycleId: started.cycle.id,
        budgetMicroUsd: started.cycle.budgetMicroUsd,
        decisions,
        incumbentGuidance: active.guidance,
        models,
        optimizerModel,
        routerModel,
        optimizerPrices,
        routerPrices,
    });
    return { cycleId: started.cycle.id };
}

async function runInBackground(input: {
    cycleId: string;
    budgetMicroUsd: number;
    decisions: OptimizerDecision[];
    incumbentGuidance: string;
    models: readonly AiModel[];
    optimizerModel: AiModel;
    routerModel: AiModel;
    optimizerPrices: Prices;
    routerPrices: Prices;
}) {
    // A failed call costs nothing in the cycle's count and otherwise leaves no
    // trace; its shape is logged so a failed cycle names its cause. Never the
    // content: synthetic messages and answers appear in logs by length only.
    const traced = async <T>(kind: OptimizerCallKind, run: () => Promise<T>) => {
        try {
            return await run();
        } catch (error) {
            console.warn(JSON.stringify({
                event: "auto_router_optimizer_call_failed",
                cycleId: input.cycleId,
                kind,
                ...optimizerCallFailureDetail(error),
            }));
            throw error;
        }
    };
    // `generated.output` throws when the text does not parse as the schema --
    // after the call was paid. Read here, outside `traced`, it used to make
    // the call count as failed with no log and no cost; now the cost stays
    // counted and the cause is logged (shape only, never the text).
    const outputOf = (
        kind: "synthesize" | "generate" | "judge",
        generated: { readonly output: unknown; finishReason: string; usage?: { outputTokens?: number } }
    ): unknown => {
        try {
            return generated.output;
        } catch (error) {
            console.warn(JSON.stringify({
                event: "auto_router_optimizer_output_unparsed",
                cycleId: input.cycleId,
                kind,
                finishReason: generated.finishReason,
                outputTokens: generated.usage?.outputTokens ?? null,
                ...optimizerCallFailureDetail(error),
            }));
            return null;
        }
    };
    const cost = (prices: Prices, usage: { inputTokens?: number; outputTokens?: number } | undefined) =>
        callCostMicroUsd({
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            ...prices,
        });
    // Answering models are looked up among the enabled ones only.
    const answerModels = new Map(
        input.models
            .filter((model) => model.enabled && !model.catalogDeleted)
            .map((model) => [model.id, model])
    );
    // What the cycle is known to have spent, for the recovery if recording fails.
    let known: { spentMicroUsd: number; spentByProvider: ReadonlyMap<string, number> } = {
        spentMicroUsd: 0,
        spentByProvider: new Map(),
    };
    try {
        const candidatesFor = await autoCandidateMenu(input.models);
        const result = await runOptimizerCycle(
            { decisions: input.decisions, incumbentGuidance: input.incumbentGuidance },
            {
                budgetMicroUsd: input.budgetMicroUsd,
                candidatesFor,
                synthesize: async (message) => {
                    const generated = await traced("synthesize", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: AUTO_ROUTER_SYNTHESIZER_SYSTEM,
                        prompt: message,
                        maxOutputTokens: SYNTHESIZER_MAX_OUTPUT_TOKENS,
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(SYNTHESIZER_TIMEOUT_MS),
                        output: Output.object({
                            schema: jsonSchema(autoRouterSynthesizerSchema() as unknown as JSONSchema7),
                            name: "router_test_messages",
                        }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    const output = outputOf("synthesize", generated);
                    const messages = (output as { messages?: unknown } | null)?.messages;
                    console.info(JSON.stringify({
                        event: "auto_router_optimizer_synthesized",
                        cycleId: input.cycleId,
                        finishReason: generated.finishReason,
                        messages: Array.isArray(messages) ? messages.length : null,
                    }));
                    return {
                        value: output,
                        costMicroUsd: cost(input.optimizerPrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
                generate: async (message) => {
                    const generated = await traced("generate", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: AUTO_ROUTER_GENERATOR_SYSTEM,
                        prompt: message,
                        maxOutputTokens: GENERATOR_MAX_OUTPUT_TOKENS,
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(GENERATOR_TIMEOUT_MS),
                        output: Output.object({
                            schema: jsonSchema(autoRouterGeneratorSchema() as unknown as JSONSchema7),
                            name: "router_guidance",
                        }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    const guidance = (outputOf("generate", generated) as { guidance?: unknown } | null)?.guidance;
                    const rejection = guidanceRejection(guidance);
                    if (rejection) {
                        console.warn(JSON.stringify({
                            event: "auto_router_optimizer_guidance_rejected",
                            cycleId: input.cycleId,
                            finishReason: generated.finishReason,
                            ...rejection,
                        }));
                    }
                    return {
                        value: typeof guidance === "string" ? guidance : null,
                        costMicroUsd: cost(input.optimizerPrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
                route: async (guidance, decision) => {
                    const routed = await callAutoLlmRouter({
                        routerModel: input.routerModel,
                        guidance,
                        prompt: decision.routerInput,
                        previousAnswer: decision.routerContext,
                        candidates: decision.candidates,
                        session: decision.routerSession,
                        timeoutMs: AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
                    });
                    return {
                        value: routed.pick?.modelId ?? null,
                        costMicroUsd: cost(input.routerPrices, routed.usage),
                        provider: input.routerModel.provider,
                    };
                },
                // The picked model answers as itself: its own provider, its
                // own price, no tools. Paid to that provider, which may be
                // neither the optimizer's nor the router's.
                answer: async (modelId, turn) => {
                    const model = answerModels.get(modelId);
                    const prices = model ? pricesOf(model) : null;
                    // No call without a price: its spend could not be recorded.
                    if (!model || !prices) {
                        return { value: null, costMicroUsd: 0, provider: model?.provider ?? "unknown" };
                    }
                    const generated = await traced("answer", () => generateText({
                        model: getActiveAiModel(model),
                        system: autoRouterAnswerSystem(turn.previousAnswer),
                        prompt: turn.message,
                        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
                    }));
                    if (!generated.text.trim()) {
                        console.warn(JSON.stringify({
                            event: "auto_router_optimizer_answer_empty",
                            cycleId: input.cycleId,
                            modelId,
                            finishReason: generated.finishReason,
                            outputTokens: generated.usage?.outputTokens ?? null,
                        }));
                    }
                    return {
                        value: generated.text,
                        costMicroUsd: cost(prices, generated.usage),
                        provider: model.provider,
                    };
                },
                judge: async (message) => {
                    const generated = await traced("judge", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: AUTO_ROUTER_JUDGE_SYSTEM,
                        prompt: message,
                        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
                        output: Output.object({
                            schema: jsonSchema(autoRouterJudgeSchema() as unknown as JSONSchema7),
                            name: "router_judgement",
                        }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    return {
                        value: parseJudgeWinner(outputOf("judge", generated)),
                        costMicroUsd: cost(input.optimizerPrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
            }
        );
        // Summed by the cycle from each call's own provider, answering models included.
        const spentByProvider = result.spentByProvider;
        known = { spentMicroUsd: result.spentMicroUsd, spentByProvider };
        const recorded = await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: {
                status: result.status,
                failure: result.failure,
                candidateGuidance: result.candidateGuidance,
                cases: result.cases,
                summary: { ...result.summary, failedCalls: result.failedCalls },
                spentMicroUsd: result.spentMicroUsd,
                finishedAt: new Date(),
            },
            spentByProvider,
        });
        // Automatic promotion only of a result this cycle itself recorded, and
        // only through the same compare-and-set a person's click uses.
        let promotion:
            | Awaited<ReturnType<typeof promoteAutoRouterOptimizerCycle>>
            | { refused: "promotion_error" }
            | null = null;
        if (recorded && result.status === "passed" && (await readOptimizerAutomation()).autoPromote) {
            // The cycle is already recorded; a failed promotion leaves it a
            // passed cycle a person can still promote.
            promotion = await promoteAutoRouterOptimizerCycle(input.cycleId, "system").catch(
                () => ({ refused: "promotion_error" as const })
            );
        }
        console.info(JSON.stringify({
            event: "auto_router_optimizer_cycle",
            cycleId: input.cycleId,
            recorded,
            autoPromoted: promotion ? ("ok" in promotion ? true : promotion.refused) : false,
            status: result.status,
            failure: result.failure,
            spentMicroUsd: result.spentMicroUsd,
            spentByKind: result.spentByKind,
            spentByProvider: Object.fromEntries(result.spentByProvider),
            failedCalls: result.failedCalls,
            syntheticCases: result.cases.filter((item) => item.source === "synthetic").length,
            decided: result.summary.decided,
            undecided: result.summary.undecided,
        }));
    } catch (error) {
        // The cycle could not record its own result. Nothing was reserved, so
        // the spend known by then goes to the row and the provider buckets
        // together, through the same compare-and-set as a normal finish: if
        // the first recording did commit, the cycle is no longer running and
        // this changes nothing. If this fails too, the amounts are in the log.
        console.error(JSON.stringify({
            event: "auto_router_optimizer_cycle_failed",
            cycleId: input.cycleId,
            error: error instanceof Error ? error.name : "unknown",
            knownSpentMicroUsd: known.spentMicroUsd,
            knownSpentByProvider: Object.fromEntries(known.spentByProvider),
        }));
        await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: {
                status: "error",
                failure: "run_error",
                spentMicroUsd: known.spentMicroUsd,
                finishedAt: new Date(),
            },
            spentByProvider: known.spentByProvider,
        }).catch(() => undefined);
    }
}

type AdminActor = { session: Session; request: Request };
/** A person in Admin, or the optimizer itself when its automation is on. */
export type OptimizerActor = AdminActor | "system";

const writeOptimizerAudit = (
    tx: Prisma.TransactionClient,
    actor: OptimizerActor,
    entry: {
        action: "auto.llm_router_optimizer.cycle_started" | "auto.llm_router_guidance.promoted";
        targetId: string;
        summary: string;
        metadata: Prisma.InputJsonObject;
    }
) =>
    actor === "system"
        ? writeAutoRouterOptimizerSystemAudit(tx, entry)
        : writeAdminAuditLog({ ...actor, tx, targetType: "AutoRouterOptimizerCycle", ...entry });

/** Makes a passed cycle's guidance the one the router uses. */
export async function promoteAutoRouterOptimizerCycle(
    cycleId: string,
    actor: OptimizerActor
): Promise<{ ok: true } | { refused: "not_found" | "not_passed" | "already_promoted" | "stale" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: cycleId },
            select: { status: true, candidateGuidance: true, incumbentGuidance: true, promotedAt: true },
        });
        if (!cycle) return { refused: "not_found" as const };
        if (cycle.promotedAt) return { refused: "already_promoted" as const };
        if (cycle.status !== "passed" || !cycle.candidateGuidance) return { refused: "not_passed" as const };
        const active = await readActiveRouterGuidance(tx);
        // The cycle measured its proposal against the guidance in force when
        // it ran. If that has changed since, the measurement is not about the
        // router as it is now.
        if (active.guidance !== cycle.incumbentGuidance) return { refused: "stale" as const };
        await writeActiveRouterGuidance(
            tx,
            promotedRouterGuidance(active, { guidance: cycle.candidateGuidance, cycleId })
        );
        await tx.autoRouterOptimizerCycle.update({ where: { id: cycleId }, data: { promotedAt: new Date() } });
        await writeOptimizerAudit(tx, actor, {
            action: "auto.llm_router_guidance.promoted",
            targetId: cycleId,
            summary: actor === "system"
                ? "Promoted Auto router guidance automatically from a passed cycle."
                : "Promoted Auto router guidance from an optimizer cycle.",
            metadata: { previousCycleId: active.cycleId },
        });
        return { ok: true as const };
    });
}

/** Returns the router to the guidance before the current one (or the default). */
export async function rollBackAutoRouterGuidance(
    actor: AdminActor
): Promise<{ ok: true } | { refused: "nothing_to_roll_back" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const active = await readActiveRouterGuidance(tx);
        const restored = rolledBackRouterGuidance(active, DEFAULT_ROUTER_GUIDANCE.guidance);
        if (!restored) return { refused: "nothing_to_roll_back" as const };
        await writeActiveRouterGuidance(tx, restored);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_guidance.rolled_back",
            targetType: "AutoRouterOptimizerCycle",
            targetId: active.cycleId,
            summary: "Rolled Auto router guidance back one step.",
            metadata: { restoredCycleId: restored.cycleId },
        });
        return { ok: true as const };
    });
}

export type OptimizerCycleView = {
    id: string;
    createdAt: string;
    finishedAt: string | null;
    status: string;
    failure: string | null;
    optimizerModelId: string;
    routerModelId: string;
    candidateGuidance: string | null;
    summary: unknown;
    spentMicroUsd: number;
    promotedAt: string | null;
    /** Messages the optimizer model wrote, with their picks and verdicts. */
    syntheticCases: SyntheticCaseView[];
};

/**
 * Everything Admin shows. No real decision content: a real decision is a
 * user's message, so its verdict is a count. Synthetic messages, which no user
 * wrote, are shown in full.
 */
export async function readAutoRouterOptimizerState() {
    const now = new Date();
    const [optimizerModelId, automation, active, cycles, monthCycles] = await Promise.all([
        readOptimizerModelId(),
        readOptimizerAutomation(),
        readActiveRouterGuidance(),
        prisma.autoRouterOptimizerCycle.findMany({
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
                id: true, createdAt: true, finishedAt: true, status: true, failure: true,
                optimizerModelId: true, routerModelId: true, candidateGuidance: true,
                summary: true, spentMicroUsd: true, promotedAt: true, cases: true,
            },
        }),
        prisma.autoRouterOptimizerCycle.findMany({
            where: { createdAt: { gte: utcMonthStart(now) } },
            select: { createdAt: true, spentMicroUsd: true },
        }),
    ]);
    return {
        optimizerModelId,
        automation,
        active: {
            cycleId: active.cycleId,
            guidance: active.guidance,
            canRollBack: active.cycleId !== null,
        },
        cycles: cycles.map(({ cases, ...cycle }): OptimizerCycleView => ({
            ...cycle,
            ...optimizerCycleView(cycle, now),
            syntheticCases: syntheticCaseViews(cases),
            createdAt: cycle.createdAt.toISOString(),
            finishedAt: cycle.finishedAt?.toISOString() ?? null,
            promotedAt: cycle.promotedAt?.toISOString() ?? null,
        })),
        spend: {
            todayMicroUsd: spentSince(monthCycles, utcDayStart(now)),
            monthMicroUsd: spentSince(monthCycles, utcMonthStart(now)),
            runCapMicroUsd: AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
            dayCapMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
            monthCapMicroUsd: AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
        },
    };
}

/**
 * Sets the optimizer model -- the switch, and the owner's approval for its
 * spending -- in one transaction with its audit entry, so the setting never
 * changes without a record of who changed it.
 */
export async function updateOptimizerModel(actor: AdminActor, modelId: string | null) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const row = await tx.appSetting.findUnique({
            where: { key: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY },
            select: { value: true },
        });
        const before = row?.value.trim() || null;
        await writeOptimizerModelId(tx, modelId);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_optimizer_model.updated",
            targetType: "AppSettings",
            targetId: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY,
            summary: modelId
                ? `Set the Auto router optimizer model to ${modelId}.`
                : "Turned the Auto router optimizer off.",
            metadata: { before, after: modelId },
        });
    });
}

/** Sets the automation switches in one transaction with their audit entry. */
export async function updateOptimizerAutomation(actor: AdminActor, after: OptimizerAutomation) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readOptimizerAutomation(tx);
        await writeOptimizerAutomation(tx, after);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_optimizer_automation.updated",
            targetType: "AppSettings",
            targetId: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
            summary: `Set the Auto router optimizer automation: daily ${after.daily ? "on" : "off"}, auto-promote ${after.autoPromote ? "on" : "off"}.`,
            metadata: { before, after },
        });
    });
}
