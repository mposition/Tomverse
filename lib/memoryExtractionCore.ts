/**
 * Pure arithmetic for memory extraction runs (Release B, slice B2).
 *
 * docs/policy/external-conversation-import-and-memory.md §3, §11.
 *
 * No Prisma, no `server-only`: chunk planning, the credit/cost estimate the
 * user confirms before a run exists, the batch sub-budget resolution and the
 * lease clock are all testable without a database. The service
 * (lib/memoryExtractionService.ts) owns every read and write.
 */

export type ExtractionSourceConversation = {
    id: string;
    messageCount: number;
    contentBytes: number;
};

/**
 * One chunk is one extraction model call. Conversation boundaries are chunk
 * boundaries — a conversation is never split across calls, mirroring the
 * Release A batch rule, so chunk-level retry and idempotent settlement stay
 * whole-unit operations.
 */
export const MEMORY_EXTRACTION_CHUNK_MAX_BYTES = 120_000;
export const MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS = 10;

/** Lease clock (§3): heartbeat renews; the 15-minute sweep clears orphans. */
export const MEMORY_EXTRACTION_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * One dispatch drives a bounded *slice* of a run, never the whole run.
 *
 * Both drivers are hosted processes with a finite request lifetime — the
 * post-response kick runs inside the request that spawned it, and the
 * recovery dispatcher rides the fifteen-minute maintenance schedule — so a
 * driver that tried to finish a 200-chunk run in one go would simply be
 * killed mid-flight. Bounding the slice makes stopping normal: the worker
 * hands the lease back, the run stays `pending` with its progress intact, and
 * the next dispatch continues.
 *
 * The chunk deadline is well inside the lease TTL so a slice that runs to the
 * end of its budget still has lease left to release itself cleanly.
 */
export const MEMORY_EXTRACTION_SLICE_MAX_CHUNKS = 4;
export const MEMORY_EXTRACTION_SLICE_BUDGET_MS = 90 * 1000;
export const MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS = 60 * 1000;

/**
 * How long the confirmed quote stays usable. Reservations are taken per chunk
 * just before it runs, so a run parked for days would otherwise start
 * charging against pricing nobody agreed to. Past this the run stops for a
 * re-quote rather than reserving at whatever the price is now.
 */
export const MEMORY_EXTRACTION_QUOTE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounded retry (§11): a chunk that keeps killing its worker gives up. */
export const MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS = 3;

export type ExtractionSliceBudget = {
    maxChunks: number;
    /** Absolute wall-clock deadline for the whole slice. */
    deadline: Date;
};

export function extractionSliceBudget(
    startedAt: Date,
    overrides: Partial<{ maxChunks: number; budgetMs: number }> = {}
): ExtractionSliceBudget {
    return {
        maxChunks: overrides.maxChunks ?? MEMORY_EXTRACTION_SLICE_MAX_CHUNKS,
        deadline: new Date(
            startedAt.getTime() +
                (overrides.budgetMs ?? MEMORY_EXTRACTION_SLICE_BUDGET_MS)
        ),
    };
}

/**
 * Whether another chunk may start. Checked *before* claiming, so the budget
 * bounds work started rather than work finished — a chunk already in flight
 * is always allowed to finish and report, which is what keeps the durable
 * state and the provider call in agreement.
 */
export function mayStartAnotherChunk(input: {
    chunksProcessed: number;
    budget: ExtractionSliceBudget;
    now: Date;
}): { start: true } | { start: false; reason: "chunk_budget" | "time_budget" } {
    if (input.chunksProcessed >= input.budget.maxChunks) {
        return { start: false, reason: "chunk_budget" };
    }
    if (input.now.getTime() >= input.budget.deadline.getTime()) {
        return { start: false, reason: "time_budget" };
    }
    return { start: true };
}

