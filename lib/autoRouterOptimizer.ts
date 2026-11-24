import "server-only";
import { observeOptimizerUsageCost, optimizerCostFields } from "@/lib/autoOptimizerCost";
import { COST_EFFICIENCY_CRITERIA } from "@/lib/autoCostEfficiencyReport";
import {
    buildAutoCandidateMenu,
    buildCostEfficiencyManifest,
    costEfficiencyCallPlan,
    COST_EFFICIENCY_OBSERVED_OUTPUT_DAYS,
    estimateAnswerMicroUsd,
    estimateAnswerOutputTokens,
    type ObservedOutputTokens,
} from "@/lib/autoCostEfficiencyPlan";
import { readAutoChatServingCost } from "@/lib/autoChatServingCost";
import { readResponseLatencyEvidence } from "@/lib/responseLatencyStore";
import { readChatPresearchLatency } from "@/lib/chatPresearchLatency";
import { readSmartAdaptiveDaily } from "@/lib/dailyProductAgentSmartAdaptive";
import { readDailyImplementations } from "@/lib/dailyProductImplementation";
import { taskImplementation, type DailyTaskImplementation } from "@/lib/dailyProductImplementationCore";
import { actionableRecommendations, recommendationStatusEntries } from "@/lib/autoRouterRecommendationsCore";

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
    AUTO_LLM_ROUTER_UNREPLAYABLE_CONTEXT,
    resolveAutoLlmRouterModel,
    type AutoLlmRouterCandidate,
    type AutoLlmRouterSession,
} from "@/lib/autoLlmRouterCore";
import { autoCohortConfig } from "@/lib/autoCohort";
import { getRouterRuntimeSignals } from "@/lib/routerRuntimeSignals";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import {
    DEFAULT_ROUTER_GUIDANCE,
    readActiveRouterGuidance,
    writeActiveRouterGuidance,
    type RouterGuidanceKind,
} from "@/lib/autoLlmRouterGuidance";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import {
    AUTO_ROUTER_GENERATOR_SYSTEM,
    AUTO_ROUTER_JUDGE_SYSTEM,
    AUTO_ROUTER_QUALITY_JUDGE_SYSTEM,
    AUTO_ROUTER_OPTIMIZER_TARGET_SAMPLE,
    autoRouterQualityJudgeSchema,
    COST_EFFICIENCY_OBJECTIVE,
    costEfficiencyDiagnosticOn,
    parseQualityJudgement,
    type OptimizerObjective,
    AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
    AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX,
    AUTO_ROUTER_OPTIMIZER_STALE_RUNNING_MS,
    AUTO_ROUTER_SYNTHESIZER_SYSTEM,
    optimizerCycleView,
    admitOptimizerCycle,
    autoRouterGeneratorSchema,
    autoRouterJudgeSchema,
    autoRouterSynthesizerSchema,
    optimizerPromotionEligibility,
    optimizerVerificationSummary,
    type OptimizerPromotionRefusal,
    parseJudgeWinner,
    promotedRouterGuidance,
    rolledBackRouterGuidance,
    runOptimizerCycle,
    guidanceRejection,
    optimizerAnswerOrBound,
    optimizerAnswerOptions,
    optimizerCallFailureDetail,
    traceOptimizerCall,
    summarizeRouterDecisions,
    unreliableAnswerModels,
    syntheticCaseViews,
    type OptimizerCallKind,
    type OptimizerDecision,
    type OptimizerRunOutcome,
    type RouterStats,
    type SyntheticCaseView,
} from "@/lib/autoRouterOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID, type AiModel, type ModelTier } from "@/lib/models";
import { OPTIMIZER_LOCK } from "@/lib/autoRouterOptimizerLock";
import { applyCycleTunableChanges, revertTunedTimeoutIfWorse } from "@/lib/autoRouterTunables";
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
/** The guidance plus the report written before it, in Korean. */
const GENERATOR_MAX_OUTPUT_TOKENS = 10_000;
const GENERATOR_TIMEOUT_MS = 150_000;
/** Room for up to 24 messages of a few hundred characters each. */
const SYNTHESIZER_MAX_OUTPUT_TOKENS = 8_000;
const SYNTHESIZER_TIMEOUT_MS = 150_000;
/** The router's recent decisions the generator's statistics are read from. */
const ROUTER_STATS_DAYS = 14;
const ROUTER_STATS_MAX_ROWS = 2_000;


/**
 * Room for a model that writes anything before the one-word object. On Test
 * (2026-10-20, cycle cmvgc2vrb) eight judge calls to claude-opus-5 ended at
 * 400 tokens with no object (finishReason length): the request carried no
 * thinking setting, and the tokens went before the object. The judge and the
 * synthesizer now ask for no reasoning (`reasoning: "none"`, which the
 * Anthropic provider sends as thinking disabled, or its lowest effort on a
 * model that refuses that) and the judge keeps this much room besides.
 */
const JUDGE_MAX_OUTPUT_TOKENS = 2_000;
const JUDGE_TIMEOUT_MS = 30_000;

