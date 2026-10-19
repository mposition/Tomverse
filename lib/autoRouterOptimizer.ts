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
    AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
    autoLlmRouterUserMessage,
    buildAutoLlmRouterSystem,
    resolveAutoLlmRouterModel,
    type AutoLlmRouterCandidate,
    type AutoLlmRouterSession,
} from "@/lib/autoLlmRouterCore";
import {
    DEFAULT_ROUTER_GUIDANCE,
    readActiveRouterGuidance,
    writeActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import {
    AUTO_ROUTER_GENERATOR_SYSTEM,
    AUTO_ROUTER_GUIDANCE_MAX_CHARS,
    AUTO_ROUTER_JUDGE_SYSTEM,
    AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_MIN_EVAL,
    AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX,
    admitOptimizerReservation,
    autoRouterGeneratorMessage,
    autoRouterGeneratorSchema,
    autoRouterJudgeMessage,
    autoRouterJudgeSchema,
    callCostMicroUsd,
    parseJudgeWinner,
    promotedRouterGuidance,
    rolledBackRouterGuidance,
    runOptimizerCycle,
    splitOptimizerDecisions,
    worstCaseCallMicroUsd,
    type OptimizerDecision,
} from "@/lib/autoRouterOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { getProviderCostBudget } from "@/lib/providerCostBudget";
import { resolveModelPricing } from "@/lib/modelPricing";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * Runs, promotes and rolls back Auto router guidance cycles (Admin › Routing).
 *
 * The optimizer model setting is the switch. No row is off, and turning it on
 * in Admin is the owner's approval for the calls a cycle makes: every call is
 * paid from the provider budget, bounded by the CHAT-01 caps in
 * lib/autoRouterOptimizerCore.ts. A cycle only proposes; a person promotes.
 */
export const AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY = "auto.llmRouterOptimizerModelId";

const GENERATOR_MAX_OUTPUT_TOKENS = 1_200;
const GENERATOR_TIMEOUT_MS = 90_000;
const JUDGE_MAX_OUTPUT_TOKENS = 40;
const JUDGE_TIMEOUT_MS = 30_000;
/** A cycle still `running` after this was cut off by a restart. */
const STALE_RUNNING_MS = 15 * 60_000;
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

export async function writeOptimizerModelId(modelId: string | null): Promise<void> {
    if (modelId === null) {
        await prisma.appSetting.deleteMany({ where: { key: AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY } });
        return;
    }
    await prisma.appSetting.upsert({
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

export async function readOptimizerAutomation(): Promise<OptimizerAutomation> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY },
            select: { value: true },
        });
        const value = row ? (JSON.parse(row.value) as Partial<OptimizerAutomation>) : null;
        return { daily: value?.daily === true, autoPromote: value?.autoPromote === true };
    } catch {
        return { daily: false, autoPromote: false };
    }
}