/**
 * What a failed chunk becomes. Below the cap it returns to `pending` and is
 * retried by a later slice; at the cap it is terminal and fails the run,
 * because a chunk that has burned its attempts is not going to succeed by
 * being retried a fourth time — and a run that silently stalled would be
 * worse than one that reports failure.
 */
export function chunkFailureDisposition(input: {
    attemptCount: number;
    maxAttempts?: number;
}): { status: "pending" } | { status: "failed" } {
    const max = input.maxAttempts ?? MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS;
    return input.attemptCount >= max ? { status: "failed" } : { status: "pending" };
}

/**
 * Conservative token arithmetic for the pre-run estimate (§11): UTF-8 bytes
 * over three per input token (safe for CJK-heavy content), a fixed prompt
 * overhead per call, and a conservative output allowance per chunk. The
 * basis stays `conservative_default` (§23/§3.1 of the default-model policy)
 * until the p90 conditions are met.
 */
export const MEMORY_EXTRACTION_ESTIMATE_BASIS = "conservative_default";
export const MEMORY_EXTRACTION_INPUT_BYTES_PER_TOKEN = 3;
export const MEMORY_EXTRACTION_PROMPT_OVERHEAD_TOKENS = 1_200;
export const MEMORY_EXTRACTION_OUTPUT_TOKENS_PER_CHUNK = 2_000;

export type ExtractionChunkPlan = {
    /** Conversation IDs in this chunk, in selection order. */
    conversationIds: string[];
    contentBytes: number;
};

export class MemoryExtractionPlanError extends Error {
    constructor(
        message: string,
        public readonly reason: "conversation_too_large" | "empty_selection"
    ) {
        super(message);
        this.name = "MemoryExtractionPlanError";
    }
}

export function planExtractionChunks(
    conversations: readonly ExtractionSourceConversation[]
): ExtractionChunkPlan[] {
    if (conversations.length === 0) {
        throw new MemoryExtractionPlanError(
            "An extraction run needs at least one conversation.",
            "empty_selection"
        );
    }
    const chunks: ExtractionChunkPlan[] = [];
    let current: ExtractionChunkPlan = { conversationIds: [], contentBytes: 0 };
    const flush = () => {
        if (current.conversationIds.length === 0) return;
        chunks.push(current);
        current = { conversationIds: [], contentBytes: 0 };
    };
    for (const conversation of conversations) {
        if (conversation.contentBytes > MEMORY_EXTRACTION_CHUNK_MAX_BYTES) {
            // An oversized conversation still gets exactly one whole chunk:
            // splitting it would put half a conversation in front of the
            // model, and §11's whole-unit retry contract would be lost. The
            // estimate charges it as its own (larger) call.
            flush();
            chunks.push({
                conversationIds: [conversation.id],
                contentBytes: conversation.contentBytes,
            });
            continue;
        }
        if (
            current.conversationIds.length >=
                MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS ||
            current.contentBytes + conversation.contentBytes >
                MEMORY_EXTRACTION_CHUNK_MAX_BYTES
        ) {
            flush();
        }
        current.conversationIds.push(conversation.id);
        current.contentBytes += conversation.contentBytes;
    }
    flush();
    return chunks;
}

export type ExtractionEstimate = {
    chunkCount: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    /** Internal figure for the operational budget check — never user-facing. */
    estimatedCostMicroUsd: number;
    /** Entitlement figure the user confirms: chunk count × per-call credits. */
    estimatedCredits: number;
    /** One chunk's share, stored per chunk so a just-in-time reservation can
     * be checked against the confirmed ceiling without re-planning. */
    creditsPerChunk: number;
    basis: typeof MEMORY_EXTRACTION_ESTIMATE_BASIS;
};