/**
 * The one judge call of every optimizer cycle, routing and rewrite alike, so
 * their limits cannot drift apart again: no reasoning, room for the object,
 * one structured verdict. The caller's system prompt ends with
 * AUTO_ROUTER_JUDGE_OUTPUT_RULE.
 */
export const optimizerJudgeCall = (input: {
    model: AiModel; system: string; prompt: string; name: string;
    /** The price-blind rubric's object; the existing verdict object unless given. */
    schema?: Record<string, unknown>;
}) =>
    generateText({
        model: getActiveAiModel(input.model),
        system: input.system,
        prompt: input.prompt,
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
        reasoning: "none",
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
        output: Output.object({
            schema: jsonSchema((input.schema ?? autoRouterJudgeSchema()) as unknown as JSONSchema7),
            name: input.name,
        }),
        providerOptions: { openai: { strictJsonSchema: true } },
    });

/** A cycle still `running` after this was cut off by a restart. */
const STALE_RUNNING_MS = AUTO_ROUTER_OPTIMIZER_STALE_RUNNING_MS;
export { OPTIMIZER_LOCK };

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

/**
 * daily: one routing cycle a day (in turn with the other targets).
 * autoPromote: a passed routing cycle is promoted without a person.
 * costDiagnosticWeekly: the daily run spends one day a week on the
 * cost-efficiency diagnostic (owner, 2026-11-24). Diagnostic-only, never
 * promotes; needs AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC too. Off by default.
 */
export type OptimizerAutomation = { daily: boolean; autoPromote: boolean; costDiagnosticWeekly: boolean };

export async function readOptimizerAutomation(
    db: Pick<Prisma.TransactionClient, "appSetting"> = prisma
): Promise<OptimizerAutomation> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY },
            select: { value: true },
        });
        const value = row ? (JSON.parse(row.value) as Partial<OptimizerAutomation>) : null;
        return { daily: value?.daily === true, autoPromote: value?.autoPromote === true, costDiagnosticWeekly: value?.costDiagnosticWeekly === true };
    } catch {
        return { daily: false, autoPromote: false, costDiagnosticWeekly: false };
    }
}

async function writeOptimizerAutomation(
    tx: Prisma.TransactionClient,
    value: OptimizerAutomation
): Promise<void> {
    if (!value.daily && !value.autoPromote && !value.costDiagnosticWeekly) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify({ daily: value.daily, autoPromote: value.autoPromote, costDiagnosticWeekly: value.costDiagnosticWeekly });
    await tx.appSetting.upsert({
        where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY },
        create: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY, value: stored },
        update: { value: stored },
    });
}

/**
 * The daily run's step: one cycle when the daily switch is on. Off, or any
 * refusal, starts nothing and costs nothing. `waitForCompletion` runs the
 * cycle to its end before returning, with its outcome (the own-process
 * optimizer service); without it the cycle runs on in the background.
 */
/** How often the scheduled cost-efficiency diagnostic runs. */
export const COST_DIAGNOSTIC_INTERVAL_DAYS = 7;

/**
 * Whether today's system cycle is the weekly cost-efficiency diagnostic: its
 * Admin switch and its environment switch are on, and no diagnostic started
 * in the last COST_DIAGNOSTIC_INTERVAL_DAYS -- finished, failed, interrupted
 * or closed as run_error alike: the objective is recorded when it is reserved.
 */
export async function scheduledCostDiagnosticDue(at: Date = new Date()): Promise<boolean> {
    if (!costEfficiencyDiagnosticOn()) return false;
    if (!(await readOptimizerAutomation()).costDiagnosticWeekly) return false;
    return !(await costDiagnosticStartedWithin(prisma, at));
}

/** Any diagnostic, person- or system-started, in the last COST_DIAGNOSTIC_INTERVAL_DAYS. */
async function costDiagnosticStartedWithin(db: Pick<Prisma.TransactionClient, "autoRouterOptimizerCycle">, at: Date): Promise<boolean> {
    const recent = await db.autoRouterOptimizerCycle.findFirst({
        where: {
            target: "routing",
            createdAt: { gte: new Date(at.getTime() - COST_DIAGNOSTIC_INTERVAL_DAYS * 86_400_000) },
            OR: [
                { status: "diagnostic" },
                { summary: { path: ["objective", "id"], equals: COST_EFFICIENCY_OBJECTIVE.id } },
            ],
        },
        select: { id: true },
    });
    return recent !== null;
}

export async function runScheduledAutoRouterOptimizerCycle(options: { waitForCompletion?: boolean } = {}): Promise<
    | { started: false; reason: "daily_off" | OptimizerStartRefusal }
    | { started: true; cycleId: string; outcome?: OptimizerRunOutcome }
> {
    if (!(await readOptimizerAutomation()).daily) return { started: false, reason: "daily_off" };
    const result = await startAutoRouterOptimizerCycle("system", options);
    return "refused" in result
        ? { started: false, reason: result.refused }
        : { started: true, cycleId: result.cycleId, ...(result.outcome ? { outcome: result.outcome } : {}) };
}

export type Prices = { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };

