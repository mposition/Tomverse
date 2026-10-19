import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
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
    runOptimizerCycle,
    splitOptimizerDecisions,
    worstCaseCallMicroUsd,
    type OptimizerDecision,
} from "@/lib/autoRouterOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
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
        await tx.autoRouterOptimizerCycle.update({
            where: { id: cycle.id },
            data: {
                status: "error",
                failure: "interrupted",
                spentMicroUsd: cycle.reservedMicroUsd,
                finishedAt: now,
            },
        });
    }
}

type Reserved =
    | { refused: "already_running" | "day_cap" | "month_cap" }
    | { cycle: { id: string; reservedMicroUsd: number } };

/**
 * The money step of starting a cycle: one at a time, within the day and month
 * caps, and the audit row commits with the cycle row -- a cycle never spends
 * without a record of who started it. Exported for the database test; the
 * route goes through startAutoRouterOptimizerCycle.
 */
export async function reserveOptimizerCycle(input: {
    actor: AdminActor;
    optimizerModelId: string;
    routerModelId: string;
    incumbentGuidance: string;
    worstCaseMicroUsd: number;
    now?: Date;
}): Promise<Reserved> {
    const now = input.now ?? new Date();
    return prisma.$transaction(async (tx): Promise<Reserved> => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        await closeStaleCycles(tx, now);
        const running = await tx.autoRouterOptimizerCycle.count({ where: { status: "running" } });
        if (running > 0) return { refused: "already_running" };
        const recent = await tx.autoRouterOptimizerCycle.findMany({
            where: { createdAt: { gte: utcMonthStart(now) } },
            select: { createdAt: true, status: true, reservedMicroUsd: true, spentMicroUsd: true },
        });
        const admitted = admitOptimizerReservation({
            worstCaseMicroUsd: input.worstCaseMicroUsd,
            spentTodayMicroUsd: usedSince(recent, utcDayStart(now)),
            spentThisMonthMicroUsd: usedSince(recent, utcMonthStart(now)),
        });
        if ("refused" in admitted) return admitted;
        const cycle = await tx.autoRouterOptimizerCycle.create({
            data: {
                status: "running",
                optimizerModelId: input.optimizerModelId,
                routerModelId: input.routerModelId,
                incumbentGuidance: input.incumbentGuidance,
                reservedMicroUsd: admitted.reservedMicroUsd,
            },
            select: { id: true, reservedMicroUsd: true },
        });
        await writeAdminAuditLog({
            ...input.actor,
            tx,
            action: "auto.llm_router_optimizer.cycle_started",
            targetType: "AutoRouterOptimizerCycle",
            targetId: cycle.id,
            summary: "Started an Auto router optimizer cycle.",
            metadata: { reservedMicroUsd: cycle.reservedMicroUsd },
        });
        return { cycle };
    });
}

export type OptimizerStartRefusal =
    | "optimizer_off"
    | "router_off"
    | "not_enough_decisions"
    | "pricing_unavailable"
    | "already_running"
    | "day_cap"
    | "month_cap";

/**
 * Starts one cycle and returns at once; the calls run in the background and
 * the row is updated when they finish. Refusals cost nothing.
 */
export async function startAutoRouterOptimizerCycle(actor: AdminActor): Promise<
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
    const longestGuidance = "x".repeat(AUTO_ROUTER_GUIDANCE_MAX_CHARS);
    const worstCaseMicroUsd = {
        generate: worstCaseCallMicroUsd({
            inputChars:
                AUTO_ROUTER_GENERATOR_SYSTEM.length +
                autoRouterGeneratorMessage(active.guidance, train).length,
            maxOutputTokens: GENERATOR_MAX_OUTPUT_TOKENS,
            ...optimizerPrices,
        }),
        route: Math.max(...evaluate.map((decision) =>
            worstCaseCallMicroUsd({
                inputChars:
                    buildAutoLlmRouterSystem(longestGuidance).length +
                    autoLlmRouterUserMessage(
                        decision.routerInput,
                        decision.routerContext,
                        decision.candidates,
                        decision.routerSession
                    ).length,
                maxOutputTokens: AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
                ...routerPrices,
            }))),
        judge: Math.max(...evaluate.map((decision) =>
            worstCaseCallMicroUsd({
                inputChars:
                    AUTO_ROUTER_JUDGE_SYSTEM.length +
                    autoRouterJudgeMessage(decision, decision.candidates[0].id, decision.candidates[1].id).length,
                maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
                ...optimizerPrices,
            }))),
    };
    const cycleWorstCase =
        worstCaseMicroUsd.generate +
        evaluate.length * 2 * (worstCaseMicroUsd.route + worstCaseMicroUsd.judge);

    const started = await reserveOptimizerCycle({
        actor,
        optimizerModelId: optimizerModel.id,
        routerModelId: routerModel.id,
        incumbentGuidance: active.guidance,
        worstCaseMicroUsd: cycleWorstCase,
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
        await prisma.autoRouterOptimizerCycle.update({
            where: { id: input.cycleId },
            data: {
                status: result.status,
                failure: result.failure,
                candidateGuidance: result.candidateGuidance,
                cases: result.cases,
                summary: result.summary,
                spentMicroUsd: result.spentMicroUsd,
                finishedAt: new Date(),
            },
        });
        console.info(JSON.stringify({
            event: "auto_router_optimizer_cycle",
            cycleId: input.cycleId,
            status: result.status,
            failure: result.failure,
            spentMicroUsd: result.spentMicroUsd,
            decided: result.summary.decided,
        }));
    } catch (error) {
        // Spend is unknown once the cycle cannot record its own result, so it
        // is booked as the full reservation; nothing is retried.
        console.error(JSON.stringify({
            event: "auto_router_optimizer_cycle_failed",
            cycleId: input.cycleId,
            error: error instanceof Error ? error.name : "unknown",
        }));
        await prisma.autoRouterOptimizerCycle
            .update({
                where: { id: input.cycleId },
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

/** Makes a passed cycle's guidance the one the router uses. */
export async function promoteAutoRouterOptimizerCycle(
    cycleId: string,
    actor: AdminActor
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
        await writeActiveRouterGuidance(tx, {
            guidance: cycle.candidateGuidance,
            cycleId,
            previous: { guidance: active.guidance, cycleId: active.cycleId },
        });
        await tx.autoRouterOptimizerCycle.update({ where: { id: cycleId }, data: { promotedAt: new Date() } });
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_guidance.promoted",
            targetType: "AutoRouterOptimizerCycle",
            targetId: cycleId,
            summary: "Promoted Auto router guidance from an optimizer cycle.",
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
        if (active.cycleId === null) return { refused: "nothing_to_roll_back" as const };
        const restored = active.previous
            ? { guidance: active.previous.guidance, cycleId: active.previous.cycleId, previous: null }
            : DEFAULT_ROUTER_GUIDANCE;
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
    const [optimizerModelId, active, cycles, monthCycles] = await Promise.all([
        readOptimizerModelId(),
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