export function estimateExtraction(
    chunks: readonly ExtractionChunkPlan[],
    pricing: {
        inputMicroUsdPerMTokens: number;
        outputMicroUsdPerMTokens: number;
        creditsPerCall: number;
    }
): ExtractionEstimate {
    let inputTokens = 0;
    for (const chunk of chunks) {
        inputTokens +=
            Math.ceil(
                chunk.contentBytes / MEMORY_EXTRACTION_INPUT_BYTES_PER_TOKEN
            ) + MEMORY_EXTRACTION_PROMPT_OVERHEAD_TOKENS;
    }
    const outputTokens =
        chunks.length * MEMORY_EXTRACTION_OUTPUT_TOKENS_PER_CHUNK;
    const costMicroUsd = Math.ceil(
        (inputTokens * pricing.inputMicroUsdPerMTokens) / 1_000_000 +
            (outputTokens * pricing.outputMicroUsdPerMTokens) / 1_000_000
    );
    return {
        chunkCount: chunks.length,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens,
        estimatedCostMicroUsd: costMicroUsd,
        estimatedCredits: chunks.length * pricing.creditsPerCall,
        creditsPerChunk: pricing.creditsPerCall,
        basis: MEMORY_EXTRACTION_ESTIMATE_BASIS,
    };
}

/**
 * §3 batch sub-budget resolution, per window. Default 10% of the provider's
 * enforced budget (§23 item 5); an absolute override may narrow or widen the
 * share but can never exceed the provider budget itself — batch never
 * borrows the interactive share's ceiling.
 */
export const MEMORY_EXTRACTION_DEFAULT_BUDGET_PERCENT = 10;

export function resolveMemoryExtractionSubBudget(input: {
    providerBudgetMicroUsd: number;
    percentOverride?: number | null;
    absoluteOverrideMicroUsd?: number | null;
}): number {
    const percent =
        input.percentOverride != null &&
        Number.isFinite(input.percentOverride) &&
        input.percentOverride > 0
            ? input.percentOverride
            : MEMORY_EXTRACTION_DEFAULT_BUDGET_PERCENT;
    const fromPercent = Math.floor(
        (input.providerBudgetMicroUsd * percent) / 100
    );
    const resolved =
        input.absoluteOverrideMicroUsd != null &&
        Number.isSafeInteger(input.absoluteOverrideMicroUsd) &&
        input.absoluteOverrideMicroUsd >= 0
            ? input.absoluteOverrideMicroUsd
            : fromPercent;
    return Math.min(resolved, input.providerBudgetMicroUsd);
}

export type MemoryExtractionBudgetDecision =
    | { allowed: true }
    | {
          allowed: false;
          window: "day" | "month";
          scope: "batch_sub_budget" | "provider_total";
          resetAt: string;
      };

/**
 * The §3 double check: the provider's total budget still binds, and the
 * batch sub-budget binds on top of it. Evaluated with the run's estimated
 * cost so a run that cannot fit is refused before any chunk executes.
 */
export function decideMemoryExtractionBudget(input: {
    estimatedCostMicroUsd: number;
    day: {
        providerLimit: number;
        providerUsed: number;
        subBudgetLimit: number;
        subBudgetUsed: number;
        resetAt: string;
    };
    month: {
        providerLimit: number;
        providerUsed: number;
        subBudgetLimit: number;
        subBudgetUsed: number;
        resetAt: string;
    };
}): MemoryExtractionBudgetDecision {
    for (const window of ["day", "month"] as const) {
        const scope = input[window];
        if (
            scope.providerUsed + input.estimatedCostMicroUsd >
            scope.providerLimit
        ) {
            return {
                allowed: false,
                window,
                scope: "provider_total",
                resetAt: scope.resetAt,
            };
        }
        if (
            scope.subBudgetUsed + input.estimatedCostMicroUsd >
            scope.subBudgetLimit
        ) {
            return {
                allowed: false,
                window,
                scope: "batch_sub_budget",
                resetAt: scope.resetAt,
            };
        }
    }
    return { allowed: true };
}

export function isRunLeaseExpired(
    run: { leaseExpiresAt: Date | null },
    now: Date = new Date()
): boolean {
    return (
        run.leaseExpiresAt !== null &&
        run.leaseExpiresAt.getTime() <= now.getTime()
    );
}