/** Null when the price cannot be resolved; a cycle then does not start. */
export const pricesOf = (model: AiModel): Prices | null => {
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

export const isCandidate = (value: unknown): value is AutoLlmRouterCandidate => {
    const candidate = value as Partial<AutoLlmRouterCandidate> | null;
    return (
        typeof candidate?.id === "string" &&
        typeof candidate.name === "string" &&
        typeof candidate.bestFor === "string" &&
        typeof candidate.tier === "string"
    );
};

export const asSession = (value: unknown): AutoLlmRouterSession | null => {
    const session = value as Partial<AutoLlmRouterSession> | null;
    return session && Array.isArray(session.recentPicks)
        ? { topic: typeof session.topic === "string" ? session.topic : null, recentPicks: session.recentPicks }
        : null;
};

/**
 * A recorded menu is replayed against today's catalogue: a candidate that is
 * no longer enabled or priced could never answer (no_dispatch), so it is
 * neither picked nor drawn, and a decision left with fewer than two is not a
 * comparison. Without this, an old decision's retired picks used the run.
 */
export const answerableModelIds = (models: readonly AiModel[]) =>
    new Set(models.filter((model) => model.enabled && !model.catalogDeleted && pricesOf(model)).map((model) => model.id));

async function loadDecisions(answerable: ReadonlySet<string>): Promise<OptimizerDecision[]> {
    const rows = await prisma.autoRouterDecision.findMany({
        // Combined calls include image, location or search inputs that decision
        // rows do not retain. Do not claim to replay their full request.
        where: { outcome: "picked", NOT: AUTO_LLM_ROUTER_UNREPLAYABLE_CONTEXT.map(marker => ({ version: { contains: marker } })) },
        orderBy: { createdAt: "desc" },
        take: AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX,
        select: {
            id: true,
            conversationId: true,
            version: true,
            routerInput: true,
            routerContext: true,
            routerSession: true,
            candidates: true,
            pickedModelId: true,
            reason: true,
            taskKind: true,
        },
    });
    return rows.flatMap((row) => {
        const candidates = Array.isArray(row.candidates)
            ? row.candidates.filter(isCandidate).filter((candidate) => answerable.has(candidate.id))
            : [];
        if (candidates.length < 2) return [];
        return [{
            id: row.id,
            family: row.conversationId,
            taskKind: row.taskKind,
            inputVersion: row.version,
            routerInput: row.routerInput,
            routerContext: row.routerContext,
            routerSession: asSession(row.routerSession),
            candidates,
            pickedModelId: row.pickedModelId,
            reason: row.reason,
        }];
    });
}

/**
 * The router's recent behaviour for the generator: outcomes, fallbacks and
 * pick shares from the last two weeks of decisions. Counts only; null when
 * the read fails, and the cycle goes on without it.
 */
/**
 * Every model id the catalogue knows -- registry rows deleted from the
 * catalogue and the static catalogue included -- for the guidance naming
 * check: a name the menu no longer offers is caught however it is shaped.
 */
export async function optimizerCatalogueIds(): Promise<string[]> {
    const registered = await getRuntimeModels({ includeCatalogDeleted: true });
    return [...new Set([...registered, ...AVAILABLE_MODELS].map((model) => model.id))];
}

/**
 * Models whose answers all failed in the last finished cycle that recorded
 * answers, never drawn as the next cycle's direct challenger. Empty when
 * there is no such cycle or it cannot be read.
 */
export async function readUnreliableAnswerModels(): Promise<string[]> {
    try {
        // Searched in the database rather than among the last few rows: any
        // number of cycles that record no answers (rewrite cycles, older
        // routing ones) may have finished since.
        const rows = await prisma.$queryRaw<Array<{ answerStats: unknown }>>`
            SELECT "summary"->'answerStats' AS "answerStats"
            FROM "AutoRouterOptimizerCycle"
            WHERE "status" IN ('passed', 'failed', 'error')
              AND jsonb_typeof("summary"->'answerStats') = 'object'
              -- A cost-efficiency diagnostic, finished or failed, never shapes the routing cycle's draws.
              AND "summary"->'objective' IS NULL
            ORDER BY "createdAt" DESC
            LIMIT 1
        `;
        return rows[0] ? unreliableAnswerModels(rows[0].answerStats) : [];
    } catch {
        return [];
    }
}

async function readRouterStats(now: Date): Promise<RouterStats | null> {
    try {
        const since = new Date(now.getTime() - ROUTER_STATS_DAYS * 24 * 60 * 60_000);
        const rows = await prisma.autoRouterDecision.findMany({
            where: { createdAt: { gte: since, lte: now } },
            orderBy: { createdAt: "desc" },
            take: ROUTER_STATS_MAX_ROWS,
            select: { outcome: true, pickedModelId: true, ruleModelId: true, latencyMs: true },
        });
        return { ...summarizeRouterDecisions(rows), window: { source: "AutoRouterDecision", since: since.toISOString(), until: now.toISOString() } };
    } catch {
        return null;
    }
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
    /** `provider` for a model provider's bucket, `image-provider` for an image provider's. */
    bucket: "provider" | "image-provider",
    provider: string,
    period: string,
    start: Date,
    amount: number
) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const microUsd = Math.ceil(amount);
    await tx.$executeRaw`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${`${bucket}:${provider}`}, ${period}, ${start}, ${microUsd}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET "count" = "ChatUsageBucket"."count" + ${microUsd}, "updatedAt" = NOW()
    `;
}

