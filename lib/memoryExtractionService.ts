import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { getMemoryExtractionRevokedPairs } from "@/lib/appSettings";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import {
    MEMORY_EXTRACTION_LEASE_TTL_MS,
    decideMemoryExtractionBudget,
    estimateExtraction,
    isRunLeaseExpired,
    planExtractionChunks,
    resolveMemoryExtractionSubBudget,
    type ExtractionEstimate,
} from "@/lib/memoryExtractionCore";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    findApprovedEvalPair,
    type MemoryExtractionEvalEntry,
} from "@/lib/memoryExtractionEvalRegister";
import { getModelPricingProfile } from "@/lib/modelPricing";
import {
    AVAILABLE_MODELS,
    canUseModelWithPlan,
    getModelUsageCredits,
    type ModelTier,
} from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { getProviderCostBudget } from "@/lib/providerCostBudget";

/**
 * Extraction run lifecycle (Release B, slice B2): creation with the §11
 * pre-run confirmation contract, the §3 background-concurrency layer (one
 * active run per user), the batch sub-budget double check, lease heartbeat
 * and the 15-minute orphan sweep.
 *
 * What this slice deliberately does NOT contain is the model call itself:
 * chunk execution arrives with the extraction pipeline once a pair is
 * approved through §12.4. Nothing here can reach a provider — a run can be
 * created, inspected, heartbeaten, cancelled and swept, and its chunks
 * completed only through the idempotent progress API the pipeline will use.
 */

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;