export async function writeOptimizerAutomation(value: OptimizerAutomation): Promise<void> {
    if (!value.daily && !value.autoPromote) {
        await prisma.appSetting.deleteMany({ where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify({ daily: value.daily, autoPromote: value.autoPromote });
    await prisma.appSetting.upsert({
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

/** What cycles since `from` have used: running ones count their reservation. */
const usedSince = (
    cycles: readonly { createdAt: Date; status: string; reservedMicroUsd: number; spentMicroUsd: number }[],
    from: Date
) =>
    cycles
        .filter((cycle) => cycle.createdAt >= from)
        .reduce(
            (sum, cycle) =>
                sum + (cycle.status === "running"
                    ? Math.max(cycle.reservedMicroUsd, cycle.spentMicroUsd)
                    : cycle.spentMicroUsd),
            0
        );

const utcDayStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const utcMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Closes cycles cut off by a restart: their spend is unknown, so it is the reservation. */
async function closeStaleCycles(tx: Prisma.TransactionClient, now: Date) {
    const stale = await tx.autoRouterOptimizerCycle.findMany({
        where: { status: "running", createdAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
        select: { id: true, reservedMicroUsd: true },
    });
    for (const cycle of stale) {
        // Conditional as well as locked: only a row still running is closed.
        await tx.autoRouterOptimizerCycle.updateMany({
            where: { id: cycle.id, status: "running" },
            data: {
                status: "error",
                failure: "interrupted",
                spentMicroUsd: cycle.reservedMicroUsd,
                finishedAt: now,
            },
        });
    }
}

// The provider's own operational budget, shared with chat and memory
// extraction (docs/policy/credit-and-cost-limits.md): the same ChatUsageBucket
// keys, so an optimizer cycle can never spend what the provider budget no
// longer has, and what it spends shows up there.
const PROVIDER_DAY = "provider-cost-day";
const PROVIDER_MONTH = "provider-cost-month";

/** One provider's share of a cycle's reservation, and the buckets it went into. */
export type ProviderReservation = {
    provider: string;
    microUsd: number;
    dayStart: string;
    monthStart: string;
};

/**
 * Adds `amount` to a provider bucket. A positive amount with a limit is one
 * guarded statement (as lib/memoryExtractionProviderCost.ts does it): it
 * either fits under the limit or changes nothing. A negative amount gives
 * budget back, never below zero. A positive amount with no limit records an
 * overrun that has already happened, which the budget must see regardless.
 */
async function adjustProviderBucket(
    tx: Prisma.TransactionClient,
    provider: string,
    period: string,
    start: Date,
    limit: number | null,
    amount: number
): Promise<boolean> {
    const key = `provider:${provider}`;
    if (amount === 0) return true;
    if (amount < 0) {
        await tx.$executeRaw`
            UPDATE "ChatUsageBucket"
            SET "count" = GREATEST(0, "count" + ${amount}), "updatedAt" = NOW()
            WHERE "key" = ${key} AND "period" = ${period} AND "periodStart" = ${start}
        `;
        return true;
    }
    if (!Number.isSafeInteger(amount)) return false;
    if (limit === null) {
        await tx.$executeRaw`
            INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
            VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
            ON CONFLICT ("key", "period", "periodStart")
            DO UPDATE SET "count" = "ChatUsageBucket"."count" + ${amount}, "updatedAt" = NOW()
        `;
        return true;
    }
    if (amount > limit) return false;
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET "count" = "ChatUsageBucket"."count" + ${amount}, "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" <= ${limit - amount}
        RETURNING "count"
    `;
    return rows.length > 0;
}

class ProviderBudgetExhausted extends Error {}

type Reserved =
    | { refused: "already_running" | "run_cap" | "day_cap" | "month_cap" | "provider_budget" }
    | { cycle: { id: string; reservedMicroUsd: number } };

/**
 * The money step of starting a cycle: one at a time, within the optimizer's
 * run, day and month caps AND each provider's own day and month budget, and
 * the audit row commits with the cycle row -- a cycle never spends without a
 * record of who started it. A refusal by any provider bucket rolls the whole
 * transaction back. Exported for the database test; the route goes through
 * startAutoRouterOptimizerCycle.
 */
export async function reserveOptimizerCycle(input: {
    actor: OptimizerActor;
    optimizerModelId: string;
    routerModelId: string;
    incumbentGuidance: string;
    /** The cycle's worst case, split by the provider each call goes to. */
    providers: readonly { provider: string; microUsd: number }[];
    now?: Date;
    environment?: Record<string, string | undefined>;
}): Promise<Reserved> {
    const now = input.now ?? new Date();
    const dayStart = utcDayStart(now);
    const monthStart = utcMonthStart(now);
    const byProvider = new Map<string, number>();
    for (const share of input.providers) {
        byProvider.set(share.provider, (byProvider.get(share.provider) ?? 0) + Math.ceil(share.microUsd));
    }
    const worstCaseMicroUsd = [...byProvider.values()].reduce((sum, value) => sum + value, 0);
    try {
        return await prisma.$transaction(async (tx): Promise<Reserved> => {
            await takeAuditChainLock(tx);
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
            await closeStaleCycles(tx, now);
            const running = await tx.autoRouterOptimizerCycle.count({ where: { status: "running" } });
            if (running > 0) return { refused: "already_running" };
            const recent = await tx.autoRouterOptimizerCycle.findMany({
                where: { createdAt: { gte: monthStart } },
                select: { createdAt: true, status: true, reservedMicroUsd: true, spentMicroUsd: true },
            });
            const admitted = admitOptimizerReservation({
                worstCaseMicroUsd,
                spentTodayMicroUsd: usedSince(recent, dayStart),
                spentThisMonthMicroUsd: usedSince(recent, monthStart),
            });
            if ("refused" in admitted) return admitted;

            const reservations: ProviderReservation[] = [];
            for (const [provider, microUsd] of byProvider) {
                const budget = getProviderCostBudget(provider, input.environment ?? process.env);
                const fits =
                    (await adjustProviderBucket(tx, provider, PROVIDER_DAY, dayStart, budget.day, microUsd)) &&
                    (await adjustProviderBucket(tx, provider, PROVIDER_MONTH, monthStart, budget.month, microUsd));
                if (!fits) throw new ProviderBudgetExhausted();
                reservations.push({
                    provider,
                    microUsd,
                    dayStart: dayStart.toISOString(),
                    monthStart: monthStart.toISOString(),
                });
            }

            const cycle = await tx.autoRouterOptimizerCycle.create({
                data: {
                    status: "running",
                    optimizerModelId: input.optimizerModelId,
                    routerModelId: input.routerModelId,
                    incumbentGuidance: input.incumbentGuidance,
                    reservedMicroUsd: admitted.reservedMicroUsd,
                    providerReservations: reservations,
                },
                select: { id: true, reservedMicroUsd: true },
            });
            await writeOptimizerAudit(tx, input.actor, {
                action: "auto.llm_router_optimizer.cycle_started",
                targetId: cycle.id,
                summary: "Started an Auto router optimizer cycle.",
                metadata: { reservedMicroUsd: cycle.reservedMicroUsd },
            });
            return { cycle };
        });
    } catch (error) {
        if (error instanceof ProviderBudgetExhausted) return { refused: "provider_budget" };
        throw error;
    }
}

const parseReservations = (value: unknown): ProviderReservation[] =>
    Array.isArray(value)
        ? value.filter((item): item is ProviderReservation =>
              typeof item?.provider === "string" &&
              Number.isSafeInteger(item?.microUsd) &&
              typeof item?.dayStart === "string" &&
              typeof item?.monthStart === "string")
        : [];

/**
 * Records a finished cycle and settles each provider's buckets from what was
 * reserved to what was spent, in one transaction. Only a cycle still
 * `running` is settled: one already closed as interrupted keeps its full
 * reservation, because by then nobody knows what it spent.
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
            select: { status: true, providerReservations: true },
        });
        if (cycle?.status !== "running") return false;
        const closed = await tx.autoRouterOptimizerCycle.updateMany({
            where: { id: input.cycleId, status: "running" },
            data: input.data,
        });
        if (closed.count !== 1) return false;
        for (const reservation of parseReservations(cycle.providerReservations)) {
            const delta = (input.spentByProvider.get(reservation.provider) ?? 0) - reservation.microUsd;
            await adjustProviderBucket(tx, reservation.provider, PROVIDER_DAY, new Date(reservation.dayStart), null, delta);
            await adjustProviderBucket(tx, reservation.provider, PROVIDER_MONTH, new Date(reservation.monthStart), null, delta);
        }
        return true;
    });
}

export type OptimizerStartRefusal =
    | "optimizer_off"
    | "router_off"
    | "not_enough_decisions"
    | "pricing_unavailable"
    | "already_running"
    | "run_cap"
    | "day_cap"
    | "month_cap"
    | "provider_budget";

/**
 * Starts one cycle and returns at once; the calls run in the background and
 * the row is updated when they finish. Refusals cost nothing.
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
    const { train, evaluate } = splitOptimizerDecisions(decisions);
    if (evaluate.length < AUTO_ROUTER_OPTIMIZER_MIN_EVAL) return { refused: "not_enough_decisions" };

    const optimizerPrices = pricesOf(optimizerModel);
    const routerPrices = pricesOf(routerModel);
    if (!optimizerPrices || !routerPrices) return { refused: "pricing_unavailable" };

    const active = await readActiveRouterGuidance();
    // The longest proposal in bytes: admitted guidance is capped in
    // characters, and a three-byte character is the widest a single UTF-16
    // unit can be.
    const longestGuidance = "가".repeat(AUTO_ROUTER_GUIDANCE_MAX_CHARS);
    const longestId = (decision: OptimizerDecision) =>
        decision.candidates.reduce((id, candidate) => (candidate.id.length > id.length ? candidate.id : id), "");
    const worstCaseMicroUsd = {
        generate: worstCaseCallMicroUsd({
            inputText: AUTO_ROUTER_GENERATOR_SYSTEM + autoRouterGeneratorMessage(active.guidance, train),
            maxOutputTokens: GENERATOR_MAX_OUTPUT_TOKENS,
            ...optimizerPrices,
        }),
        route: Math.max(...evaluate.map((decision) =>
            worstCaseCallMicroUsd({
                inputText:
                    buildAutoLlmRouterSystem(longestGuidance) +
                    autoLlmRouterUserMessage(
                        decision.routerInput,
                        decision.routerContext,
                        decision.candidates,
                        decision.routerSession
                    ),
                maxOutputTokens: AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
                ...routerPrices,
            }))),
        judge: Math.max(...evaluate.map((decision) =>
            worstCaseCallMicroUsd({
                inputText:
                    AUTO_ROUTER_JUDGE_SYSTEM +
                    autoRouterJudgeMessage(decision, longestId(decision), longestId(decision)),
                maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
                ...optimizerPrices,
            }))),
    };
    const calls = evaluate.length * 2;

    const started = await reserveOptimizerCycle({
        actor,
        optimizerModelId: optimizerModel.id,
        routerModelId: routerModel.id,
        incumbentGuidance: active.guidance,
        providers: [
            {
                provider: optimizerModel.provider,
                microUsd: worstCaseMicroUsd.generate + calls * worstCaseMicroUsd.judge,
            },
            { provider: routerModel.provider, microUsd: calls * worstCaseMicroUsd.route },
        ],
    });
    if ("refused" in started) return started;

    void runInBackground({
        cycleId: started.cycle.id,
        budgetMicroUsd: started.cycle.reservedMicroUsd,
        decisions,
        incumbentGuidance: active.guidance,
        optimizerModel,
        routerModel,
        optimizerPrices,
        routerPrices,
        worstCaseMicroUsd,
    });
    return { cycleId: started.cycle.id };
}

async function runInBackground(input: {
    cycleId: string;
    budgetMicroUsd: number;
    decisions: OptimizerDecision[];
    incumbentGuidance: string;
    optimizerModel: AiModel;
    routerModel: AiModel;
    optimizerPrices: Prices;
    routerPrices: Prices;
    worstCaseMicroUsd: { generate: number; route: number; judge: number };
}) {
    const cost = (prices: Prices, worstCase: number, usage: { inputTokens?: number; outputTokens?: number } | undefined) =>
        callCostMicroUsd({
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            worstCaseMicroUsd: worstCase,
            ...prices,
        });
    try {
        const result = await runOptimizerCycle(
            { decisions: input.decisions, incumbentGuidance: input.incumbentGuidance },
            {
                budgetMicroUsd: input.budgetMicroUsd,
                worstCaseMicroUsd: input.worstCaseMicroUsd,
                generate: async (message) => {
                    const generated = await generateText({
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
                    });
                    const guidance = (generated.output as { guidance?: unknown } | null)?.guidance;
                    return {
                        value: typeof guidance === "string" ? guidance : null,
                        costMicroUsd: cost(input.optimizerPrices, input.worstCaseMicroUsd.generate, generated.usage),
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
                    });
                    return {
                        value: routed.pick?.modelId ?? null,
                        costMicroUsd: cost(input.routerPrices, input.worstCaseMicroUsd.route, routed.usage),
                    };
                },
                judge: async (message) => {
                    const generated = await generateText({
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
                    });
                    return {
                        value: parseJudgeWinner(generated.output),
                        costMicroUsd: cost(input.optimizerPrices, input.worstCaseMicroUsd.judge, generated.usage),
                    };
                },
            }
        );
        const spentByProvider = new Map<string, number>();
        const add = (provider: string, microUsd: number) =>
            spentByProvider.set(provider, (spentByProvider.get(provider) ?? 0) + microUsd);
        add(input.optimizerModel.provider, result.spentByKind.generate + result.spentByKind.judge);
        add(input.routerModel.provider, result.spentByKind.route);
        const recorded = await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: {
                status: result.status,
                failure: result.failure,
                candidateGuidance: result.candidateGuidance,
                cases: result.cases,
                summary: { ...result.summary, overrunCalls: result.overrunCalls },
                spentMicroUsd: result.spentMicroUsd,
                finishedAt: new Date(),
            },
            spentByProvider,
        });
        // Automatic promotion only of a result this cycle itself recorded, and
        // only through the same compare-and-set a person's click uses.
        const promotion =
            recorded && result.status === "passed" && (await readOptimizerAutomation()).autoPromote
                ? await promoteAutoRouterOptimizerCycle(input.cycleId, "system")
                : null;
        console.info(JSON.stringify({
            event: "auto_router_optimizer_cycle",
            cycleId: input.cycleId,
            recorded,
            autoPromoted: promotion ? ("ok" in promotion ? true : promotion.refused) : false,
            status: result.status,
            failure: result.failure,
            spentMicroUsd: result.spentMicroUsd,
            overrunCalls: result.overrunCalls,
            decided: result.summary.decided,
        }));
    } catch (error) {
        // Spend is unknown once the cycle cannot record its own result, so it
        // is booked as the full reservation and the provider buckets keep it;
        // nothing is retried.
        console.error(JSON.stringify({
            event: "auto_router_optimizer_cycle_failed",
            cycleId: input.cycleId,
            error: error instanceof Error ? error.name : "unknown",
        }));
        await prisma.autoRouterOptimizerCycle
            .updateMany({
                where: { id: input.cycleId, status: "running" },
                data: {
                    status: "error",
                    failure: "run_error",
                    spentMicroUsd: input.budgetMicroUsd,
                    finishedAt: new Date(),
                },
            })
            .catch(() => undefined);
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
    reservedMicroUsd: number;
    spentMicroUsd: number;
    promotedAt: string | null;
};

/** Everything Admin shows. No decision content: verdicts are counts. */
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
                summary: true, reservedMicroUsd: true, spentMicroUsd: true, promotedAt: true,
            },
        }),
        prisma.autoRouterOptimizerCycle.findMany({
            where: { createdAt: { gte: utcMonthStart(now) } },
            select: { createdAt: true, status: true, reservedMicroUsd: true, spentMicroUsd: true },
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
        cycles: cycles.map((cycle): OptimizerCycleView => ({
            ...cycle,
            createdAt: cycle.createdAt.toISOString(),
            finishedAt: cycle.finishedAt?.toISOString() ?? null,
            promotedAt: cycle.promotedAt?.toISOString() ?? null,
        })),
        spend: {
            todayMicroUsd: usedSince(monthCycles, utcDayStart(now)),
            monthMicroUsd: usedSince(monthCycles, utcMonthStart(now)),
            runCapMicroUsd: AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
            dayCapMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
            monthCapMicroUsd: AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
        },
    };
}