type Reserved =
    | { refused: "already_running" | "daily_done" | "day_cap" | "month_cap" | "diagnostic_recent" }
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
    /** Which guidance the cycle improves; the lock and caps are shared by both. */
    target?: RouterGuidanceKind;
    /** Recorded with the start; absent is the existing routing-quality cycle. */
    objective?: OptimizerObjective;
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
            // The weekly check again, under the lock: a diagnostic a person
            // started after the schedule looked still holds the week.
            if (input.objective === "chat_cost_efficiency" && await costDiagnosticStartedWithin(tx, now)) {
                return { refused: "diagnostic_recent" };
            }
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
                target: input.target ?? "routing",
                // A diagnostic is one from its start: an interrupted or
                // run_error close keeps the summary, so the weekly schedule
                // still counts a paid run that never finished.
                ...(input.objective === "chat_cost_efficiency" ? { summary: { objective: COST_EFFICIENCY_OBJECTIVE } } : {}),
            },
            select: { id: true },
        });
        await writeOptimizerAudit(tx, input.actor, {
            action: "auto.llm_router_optimizer.cycle_started",
            targetId: cycle.id,
            summary: "Started an Auto router optimizer cycle.",
            metadata: {
                budgetMicroUsd: admitted.budgetMicroUsd, target: input.target ?? "routing",
                ...(input.objective && input.objective !== "routing_quality" ? { objective: input.objective } : {}),
            },
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
    /** What image providers were paid (an image cycle's evaluation), booked to their own buckets. */
    imageSpentByProvider?: ReadonlyMap<string, number>;
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
            await addProviderSpend(tx, "provider", provider, PROVIDER_DAY, dayStart, microUsd);
            await addProviderSpend(tx, "provider", provider, PROVIDER_MONTH, monthStart, microUsd);
        }
        for (const [provider, microUsd] of input.imageSpentByProvider ?? []) {
            await addProviderSpend(tx, "image-provider", provider, PROVIDER_DAY, dayStart, microUsd);
            await addProviderSpend(tx, "image-provider", provider, PROVIDER_MONTH, monthStart, microUsd);
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
    | "month_cap"
    /** The cost-efficiency diagnostic's default-off switch is off. */
    | "diagnostic_off"
    /** The system starts a diagnostic only while the weekly switch is on. */
    | "diagnostic_needs_person"
    /** The system's weekly diagnostic: one already started in the last 7 days. */
    | "diagnostic_recent";

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
export async function autoCandidateMenu(runtimeModels: readonly AiModel[]) {
    const signals = await getRouterRuntimeSignals();
    const eligiblePlans = autoCohortConfig().eligiblePlans;
    return buildAutoCandidateMenu({
        models: runtimeModels,
        plan: AUTO_PLANS_WIDEST_FIRST.find((tier) => eligiblePlans.includes(tier)) ?? "Max",
        requestedModelId: DEFAULT_MODEL_ID,
        searchBackendReadiness: resolveWebSearchBackendReadiness(),
        unhealthyModelIds: signals.unhealthyModelIds,
        signals: signals.signals,
    });
}

/**
 * Starts one cycle. By default it returns at once; the calls run in the
 * background and the row is updated when they finish (Admin's button). With
 * `waitForCompletion` it returns only when the cycle has finished and been
 * recorded, with the outcome -- the own-process optimizer service, which a
 * web redeploy cannot cut off. Refusals cost nothing. Too few recent
 * decisions is no longer a refusal: the cycle writes synthetic messages.
 */
export async function startAutoRouterOptimizerCycle(
    actor: OptimizerActor,
    options: { waitForCompletion?: boolean; objective?: OptimizerObjective } = {}
): Promise<{ cycleId: string; outcome?: OptimizerRunOutcome } | { refused: OptimizerStartRefusal }> {
    const objective = options.objective ?? "routing_quality";
    if (objective === "chat_cost_efficiency") {
        // The system starts one only while the owner's weekly switch is on.
        if (actor === "system" && !(await readOptimizerAutomation()).costDiagnosticWeekly) return { refused: "diagnostic_needs_person" };
        if (!costEfficiencyDiagnosticOn()) return { refused: "diagnostic_off" };
    }
    const models = await getRuntimeModels();
    const optimizerModel = resolveAutoLlmRouterModel(models, (await readOptimizerModelId()) ?? undefined);
    if (!optimizerModel) return { refused: "optimizer_off" };
    const routerModel = resolveAutoLlmRouterModel(models, (await readAutoLlmRouterModelId()) ?? undefined);
    if (!routerModel) return { refused: "router_off" };

    const decisions = await loadDecisions(answerableModelIds(models));

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
        objective,
    });
    if ("refused" in started) return started;

    const run = runInBackground({
        objective,
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
    if (!options.waitForCompletion) {
        void run;
        return { cycleId: started.cycle.id };
    }
    return { cycleId: started.cycle.id, outcome: await run };
}

type UsagePrices = Parameters<typeof observeOptimizerUsageCost>[1];

/** The resolved rates with their cache lines, for the routing cycle's usage-priced observations. */
const usagePricesOf = (model: AiModel): UsagePrices | null => {
    const prices = pricesOf(model);
    if (!prices) return null;
    const pricing = resolveModelPricing(model);
    return { ...prices, cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens ?? null };
};

/**
 * The diagnostic's manifest at start: runtime model identities, baseline
 * guidance, corpus and split, rubric, criteria, the call plan's upper bound
 * and the ceiling that actually binds.
 */
const costEfficiencyRunManifest = (input: {
    cycleId: string; budgetMicroUsd: number; decisions: OptimizerDecision[]; incumbentGuidance: string;
    models: readonly AiModel[]; optimizerModel: AiModel; routerModel: AiModel;
    optimizerPrices: Prices; routerPrices: Prices;
}, at: Date, observedOutputTokens: ObservedOutputTokens) => {
    const real = Math.min(input.decisions.length, AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX);
    const synthetic = Math.max(0, AUTO_ROUTER_OPTIMIZER_TARGET_SAMPLE - real);
    const total = real + synthetic;
    const answerModels = input.models.filter((model) => model.enabled && !model.catalogDeleted);
    return buildCostEfficiencyManifest({
        createdAt: at.toISOString(),
        source: { commit: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null, dirty: null },
        execution: "live",
        location: process.env.RAILWAY_ENVIRONMENT_NAME?.trim() || "unknown",
        baselineGuidance: input.incumbentGuidance,
        optimizerModel: input.optimizerModel,
        routerModel: input.routerModel,
        answerModels,
        corpus: {
            source: "recent picked AutoRouterDecision rows plus synthetic messages",
            cases: total, train: null, evaluate: null,
            split: "family: conversation id; synthetic message alone",
            families: { train: null, evaluate: null },
        },
        criteria: COST_EFFICIENCY_CRITERIA,
        // Upper bound: every case could land in the holdout and every synthetic message train.
        plan: costEfficiencyCallPlan({
            evaluate: total, trainRoutes: synthetic, synthesize: synthetic > 0,
            optimizer: input.optimizerPrices, router: input.routerPrices, answerModels,
        }),
        runCapMicroUsd: input.budgetMicroUsd,
        resultLocation: `AutoRouterOptimizerCycle ${input.cycleId}.summary`,
        observedOutputTokens,
    });
};

/**
 * Per model, the median output tokens of its completed Chat answers in the
 * last COST_EFFICIENCY_OBSERVED_OUTPUT_DAYS, from provider-reported usage
 * (output tokens include thinking). Counts only, no message text. A failed
 * read is an empty map: every estimate is then unknown and no challenger is
 * drawn as "lower estimated provider cost".
 */
export async function readObservedAnswerOutputTokens(at: Date): Promise<ObservedOutputTokens> {
    try {
        const since = new Date(at.getTime() - COST_EFFICIENCY_OBSERVED_OUTPUT_DAYS * 86_400_000);
        const rows = await prisma.$queryRaw<{ modelId: string; median: number | null; samples: number }[]>`
            SELECT "modelId",
                   percentile_disc(0.5) WITHIN GROUP (ORDER BY "outputTokens")::int AS median,
                   COUNT(*)::int AS samples
            FROM "ChatAttemptUsage"
            WHERE "createdAt" >= ${since}
              AND "outcome" = 'completed'
              AND "usageSource" = 'provider_usage_metadata'
              AND "outputTokens" IS NOT NULL
            GROUP BY "modelId"`;
        return new Map(rows.flatMap((row) => row.median === null ? [] :
            [[row.modelId, { medianOutputTokens: Number(row.median), samples: Number(row.samples) }] as const]));
    } catch (error) {
        console.warn(JSON.stringify({ event: "auto_router_optimizer_observed_output_failed", error: error instanceof Error ? error.name : "unknown" }));
        return new Map();
    }
}

/**
 * Runs a reserved cycle's calls and records the result. Never throws: a
 * failure is recorded as run_error and reported in the outcome.
 */
async function runInBackground(input: {
    objective: OptimizerObjective;
    cycleId: string;
    budgetMicroUsd: number;
    decisions: OptimizerDecision[];
    incumbentGuidance: string;
    models: readonly AiModel[];
    optimizerModel: AiModel;
    routerModel: AiModel;
    optimizerPrices: Prices;
    routerPrices: Prices;
}): Promise<OptimizerRunOutcome> {
    // A failed call costs nothing in the cycle's count and otherwise leaves no
    // trace; its shape is logged so a failed cycle names its cause. Never the
    // content: synthetic messages and answers appear in logs by length only.
    const traced = <T>(kind: OptimizerCallKind, run: () => Promise<T>, model = kind === "route" ? input.routerModel : input.optimizerModel) =>
        traceOptimizerCall({ event: "auto_router_optimizer_call_failed", cycleId: input.cycleId, kind, modelId: model.id, provider: model.provider }, run);
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
    // Reported usage priced by the existing provider-cost helper, cache-read
    // and cache-write lines included where the adapter reported them.
    const cost = (prices: UsagePrices, usage: Parameters<typeof observeOptimizerUsageCost>[0]) =>
        optimizerCostFields(observeOptimizerUsageCost(usage, prices));
    const optimizerUsagePrices = usagePricesOf(input.optimizerModel) ?? input.optimizerPrices;
    const routerUsagePrices = usagePricesOf(input.routerModel) ?? input.routerPrices;
    const costMode = input.objective === "chat_cost_efficiency";
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
    // The settings this optimizer changed on its own, undone first when one
    // made routing worse since (lib/autoRouterTunablesCore.ts).
    await revertTunedTimeoutIfWorse().catch(() => "kept" as const);
    // What the analysis call proposed for the settings, applied after the
    // cycle is recorded and only when it passes its range and evidence.
    let proposedSettingChanges: unknown[] = [];
    try {
        const measuredAt = new Date();
        const [candidatesFor, routerStats, catalogueIds, unreliableModels, latency, chatPresearchLatency] = await Promise.all([
            autoCandidateMenu(input.models),
            readRouterStats(measuredAt),
            optimizerCatalogueIds(),
            readUnreliableAnswerModels(),
            readResponseLatencyEvidence(measuredAt),
            readChatPresearchLatency(measuredAt).catch(() => ({ status: "unavailable" as const })),
        ]);
        const responseLatency = { ...latency, chatPresearchLatency };
        // The diagnostic's plan, fixed before its first call and stored with its result.
        // Read once, before the first call, and stored in the manifest.
        const observedOutputTokens = costMode ? await readObservedAnswerOutputTokens(measuredAt) : new Map();
        const manifest = costMode ? costEfficiencyRunManifest(input, measuredAt, observedOutputTokens) : null;
        const result = await runOptimizerCycle(
            {
                decisions: input.decisions,
                incumbentGuidance: input.incumbentGuidance,
                routerStats,
                catalogueIds,
                unreliableModels,
                responseLatency,
                ...(costMode ? {
                    objective: input.objective,
                    criteria: COST_EFFICIENCY_CRITERIA,
                    // A conversation never straddles the holdout; a synthetic message is its own family.
                    familyOf: (decision: OptimizerDecision) => decision.family ?? decision.id,
                } : {}),
            },
            {
                budgetMicroUsd: input.budgetMicroUsd,
                candidatesFor,
                ...(costMode ? {
                    estimateAnswerMicroUsd: (modelId: string, decision: OptimizerDecision) =>
                        estimateAnswerMicroUsd(answerModels.get(modelId), decision, estimateAnswerOutputTokens(modelId, observedOutputTokens)),
                    qualityJudge: async (message: string) => {
                        const generated = await traced("judge", () => optimizerJudgeCall({
                            model: input.optimizerModel,
                            system: AUTO_ROUTER_QUALITY_JUDGE_SYSTEM,
                            prompt: message,
                            name: "router_quality_judgement",
                            schema: autoRouterQualityJudgeSchema(),
                        }));
                        return {
                            value: parseQualityJudgement(outputOf("judge", generated)),
                            ...cost(optimizerUsagePrices, generated.usage),
                            provider: input.optimizerModel.provider,
                        };
                    },
                } : {}),
                // A proposal naming a model off the menu or without evidence;
                // model ids only, never guidance text.
                guidanceRejected: (rejection) =>
                    console.warn(JSON.stringify({
                        event: "auto_router_optimizer_guidance_rejected",
                        cycleId: input.cycleId,
                        reason: rejection.reason,
                        ids: rejection.ids,
                    })),
                synthesize: async (message) => {
                    const generated = await traced("synthesize", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: AUTO_ROUTER_SYNTHESIZER_SYSTEM,
                        prompt: message,
                        maxOutputTokens: SYNTHESIZER_MAX_OUTPUT_TOKENS,
                        reasoning: "none",
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
                        ...cost(optimizerUsagePrices, generated.usage),
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
                    // The report and the proposal together; the cycle admits each.
                    const output = outputOf("generate", generated);
                    const settingChanges = (output as { settingChanges?: unknown } | null)?.settingChanges;
                    proposedSettingChanges = Array.isArray(settingChanges) ? settingChanges : [];
                    const guidance = (output as { guidance?: unknown } | null)?.guidance;
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
                        value: output,
                        ...cost(optimizerUsagePrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
                route: async (guidance, decision) => {
                    const routed = await callAutoLlmRouter({
                        cycleId: input.cycleId,
                        decisionId: decision.id,
                        routerModel: input.routerModel,
                        guidance,
                        prompt: decision.routerInput,
                        previousAnswer: decision.routerContext,
                        candidates: decision.candidates,
                        session: decision.routerSession,
                        timeoutMs: AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
                        source: "routing_optimizer",
                    });
                    if (routed.failure) {
                        console.info(JSON.stringify({
                            event: "auto_router_optimizer_call_failed",
                            kind: "route",
                            decisionId: decision.id,
                            modelId: input.routerModel.id,
                            outcome: routed.outcome,
                            timeoutMs: AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
                            failure: routed.failure,
                        }));
                    }
                    return {
                        value: routed.pick?.modelId ?? null,
                        ...cost(routerUsagePrices, routed.usage),
                        provider: input.routerModel.provider,
                    };
                },
                // The picked model answers as itself: its own provider, its
                // own price, no tools, and the reasoning and provider options
                // a chat turn gives it (getModelGenerationSettings, as the
                // chat route calls it, inside optimizerAnswerOptions). Paid to
                // that provider, which may be
                // neither the optimizer's nor the router's.
                answer: async (modelId, turn) => {
                    const model = answerModels.get(modelId);
                    const prices = model ? pricesOf(model) : null;
                    // No call without a price: its spend could not be recorded.
                    if (!model || !prices) {
                        return { value: null, ...optimizerCostFields({ state: "no_dispatch", reason: !model ? "model_unavailable" : "unpriced" }), provider: model?.provider ?? "unknown" };
                    }
                    // Shared with the rewrite cycle (lib/autoRewriteOptimizer.ts).
                    const { timeoutMs, ...options } = optimizerAnswerOptions(model, turn);
                    // An exception (timeout, dropped connection, provider error) may
                    // come after the request was sent and billed, with no usage:
                    // counted at its upper bound so the run goes on (optimizerAnswerBound).
                    const attempt = await optimizerAnswerOrBound(() => traced("answer", () => generateText({
                        model: getActiveAiModel(model),
                        abortSignal: AbortSignal.timeout(timeoutMs),
                        ...options,
                    }), model), options, prices, model.provider);
                    if ("failed" in attempt) return attempt.failed;
                    const generated = attempt.generated;
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
                        ...cost(usagePricesOf(model) ?? prices, generated.usage),
                        provider: model.provider,
                    };
                },
                judge: async (message) => {
                    const generated = await traced("judge", () => optimizerJudgeCall({
                        model: input.optimizerModel,
                        system: AUTO_ROUTER_JUDGE_SYSTEM,
                        prompt: message,
                        name: "router_judgement",
                    }));
                    return {
                        value: parseJudgeWinner(outputOf("judge", generated)),
                        ...cost(optimizerUsagePrices, generated.usage),
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
                // No migration: the report, the direct comparisons and the
                // gate's basis ride in the summary JSON.
                summary: {
                    ...result.summary,
                    ...optimizerVerificationSummary(result),
                    failedCalls: result.failedCalls,
                    failedByKind: result.failedByKind,
                    report: result.report,
                    comparisons: result.comparisons,
                    gate: result.gate,
                    judgeFailed: result.judgeFailed,
                    answerStats: result.answerStats,
                    unreliableModels,
                    responseLatency,
                    // Present only on a diagnostic: optimizerPromotionEligibility refuses any summary with an objective.
                    ...(result.objective ? { objective: result.objective, costEfficiency: result.costEfficiency, manifest } : {}),
                },
                spentMicroUsd: result.spentMicroUsd,
                finishedAt: new Date(),
            },
            spentByProvider,
        });
        // Setting changes only for a cycle it recorded; never fails the cycle.
        // A diagnostic changes no setting and promotes nothing, whatever the switches say.
        const appliedSettings = recorded && !costMode
            ? await applyCycleTunableChanges({
                  cycleId: input.cycleId,
                  proposed: proposedSettingChanges,
                  evidence: {
                      routerStats,
                      answerStats: result.answerStats,
                      // A candidate with no known price cannot stand in for
                      // another at the same credits, so it is left out.
                      candidates: candidatesFor("hello").flatMap((candidate) =>
                          candidate.credits === null ? [] : [{ id: candidate.id, credits: candidate.credits }]
                      ),
                  },
              }).catch((error) => {
                  console.error(JSON.stringify({
                      event: "auto_router_tunable_apply_failed",
                      cycleId: input.cycleId,
                      error: error instanceof Error ? error.name : "unknown",
                  }));
                  return [];
              })
            : [];
        // Automatic promotion only of a result this cycle itself recorded, and
        // only through the same compare-and-set a person's click uses.
        let promotion:
            | Awaited<ReturnType<typeof promoteAutoRouterOptimizerCycle>>
            | { refused: "promotion_error" }
            | null = null;
        if (recorded && !costMode && result.status === "passed" && (await readOptimizerAutomation()).autoPromote) {
            // The cycle is already recorded; a failed promotion leaves it a
            // passed cycle a person can still promote.
            promotion = await promoteAutoRouterOptimizerCycle(input.cycleId, "system").catch(
                () => ({ refused: "promotion_error" as const })
            );
        }
        console.info(JSON.stringify({
            event: "auto_router_optimizer_cycle",
            cycleId: input.cycleId,
            objective: input.objective,
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
            comparisons: result.comparisons.reduce<Record<string, number>>(
                (counts, item) => ({ ...counts, [item.verdict]: (counts[item.verdict] ?? 0) + 1 }),
                {}
            ),
            gate: result.gate,
            judgeFailed: result.judgeFailed,
            unreliableModels,
            settingsProposed: proposedSettingChanges.length,
            settingsApplied: appliedSettings.length,
            reportItems: result.report
                ? result.report.findings.length + result.report.recommendations.length
                : 0,
        }));
        return { recorded, status: result.status, failure: result.failure };
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
        return { recorded: false, status: "error", failure: "run_error" };
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
): Promise<{ ok: true } | { refused: "not_found" | "not_passed" | "already_promoted" | "stale" | OptimizerPromotionRefusal }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: cycleId },
            select: { status: true, candidateGuidance: true, incumbentGuidance: true, promotedAt: true, target: true, summary: true },
        });
        // A rewrite cycle's proposal is rewrite guidance: lib/autoRewriteOptimizer.ts
        // promotes it, and never into the routing guidance.
        if (!cycle || cycle.target !== "routing") return { refused: "not_found" as const };
        if (cycle.promotedAt) return { refused: "already_promoted" as const };
        const eligibility = optimizerPromotionEligibility(cycle);
        if (!eligibility.eligible) return { refused: eligibility.refusal };
        const active = await readActiveRouterGuidance(tx);
        // The cycle measured its proposal against the guidance in force when
        // it ran. If that has changed since, the measurement is not about the
        // router as it is now.
        if (active.guidance !== cycle.incumbentGuidance) return { refused: "stale" as const };
        await writeActiveRouterGuidance(
            tx,
            promotedRouterGuidance(active, { guidance: cycle.candidateGuidance!, cycleId })
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
    implementations?: Record<number, DailyTaskImplementation>;
    implementationLookupUnavailable?: boolean;
    id: string;
    createdAt: string;
    finishedAt: string | null;
    status: string;
    failure: string | null;
    optimizerModelId: string;
    routerModelId: string;
    candidateGuidance: string | null;
    summary: unknown;
    promotionEligibility: ReturnType<typeof optimizerPromotionEligibility>;
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
    const [optimizerModelId, automation, active, cycles, monthCycles, smartAdaptiveDaily, servingCost] = await Promise.all([
        readOptimizerModelId(),
        readOptimizerAutomation(),
        readActiveRouterGuidance(),
        prisma.autoRouterOptimizerCycle.findMany({
            // Rewrite cycles are listed by lib/autoRewriteOptimizer.ts; the
            // spend below counts both, as the shared caps do.
            where: { target: "routing" },
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
            select: { createdAt: true, spentMicroUsd: true, summary: true },
        }),
        readSmartAdaptiveDaily().catch(() => null),
        readAutoChatServingCost(now),
    ]);
    const implementations = await readDailyImplementations();
    return {
        optimizerModelId,
        smartAdaptiveDaily,
        // The diagnostic's switch, read so Admin offers the start only when it is on.
        costEfficiencyDiagnostic: { available: costEfficiencyDiagnosticOn() },
        servingCost,
        automation,
        active: {
            cycleId: active.cycleId,
            guidance: active.guidance,
            canRollBack: active.cycleId !== null,
        },
        cycles: cycles.map(({ cases, ...cycle }): OptimizerCycleView => ({
            ...cycle,
            implementations: Object.fromEntries(actionableRecommendations(cycle.summary).flatMap((item) => {
                const evidence = taskImplementation(implementations, `${cycle.id}:${item.index}`, recommendationStatusEntries(cycle.summary).get(item.index)?.prUrl);
                return evidence ? [[item.index, evidence]] : [];
            })),
            implementationLookupUnavailable: implementations.status === "unavailable",
            ...optimizerCycleView(cycle, now),
            promotionEligibility: optimizerPromotionEligibility(cycle),
            syntheticCases: syntheticCaseViews(cases),
            createdAt: cycle.createdAt.toISOString(),
            finishedAt: cycle.finishedAt?.toISOString() ?? null,
            promotedAt: cycle.promotedAt?.toISOString() ?? null,
        })),
        spend: {
            unconfirmedCycles: monthCycles.filter(cycle => (cycle.summary as { costCoverage?: { complete?: boolean } } | null)?.costCoverage?.complete !== true).length,
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
/** A switch left out keeps its current value (an older page sends only daily and auto-promote). */
export async function updateOptimizerAutomation(actor: AdminActor, change: Omit<OptimizerAutomation, "costDiagnosticWeekly"> & { costDiagnosticWeekly?: boolean }) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readOptimizerAutomation(tx);
        const after: OptimizerAutomation = { ...change, costDiagnosticWeekly: change.costDiagnosticWeekly ?? before.costDiagnosticWeekly };
        await writeOptimizerAutomation(tx, after);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_optimizer_automation.updated",
            targetType: "AppSettings",
            targetId: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
            summary: `Set the Auto router optimizer automation: daily ${after.daily ? "on" : "off"}, auto-promote ${after.autoPromote ? "on" : "off"}, weekly cost diagnostic ${after.costDiagnosticWeekly ? "on" : "off"}.`,
            metadata: { before, after },
        });
    });
}