/** Serializes run admission per user, like the import quota lock. */
const acquireUserRunLock = (
    tx: Prisma.TransactionClient,
    userId: string
) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"memory-extraction:" + userId}))`;

const utcDayStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const utcMonthStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const utcDayEnd = (now: Date) => new Date(utcDayStart(now).getTime() + 86_400_000);
const utcMonthEnd = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

const subBudgetEnv = (
    provider: string,
    period: "DAY" | "MONTH",
    environment: Record<string, string | undefined>
) => ({
    percent: Number(
        environment[
            `MEMORY_EXTRACTION_PROVIDER_${provider.toUpperCase()}_MAX_PERCENT_PER_${period}`
        ]
    ),
    absolute: Number(
        environment[
            `MEMORY_EXTRACTION_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_${period}`
        ]
    ),
});

/**
 * Resolves the §12.1 effective pair for one user, or throws the §18 error.
 * Register approval, operational revocation, verified pricing, plan access
 * and prompt-version match all live here so every caller gets one answer.
 */
export async function resolveEffectiveExtractionPair(input: {
    extractionModelId: string;
    promptVersion: string;
    plan: ModelTier | "Guest";
    register?: readonly MemoryExtractionEvalEntry[];
}) {
    const revoked = await getMemoryExtractionRevokedPairs();
    const entry = findApprovedEvalPair(
        {
            extractionModelId: input.extractionModelId,
            promptVersion: input.promptVersion,
        },
        revoked,
        input.register ?? MEMORY_EXTRACTION_EVAL_REGISTER
    );
    const pricing = getModelPricingProfile(input.extractionModelId);
    const model = AVAILABLE_MODELS.find(
        (candidate) => candidate.id === input.extractionModelId
    );
    if (
        !entry ||
        !pricing ||
        !model ||
        !canUseModelWithPlan(input.plan, model)
    ) {
        // One code for every reason (§18): which condition failed is an
        // operational detail, not something a probing client learns.
        throw new ApiSecurityError(
            403,
            "MEMORY_EXTRACTION_PAIR_UNAVAILABLE",
            "No approved extraction pair is available."
        );
    }
    return { entry, pricing, model };
}

/**
 * The §11 pre-run figure: chunk plan and credit/cost estimate over the
 * user's finalized conversations. Pure math over stored byte counts — no
 * provider contact, no reservation.
 */
export async function estimateMemoryExtraction(input: {
    userId: string;
    extractionModelId: string;
    promptVersion: string;
    plan: ModelTier | "Guest";
    selectedConversationIds: string[];
    register?: readonly MemoryExtractionEvalEntry[];
}): Promise<ExtractionEstimate & { conversationCount: number }> {
    const { pricing, model } = await resolveEffectiveExtractionPair(input);

    const selected = await prisma.externalConversation.findMany({
        where: {
            id: { in: input.selectedConversationIds },
            userId: input.userId,
            finalized: true,
        },
        select: { id: true, messageCount: true, contentBytes: true },
    });
    if (
        selected.length === 0 ||
        selected.length !== new Set(input.selectedConversationIds).size
    ) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Conversation not found.");
    }

    const chunks = planExtractionChunks(
        selected.map((conversation) => ({
            id: conversation.id,
            messageCount: conversation.messageCount,
            contentBytes: Number(conversation.contentBytes),
        }))
    );
    const tier = pricing.tiers[0];
    const estimate = estimateExtraction(chunks, {
        inputMicroUsdPerMTokens: tier.inputUsdPerMillionTokens * 1_000_000,
        outputMicroUsdPerMTokens: tier.outputUsdPerMillionTokens * 1_000_000,
        creditsPerCall: getModelUsageCredits(model),
    });
    return { ...estimate, conversationCount: selected.length };
}

async function readBudgetUsage(provider: string, now: Date) {
    const dayStart = utcDayStart(now);
    const monthStart = utcMonthStart(now);
    const keys = [`provider:${provider}`, `memory-extraction-provider:${provider}`];
    const rows = await prisma.chatUsageBucket.findMany({
        where: {
            key: { in: keys },
            OR: [
                { period: "provider-cost-day", periodStart: dayStart },
                { period: "provider-cost-month", periodStart: monthStart },
            ],
        },
        select: { key: true, period: true, count: true },
    });
    const lookup = new Map(
        rows.map((row) => [`${row.key}|${row.period}`, usageBucketCount(row.count)])
    );
    return {
        providerDay: lookup.get(`provider:${provider}|provider-cost-day`) ?? 0,
        providerMonth:
            lookup.get(`provider:${provider}|provider-cost-month`) ?? 0,
        batchDay:
            lookup.get(
                `memory-extraction-provider:${provider}|provider-cost-day`
            ) ?? 0,
        batchMonth:
            lookup.get(
                `memory-extraction-provider:${provider}|provider-cost-month`
            ) ?? 0,
    };
}

/**
 * §3: total provider budget still binds, and the batch sub-budget (default
 * 10%) binds on top. A refusal is the dedicated 503 with a mandatory
 * resetAt — never the entitlement vocabulary.
 */
async function assertExtractionBudget(
    provider: string,
    estimatedCostMicroUsd: number,
    now: Date,
    environment: Record<string, string | undefined> = process.env
) {
    const budget = getProviderCostBudget(provider, environment);
    const usage = await readBudgetUsage(provider, now);
    const dayEnv = subBudgetEnv(provider, "DAY", environment);
    const monthEnv = subBudgetEnv(provider, "MONTH", environment);

    const decision = decideMemoryExtractionBudget({
        estimatedCostMicroUsd,
        day: {
            providerLimit: budget.day,
            providerUsed: usage.providerDay,
            subBudgetLimit: resolveMemoryExtractionSubBudget({
                providerBudgetMicroUsd: budget.day,
                percentOverride: Number.isFinite(dayEnv.percent)
                    ? dayEnv.percent
                    : null,
                absoluteOverrideMicroUsd: Number.isFinite(dayEnv.absolute)
                    ? dayEnv.absolute
                    : null,
            }),
            subBudgetUsed: usage.batchDay,
            resetAt: utcDayEnd(now).toISOString(),
        },
        month: {
            providerLimit: budget.month,
            providerUsed: usage.providerMonth,
            subBudgetLimit: resolveMemoryExtractionSubBudget({
                providerBudgetMicroUsd: budget.month,
                percentOverride: Number.isFinite(monthEnv.percent)
                    ? monthEnv.percent
                    : null,
                absoluteOverrideMicroUsd: Number.isFinite(monthEnv.absolute)
                    ? monthEnv.absolute
                    : null,
            }),
            subBudgetUsed: usage.batchMonth,
            resetAt: utcMonthEnd(now).toISOString(),
        },
    });
    if (!decision.allowed) {
        throw new ApiSecurityError(
            503,
            "MEMORY_EXTRACTION_PROVIDER_BUDGET_EXHAUSTED",
            "The extraction batch budget is exhausted.",
            Math.max(
                1,
                Math.ceil(
                    (new Date(decision.resetAt).getTime() - now.getTime()) / 1000
                )
            )
        );
    }
}

export async function createMemoryExtractionRun(input: {
    userId: string;
    extractionModelId: string;
    promptVersion: string;
    plan: ModelTier | "Guest";
    selectedConversationIds: string[];
    /** §11: the user confirms the shown estimate; a stale confirm re-asks. */
    confirmedCredits: number;
    register?: readonly MemoryExtractionEvalEntry[];
    now?: Date;
    environment?: Record<string, string | undefined>;
}) {
    const now = input.now ?? new Date();
    const { pricing } = await resolveEffectiveExtractionPair(input);
    const estimate = await estimateMemoryExtraction(input);
    if (estimate.estimatedCredits !== input.confirmedCredits) {
        // The selection changed under the confirmation dialog. Same shape as
        // the import selection guard: re-show, never silently re-price.
        throw new ApiSecurityError(
            409,
            "MEMORY_ESTIMATE_CHANGED",
            "The estimate no longer matches the selection."
        );
    }
    await assertExtractionBudget(
        pricing.provider,
        estimate.estimatedCostMicroUsd,
        now,
        input.environment ?? process.env
    );

    const sourceSelection = [...new Set(input.selectedConversationIds)].sort();
    return prisma.$transaction(async (tx) => {
        await acquireUserRunLock(tx, input.userId);
        const active = await tx.memoryExtractionRun.findFirst({
            where: {
                userId: input.userId,
                status: { in: [...ACTIVE_RUN_STATUSES] },
            },
            select: { id: true, leaseExpiresAt: true, status: true },
        });
        if (active) {
            // An expired-lease orphan does not block a new run forever: the
            // sweep (or this lazy path) parks it first (§3 reconciliation).
            if (
                active.status === "running" &&
                isRunLeaseExpired(active, now)
            ) {
                await tx.memoryExtractionRun.update({
                    where: { id: active.id },
                    data: { status: "pending", leaseExpiresAt: null },
                });
            }
            throw new ApiSecurityError(
                409,
                "MEMORY_EXTRACTION_ALREADY_RUNNING",
                "An extraction run is already active for this account."
            );
        }
        return tx.memoryExtractionRun.create({
            data: {
                userId: input.userId,
                status: "pending",
                extractionModelId: input.extractionModelId,
                promptVersion: input.promptVersion,
                sourceSelection,
                chunkTotal: estimate.chunkCount,
                pricingVersion: `${estimate.basis}:${pricing.modelId}`,
            },
        });
    });
}

async function loadOwnedRun(userId: string, runId: string) {
    const run = await prisma.memoryExtractionRun.findUnique({
        where: { id: runId },
    });
    if (!run || run.userId !== userId) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Run not found.");
    }
    return run;
}

export async function getMemoryExtractionRun(userId: string, runId: string) {
    const run = await loadOwnedRun(userId, runId);
    return {
        id: run.id,
        status: run.status,
        extractionModelId: run.extractionModelId,
        promptVersion: run.promptVersion,
        chunkTotal: run.chunkTotal,
        chunkCompleted: run.chunkCompleted,
        createdAt: run.createdAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
    };
}

/**
 * Claims or renews the run lease (§3 heartbeat). The pipeline calls this
 * before each chunk; a conditional update makes concurrent claimants lose
 * deterministically instead of double-driving one run.
 */
export async function heartbeatMemoryExtractionRun(
    userId: string,
    runId: string,
    now: Date = new Date()
) {
    const run = await loadOwnedRun(userId, runId);
    if (run.status === "running" && isRunLeaseExpired(run, now)) {
        throw new ApiSecurityError(
            410,
            "MEMORY_EXTRACTION_LEASE_EXPIRED",
            "The run lease expired; resume the run."
        );
    }
    const claimed = await prisma.memoryExtractionRun.updateMany({
        where: {
            id: run.id,
            status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        data: {
            status: "running",
            leaseExpiresAt: new Date(
                now.getTime() + MEMORY_EXTRACTION_LEASE_TTL_MS
            ),
        },
    });
    if (claimed.count !== 1) {
        throw new ApiSecurityError(
            410,
            "MEMORY_EXTRACTION_LEASE_EXPIRED",
            "The run is no longer active."
        );
    }
}

/**
 * Idempotent chunk progress: completing chunk N only advances the counter
 * when N is the next chunk, so a retried settlement cannot double-count
 * (§11 idempotent settlement).
 */
export async function completeMemoryExtractionChunk(
    userId: string,
    runId: string,
    chunkIndex: number,
    now: Date = new Date()
) {
    const run = await loadOwnedRun(userId, runId);
    const advanced = await prisma.memoryExtractionRun.updateMany({
        where: { id: run.id, status: "running", chunkCompleted: chunkIndex },
        data: {
            chunkCompleted: { increment: 1 },
            leaseExpiresAt: new Date(
                now.getTime() + MEMORY_EXTRACTION_LEASE_TTL_MS
            ),
        },
    });
    if (advanced.count === 0) {
        // Replay of an already-counted chunk: idempotent no-op.
        return { advanced: false as const };
    }
    const after = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { chunkCompleted: true, chunkTotal: true },
    });
    if (after.chunkCompleted >= after.chunkTotal) {
        await prisma.memoryExtractionRun.update({
            where: { id: run.id },
            data: {
                status: "completed",
                leaseExpiresAt: null,
                completedAt: now,
            },
        });
    }
    return { advanced: true as const };
}

/** User cancel: deterministic release, terminal state, idempotent. */
export async function cancelMemoryExtractionRun(userId: string, runId: string) {
    const run = await loadOwnedRun(userId, runId);
    if (run.status === "cancelled") return { outcome: "cancelled" as const };
    if (run.status === "completed" || run.status === "failed") {
        throw new ApiSecurityError(
            409,
            "MEMORY_EXTRACTION_RUN_TERMINAL",
            "The run already finished."
        );
    }
    await prisma.memoryExtractionRun.updateMany({
        where: { id: run.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: { status: "cancelled", leaseExpiresAt: null },
    });
    return { outcome: "cancelled" as const };
}

/**
 * The 15-minute orphan sweep (§3): a running run whose lease expired goes
 * back to pending with its completed-chunk progress intact — resumable, not
 * destroyed. Wired into the maintenance cycle beside the import sweep.
 */
export async function reconcileExpiredMemoryExtractionRuns(now = new Date()) {
    const reclaimed = await prisma.memoryExtractionRun.updateMany({
        where: { status: "running", leaseExpiresAt: { lte: now } },
        data: { status: "pending", leaseExpiresAt: null },
    });
    if (reclaimed.count > 0) {
        console.info(
            JSON.stringify({
                event: "memory_extraction_lease_reclaimed",
                runs: reclaimed.count,
            })
        );
    }
    return { reclaimedRuns: reclaimed.count };
}
