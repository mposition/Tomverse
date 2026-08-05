import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    getMemoryExtractionRevokedPairs,
    isMemoryExtractionEnabled,
} from "@/lib/appSettings";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import {
    MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS,
    MEMORY_EXTRACTION_LEASE_TTL_MS,
    chunkFailureDisposition,
    decideMemoryExtractionBudget,
    estimateExtraction,
    extractionSliceBudget,
    isRunLeaseExpired,
    mayStartAnotherChunk,
    planExtractionChunks,
    resolveMemoryExtractionSubBudget,
    type ExtractionChunkPlan,
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
import {
    reserveExtractionRunCredits,
    settleExtractionRunCredits,
} from "@/lib/memoryExtractionCredits";
import { getBillingPlanByTier } from "@/lib/billingConfig";
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
}): Promise<
    ExtractionEstimate & {
        conversationCount: number;
        /** The exact plan the run stores, so create never re-plans. */
        chunks: ExtractionChunkPlan[];
    }
> {
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

    // Sorted by id before planning. Chunk boundaries depend on the order the
    // conversations arrive in, and `findMany` makes no ordering promise, so
    // without this the estimate the user confirms and the plan the run stores
    // could disagree between two calls over the same selection.
    const chunks = planExtractionChunks(
        [...selected]
            .sort((left, right) => (left.id < right.id ? -1 : 1))
            .map((conversation) => ({
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
    return { ...estimate, conversationCount: selected.length, chunks };
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

/**
 * The monthly and daily plan credit limits the reservation allocates against.
 *
 * A Guest never reaches here -- §11 requires an approved pair on the account's
 * plan and guests have no account -- but the type allows one, so it resolves
 * to no plan credits rather than to a plan's limits by accident.
 */
async function extractionPlanLimits(plan: ModelTier | "Guest") {
    if (plan === "Guest") {
        return { monthlyMessageLimit: 0, dailyMessageLimit: 0 };
    }
    const billingPlan = await getBillingPlanByTier(plan);
    return {
        monthlyMessageLimit: billingPlan?.monthlyMessageLimit ?? 0,
        dailyMessageLimit: billingPlan?.dailyMessageLimit ?? 0,
    };
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

    // Read outside the transaction: it is configuration, and holding the run
    // lock while querying it would widen the lock for no benefit.
    const planLimits = await extractionPlanLimits(input.plan);

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
        const run = await tx.memoryExtractionRun.create({
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
        // Entitlement, in the same transaction as the run and its chunks: a
        // run can never exist without the reservation that paid for it, and a
        // refused reservation leaves no run, no chunks and no charge. The
        // provider budget checked above is the separate operational layer and
        // stays a per-chunk re-check in the slice driver (AGENTS.md).
        await reserveExtractionRunCredits({
            tx,
            userId: input.userId,
            runId: run.id,
            plan: planLimits,
            credits: estimate.estimatedCredits,
            costMicroUsd: estimate.estimatedCostMicroUsd,
            chunkTotal: estimate.chunkCount,
            provider: pricing.provider,
            extractionModelId: input.extractionModelId,
            promptVersion: input.promptVersion,
            pricingVersion: `${estimate.basis}:${pricing.modelId}`,
            // The profile is read straight from MODEL_PRICING here, not
            // resolved against a registry row, so the source is the code
            // profile by construction.
            costSource: pricing.priceSource,
            // Frozen here on purpose: a price change afterwards must not
            // re-settle a run the user already confirmed at these numbers.
            pricingSnapshot: {
                basis: estimate.basis,
                modelId: pricing.modelId,
                provider: pricing.provider,
                inputUsdPerMillionTokens: pricing.tiers[0].inputUsdPerMillionTokens,
                outputUsdPerMillionTokens: pricing.tiers[0].outputUsdPerMillionTokens,
                estimatedInputTokens: estimate.estimatedInputTokens,
                estimatedOutputTokens: estimate.estimatedOutputTokens,
                estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
                chunkCount: estimate.chunkCount,
            },
            now,
        });
        // The chunk rows are the run's durable work list, written in the same
        // transaction so a run can never exist without one. Storing each
        // chunk's conversations here is what lets a later dispatch pick the
        // work up without re-planning (and possibly re-planning differently).
        await tx.memoryExtractionChunk.createMany({
            data: estimate.chunks.map((chunk, chunkIndex) => ({
                runId: run.id,
                chunkIndex,
                conversationIds: chunk.conversationIds,
            })),
        });
        return run;
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

export type MemoryExtractionLease = {
    runId: string;
    userId: string;
    /** The fencing token every subsequent write must present. */
    leaseGeneration: number;
    extractionModelId: string;
    promptVersion: string;
    chunkTotal: number;
};

const leaseDeadline = (now: Date) =>
    new Date(now.getTime() + MEMORY_EXTRACTION_LEASE_TTL_MS);

/**
 * Takes exclusive ownership of a run (§11).
 *
 * A run is claimable when it is `pending`, or `running` with a lease that has
 * already lapsed — that second case is a worker that died, and taking over is
 * exactly the recovery the fifteen-minute dispatcher exists for. The claim
 * increments `leaseGeneration` in the same statement that flips the status,
 * so the winner learns a token the loser cannot guess or reuse.
 *
 * Postgres row locking under READ COMMITTED serializes two concurrent
 * claimants: the second re-evaluates the predicate after the first commits,
 * finds a live lease, and matches nothing. Returns null for the loser rather
 * than throwing — losing a claim is the normal outcome when two drivers race,
 * not an error anyone needs to see.
 */
export async function claimMemoryExtractionRun(input: {
    runId: string;
    owner: string;
    now?: Date;
}): Promise<MemoryExtractionLease | null> {
    const now = input.now ?? new Date();
    return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
            Array<{
                id: string;
                userId: string;
                leaseGeneration: number;
                extractionModelId: string;
                promptVersion: string;
                chunkTotal: number;
            }>
        >`
            UPDATE "MemoryExtractionRun"
            SET "status" = 'running',
                "leaseGeneration" = "leaseGeneration" + 1,
                "leaseExpiresAt" = ${leaseDeadline(now)},
                "leaseOwner" = ${input.owner},
                "updatedAt" = ${now}
            WHERE "id" = ${input.runId}
              AND (
                    "status" = 'pending'
                    OR ("status" = 'running'
                        AND ("leaseExpiresAt" IS NULL
                             OR "leaseExpiresAt" <= ${now}))
                  )
            RETURNING "id", "userId", "leaseGeneration",
                      "extractionModelId", "promptVersion", "chunkTotal"
        `;
        const row = rows[0];
        if (!row) return null;

        // A worker that died between claiming a chunk and reporting it leaves
        // that chunk stuck in `running` under a generation nobody holds. Only
        // pending chunks are claimable, so without this the run could never
        // finish — reclaiming the run would not reclaim its work. `attemptCount`
        // is deliberately NOT rolled back: the attempt really was spent, and a
        // chunk that keeps killing its worker has to reach the retry cap
        // instead of retrying forever.
        await tx.memoryExtractionChunk.updateMany({
            where: {
                runId: row.id,
                status: "running",
                NOT: { leaseGeneration: row.leaseGeneration },
            },
            data: { status: "pending", leaseGeneration: null, updatedAt: now },
        });

        return {
            runId: row.id,
            userId: row.userId,
            leaseGeneration: row.leaseGeneration,
            extractionModelId: row.extractionModelId,
            promptVersion: row.promptVersion,
            chunkTotal: row.chunkTotal,
        };
    });
}

/**
 * Renews the lease held by this generation. Returns false when the holder has
 * been fenced out — superseded, cancelled or finished — which tells the caller
 * to stop rather than to retry.
 */
export async function heartbeatMemoryExtractionRun(
    lease: Pick<MemoryExtractionLease, "runId" | "leaseGeneration">,
    now: Date = new Date()
): Promise<boolean> {
    const renewed = await prisma.memoryExtractionRun.updateMany({
        where: {
            id: lease.runId,
            status: "running",
            leaseGeneration: lease.leaseGeneration,
        },
        data: { leaseExpiresAt: leaseDeadline(now) },
    });
    return renewed.count === 1;
}

/**
 * Hands the lease back with progress intact: the run returns to `pending` so
 * the next dispatch continues it. Fenced, so a worker that has already been
 * superseded cannot park a run somebody else is now driving.
 */
export async function releaseMemoryExtractionRun(
    lease: Pick<MemoryExtractionLease, "runId" | "leaseGeneration">
): Promise<boolean> {
    const released = await prisma.memoryExtractionRun.updateMany({
        where: {
            id: lease.runId,
            status: "running",
            leaseGeneration: lease.leaseGeneration,
        },
        data: { status: "pending", leaseExpiresAt: null, leaseOwner: null },
    });
    return released.count === 1;
}

export type ClaimedExtractionChunk = {
    chunkIndex: number;
    attemptCount: number;
    conversationIds: string[];
};

/**
 * Claims the lowest-numbered pending chunk, fenced on the run lease.
 *
 * The join to the run inside the statement is the fence: a worker whose
 * generation no longer matches cannot claim work, even if the chunk itself
 * looks free. `SKIP LOCKED` keeps a concurrent claimant from blocking on a
 * row it is not going to win anyway.
 */
export async function claimNextExtractionChunk(
    lease: Pick<MemoryExtractionLease, "runId" | "leaseGeneration">,
    now: Date = new Date()
): Promise<ClaimedExtractionChunk | null> {
    const rows = await prisma.$queryRaw<
        Array<{
            chunkIndex: number;
            attemptCount: number;
            conversationIds: unknown;
        }>
    >`
        UPDATE "MemoryExtractionChunk" AS target
        SET "status" = 'running',
            "attemptCount" = target."attemptCount" + 1,
            "leaseGeneration" = ${lease.leaseGeneration},
            "startedAt" = ${now},
            "updatedAt" = ${now}
        WHERE target."id" = (
            SELECT c."id"
            FROM "MemoryExtractionChunk" c
            JOIN "MemoryExtractionRun" r ON r."id" = c."runId"
            WHERE c."runId" = ${lease.runId}
              AND c."status" = 'pending'
              AND r."status" = 'running'
              AND r."leaseGeneration" = ${lease.leaseGeneration}
            ORDER BY c."chunkIndex" ASC
            LIMIT 1
            FOR UPDATE OF c SKIP LOCKED
        )
        RETURNING target."chunkIndex", target."attemptCount",
                  target."conversationIds"
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        chunkIndex: row.chunkIndex,
        attemptCount: row.attemptCount,
        conversationIds: Array.isArray(row.conversationIds)
            ? (row.conversationIds as string[])
            : [],
    };
}

/**
 * Records a finished chunk and re-derives the run's progress from the chunk
 * rows. Deriving rather than incrementing is what makes a replayed or
 * duplicated report harmless: the counter is a function of durable state, so
 * it cannot be double-counted into a wrong number.
 *
 * Returns whether the run reached a terminal state, so the caller knows to
 * stop without re-reading it.
 */
export async function completeExtractionChunk(
    lease: Pick<MemoryExtractionLease, "runId" | "leaseGeneration">,
    chunkIndex: number,
    result: { outcome: "completed" } | { outcome: "failed"; code: string },
    now: Date = new Date()
): Promise<{ applied: boolean; runStatus: string; chunkStatus?: string }> {
    return prisma.$transaction(async (tx) => {
        const chunk = await tx.memoryExtractionChunk.findUnique({
            where: { runId_chunkIndex: { runId: lease.runId, chunkIndex } },
            select: { attemptCount: true },
        });
        if (!chunk) return { applied: false, runStatus: "unknown" };

        const disposition =
            result.outcome === "completed"
                ? ({ status: "completed" } as const)
                : chunkFailureDisposition({ attemptCount: chunk.attemptCount });

        const updated = await tx.memoryExtractionChunk.updateMany({
            where: {
                runId: lease.runId,
                chunkIndex,
                status: "running",
                leaseGeneration: lease.leaseGeneration,
            },
            data: {
                status: disposition.status,
                failureCode: result.outcome === "failed" ? result.code : null,
                completedAt:
                    disposition.status === "completed" ? now : null,
                // A chunk going back to pending releases its fence so the next
                // slice — possibly a different worker — can claim it.
                leaseGeneration:
                    disposition.status === "pending"
                        ? null
                        : lease.leaseGeneration,
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            const run = await tx.memoryExtractionRun.findUnique({
                where: { id: lease.runId },
                select: { status: true },
            });
            return { applied: false, runStatus: run?.status ?? "unknown" };
        }

        const [completed, failed] = await Promise.all([
            tx.memoryExtractionChunk.count({
                where: { runId: lease.runId, status: "completed" },
            }),
            tx.memoryExtractionChunk.count({
                where: { runId: lease.runId, status: "failed" },
            }),
        ]);
        const run = await tx.memoryExtractionRun.findUniqueOrThrow({
            where: { id: lease.runId },
            select: { chunkTotal: true },
        });

        const terminal =
            failed > 0
                ? ("failed" as const)
                : completed >= run.chunkTotal
                  ? ("completed" as const)
                  : null;
        await tx.memoryExtractionRun.updateMany({
            where: {
                id: lease.runId,
                status: "running",
                leaseGeneration: lease.leaseGeneration,
            },
            data: {
                chunkCompleted: completed,
                ...(terminal
                    ? {
                          status: terminal,
                          leaseExpiresAt: null,
                          leaseOwner: null,
                          completedAt: now,
                      }
                    : { leaseExpiresAt: leaseDeadline(now) }),
            },
        });
        if (terminal) {
            // Settled in the same transaction that made the run terminal, so
            // a run can never come to rest with credits still reserved
            // against it. `completed` is what the account is charged for: a
            // run that failed after two of five chunks keeps two, because
            // those two really did call the provider.
            await settleExtractionRunCredits(tx, {
                runId: lease.runId,
                outcome: terminal,
                chunksCharged: completed,
                now,
            });
        }
        return {
            applied: true,
            runStatus: terminal ?? "running",
            chunkStatus: disposition.status,
        };
    });
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
    await prisma.$transaction(async (tx) => {
        const cancelled = await tx.memoryExtractionRun.updateMany({
            where: { id: run.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            data: { status: "cancelled", leaseExpiresAt: null },
        });
        // Only the transition that actually cancelled settles. A second cancel
        // -- a double-clicked button, a retried request -- changes no row here
        // and must not refund a second time; `settleExtractionRunCredits` is
        // idempotent on its own, and this keeps the two agreeing.
        if (cancelled.count === 0) return;
        const completed = await tx.memoryExtractionChunk.count({
            where: { runId: run.id, status: "completed" },
        });
        await settleExtractionRunCredits(tx, {
            runId: run.id,
            outcome: "cancelled",
            chunksCharged: completed,
        });
    });
    return { outcome: "cancelled" as const };
}

export type ExtractionChunkHandler = (input: {
    lease: MemoryExtractionLease;
    chunk: ClaimedExtractionChunk;
    /**
     * Cancelled when the chunk's wall-clock budget runs out.
     *
     * Best-effort, and deliberately not the accounting mechanism. A handler
     * that ignores it cannot hang the slice — the race below still resolves —
     * and a provider request that already reached the network may be billed
     * whether or not the abort landed. What this saves is the work that had
     * not started yet; what records the rest is the provider-call ledger.
     */
    signal: AbortSignal;
}) => Promise<{ outcome: "completed" } | { outcome: "failed"; code: string }>;

export type ExtractionSliceResult = {
    chunksProcessed: number;
    outcome:
        | "not_claimed"
        | "completed"
        | "paused"
        | "lease_lost"
        | "blocked"
        | "cancelled"
        | "failed";
    reason?: string;
};

/**
 * Re-checks, at every chunk boundary, everything that could have changed
 * since the run was created (§11, §12.1, §15).
 *
 * A run is durable and a slice may be picked up minutes or hours later, so
 * none of these can be decided once at creation: the rollout flag may have
 * been turned off, the (model, promptVersion) pair may have been revoked
 * without a deploy, the user's plan may have changed, and the batch
 * sub-budget may have been spent by other runs. Each is re-read immediately
 * before a provider call, never cached across chunks.
 */
async function extractionDispatchBlocker(
    lease: MemoryExtractionLease,
    now: Date,
    environment: Record<string, string | undefined>,
    register?: readonly MemoryExtractionEvalEntry[]
): Promise<string | null> {
    if (!(await isMemoryExtractionEnabled())) return "feature_disabled";
    const user = await prisma.user.findUnique({
        where: { id: lease.userId },
        select: { plan: true },
    });
    if (!user) return "owner_missing";
    let pricing;
    try {
        ({ pricing } = await resolveEffectiveExtractionPair({
            extractionModelId: lease.extractionModelId,
            promptVersion: lease.promptVersion,
            plan: (user.plan as ModelTier) ?? "Free",
            register,
        }));
    } catch {
        return "pair_unavailable";
    }
    try {
        // Zero incremental cost: this asks whether the batch sub-budget has
        // any room left at all, before committing to a call whose cost is
        // only known afterwards.
        await assertExtractionBudget(pricing.provider, 0, now, environment);
    } catch {
        return "provider_budget_exhausted";
    }
    return null;
}

const withTimeout = async <T>(
    work: Promise<T>,
    timeoutMs: number,
    onTimeout: () => T
): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Drives one bounded slice of a run, and is the ONLY way a run advances.
 *
 * Both drivers call this — the post-response kick for low latency and the
 * fifteen-minute dispatcher for recovery — precisely so there is one
 * implementation of claiming, fencing, boundary re-checks and release, rather
 * than two that drift apart. `after()` is a latency optimisation, not a
 * durable queue: it is bound to its request's lifetime and dies with the
 * process, which is why the durable state here (and the dispatcher that reads
 * it) is what actually guarantees a run finishes.
 *
 * Never throws for an expected condition. Losing a claim, being fenced out,
 * running out of budget and hitting a disabled flag are all ordinary outcomes
 * a caller reports as metrics, not failures to retry.
 */
export async function driveMemoryExtractionRunSlice(input: {
    runId: string;
    owner: string;
    handler: ExtractionChunkHandler;
    now?: Date;
    maxChunks?: number;
    budgetMs?: number;
    chunkTimeoutMs?: number;
    environment?: Record<string, string | undefined>;
    register?: readonly MemoryExtractionEvalEntry[];
}): Promise<ExtractionSliceResult> {
    const startedAt = input.now ?? new Date();
    const environment = input.environment ?? process.env;
    const budget = extractionSliceBudget(startedAt, {
        maxChunks: input.maxChunks,
        budgetMs: input.budgetMs,
    });
    const chunkTimeoutMs =
        input.chunkTimeoutMs ?? MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS;

    const lease = await claimMemoryExtractionRun({
        runId: input.runId,
        owner: input.owner,
        now: startedAt,
    });
    if (!lease) return { chunksProcessed: 0, outcome: "not_claimed" };

    let chunksProcessed = 0;
    const stop = async (
        outcome: ExtractionSliceResult["outcome"],
        reason?: string
    ): Promise<ExtractionSliceResult> => {
        // Progress is already durable; handing the lease back just means the
        // next dispatch does not have to wait for the TTL to lapse.
        await releaseMemoryExtractionRun(lease).catch(() => false);
        return { chunksProcessed, outcome, reason };
    };

    for (;;) {
        const now = new Date();
        const gate = mayStartAnotherChunk({ chunksProcessed, budget, now });
        if (!gate.start) return stop("paused", gate.reason);

        const blocker = await extractionDispatchBlocker(
            lease,
            now,
            environment,
            input.register
        );
        if (blocker) return stop("blocked", blocker);

        if (!(await heartbeatMemoryExtractionRun(lease, now))) {
            // Superseded, cancelled or already finished. Whichever it is, this
            // worker no longer owns the run and must not release it either.
            const run = await prisma.memoryExtractionRun.findUnique({
                where: { id: lease.runId },
                select: { status: true },
            });
            return {
                chunksProcessed,
                outcome:
                    run?.status === "cancelled" ? "cancelled" : "lease_lost",
            };
        }

        const chunk = await claimNextExtractionChunk(lease, now);
        if (!chunk) {
            // No pending work under a live lease: either the run just finished
            // or another slice is holding the remaining chunks.
            const run = await prisma.memoryExtractionRun.findUnique({
                where: { id: lease.runId },
                select: { status: true },
            });
            if (run?.status === "completed") {
                return { chunksProcessed, outcome: "completed" };
            }
            if (run?.status === "failed") {
                return { chunksProcessed, outcome: "failed" };
            }
            return stop("paused", "no_pending_chunk");
        }

        // One controller per chunk. Cancelling is best-effort: the bounded
        // race below is what actually stops the slice waiting, and the abort
        // is what stops work that has not started yet from starting.
        const controller = new AbortController();
        let timedOut = false;
        const result = await withTimeout(
            input
                .handler({ lease, chunk, signal: controller.signal })
                .catch((error) => {
                    if (controller.signal.aborted) {
                        // An abort is not a handler bug. Classifying it as one
                        // would hide every timeout inside `handler_error` and
                        // make a slow provider look like broken code.
                        return {
                            outcome: "failed" as const,
                            code: "chunk_timeout",
                        };
                    }
                    console.error(
                        "memory extraction chunk handler failed",
                        error
                    );
                    return { outcome: "failed" as const, code: "handler_error" };
                }),
            chunkTimeoutMs,
            () => {
                timedOut = true;
                // Abort FIRST, then decide. A handler that returns after this
                // is describing work this slice has already written off.
                controller.abort(new Error("chunk_timeout"));
                return { outcome: "failed" as const, code: "chunk_timeout" };
            }
        );
        chunksProcessed += 1;

        // A late result must never reach the chunk's outcome. The handler may
        // still be running, and whatever it eventually produces belongs to a
        // chunk this slice has already recorded as timed out.
        const applied0 = timedOut
            ? { outcome: "failed" as const, code: "chunk_timeout" }
            : result;

        const applied = await completeExtractionChunk(
            lease,
            chunk.chunkIndex,
            applied0,
            new Date()
        );
        if (!applied.applied) {
            return {
                chunksProcessed,
                outcome:
                    applied.runStatus === "cancelled"
                        ? "cancelled"
                        : "lease_lost",
            };
        }
        if (applied.runStatus === "completed") {
            return { chunksProcessed, outcome: "completed" };
        }
        if (applied.runStatus === "failed") {
            return { chunksProcessed, outcome: "failed" };
        }
        if (applied.chunkStatus === "pending") {
            // The chunk failed but has attempts left. Ending the slice here is
            // the backoff: retrying immediately inside the same loop would burn
            // the whole retry budget within seconds of a provider outage, and
            // the chunk is durably pending for the next dispatch either way.
            return stop("paused", "chunk_failed");
        }
    }
}

/**
 * The 15-minute orphan sweep (§3): a running run whose lease expired goes
 * back to pending with its completed-chunk progress intact — resumable, not
 * destroyed. Wired into the maintenance cycle beside the import sweep.
 *
 * Reclaiming is only half of recovery: a run parked here stays pending until
 * something dispatches it. The recovery dispatcher that re-drives pending runs
 * through `driveMemoryExtractionRunSlice` lands with the driver wiring.
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
