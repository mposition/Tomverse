import "server-only";

import {
    analyzeExtractionChunk,
    type ExtractionModelAdapter,
} from "@/lib/memoryExtractionPipeline";
import { commitExtractionChunk } from "@/lib/memoryExtractionCommit";
import { recordMemoryCounter } from "@/lib/memoryMetrics";
import {
    MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS,
    estimateExtraction,
} from "@/lib/memoryExtractionCore";
import {
    createExtractionProviderAdapter,
    type ExtractionProviderResult,
} from "@/lib/memoryExtractionProvider";
import {
    admitExtractionProviderCall,
    markExtractionProviderCallIssued,
    releaseUnusedExtractionProviderCall,
    settleExtractionProviderCall,
} from "@/lib/memoryExtractionProviderCost";
import {
    driveMemoryExtractionRunSlice,
    reconcileExpiredMemoryExtractionRuns,
    resolveEffectiveExtractionPair,
    type ClaimedExtractionChunk,
    type ExtractionSliceResult,
    type MemoryExtractionLease,
} from "@/lib/memoryExtractionService";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { ExtractionSourceConversationInput } from "@/lib/memoryExtractionPrompt";
import type { AiModel, ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * What actually runs an extraction chunk, and the two things that start it
 * (policy §11, §11.1).
 *
 * Every other piece of this feature already existed and none of them was
 * connected: the pipeline could analyse a chunk, the persistence step could
 * store its decisions, the credits module could reserve and settle, and
 * `driveMemoryExtractionRunSlice` could claim, fence and loop -- but it takes
 * a handler, and nothing supplied one. A run therefore sat at `pending`
 * forever, because nothing ever drove it.
 *
 * Three layers meet in the handler, and they are deliberately not the same
 * layer (§3, §11):
 *
 *   * **user credits** are reserved for the whole run and settled at a
 *     terminal state by the run service. Nothing here touches them, and a
 *     failed chunk is refunded because the user did not get it;
 *   * **operational provider cost** is per actual call. It is released only
 *     when no request went out; otherwise it is settled whatever happened
 *     afterwards — an abort, a lost lease, or a chunk this slice already
 *     wrote off;
 *   * **candidates** are written by a separate fenced transaction, and this
 *     handler performs no candidate write of its own. That is what makes a
 *     late return from a timed-out handler harmless: there is nothing for it
 *     to land.
 *
 * The two drivers are here together because §11.1 requires them to share one
 * slice processor. They differ only in what starts them:
 *
 *   * the post-response kick is a latency optimisation. It is bound to its
 *     request's lifetime and dies with the process, so it is not, and must
 *     never be treated as, a durable queue;
 *   * the fifteen-minute dispatcher is what actually guarantees a run
 *     finishes. It reclaims orphaned leases and then re-drives what it
 *     reclaimed -- reclaiming alone leaves the run waiting for a request that
 *     may never come.
 */

/**
 * Bounded so one dispatch cannot monopolise a maintenance cycle. Runs that do
 * not fit are not lost: they stay `pending` and the next cycle takes them,
 * oldest first, so nothing starves behind a busy account.
 */
export const MAX_RUNS_PER_DISPATCH = 5;

/**
 * And a wall-clock ceiling for the whole pass, because a run count is not a
 * time bound.
 *
 * One slice is allowed `MEMORY_EXTRACTION_SLICE_BUDGET_MS` (90s), so five runs
 * driven back to back is seven and a half minutes inside a request that also
 * reconciles credits, drains the notification queue and sweeps refunds. §11.1
 * requires extraction latency not to delay that work, and bounding the number
 * of runs does not bound the time they take.
 *
 * The remaining budget is handed down as each run's own slice budget, so a run
 * cannot keep starting chunks after the pass is out of time. Work not reached
 * is durable and waits for the next pass, fifteen minutes later.
 *
 * Two minutes, and it has to exceed one chunk timeout by enough for a second
 * run to qualify -- a ceiling equal to the timeout would silently cap every
 * pass at one run. The bound is not exact: a chunk already claimed is always
 * allowed to finish and report, so a pass can overrun by at most one chunk
 * timeout. That is why this step is ordered last in the maintenance route --
 * an overrun then delays only the response, never the credit, refund and
 * notification work §11.1 is protecting.
 */
export const MEMORY_EXTRACTION_DISPATCH_BUDGET_MS = 120_000;

/**
 * Below this there is no point starting *another* run: a slice that begins
 * with less time than one chunk's timeout can only stop at its first boundary,
 * having claimed and released a lease for nothing.
 *
 * It gates continuing, never starting. The first pending run is always
 * dispatched, whatever the ceiling says, so a pass makes progress rather than
 * deferring the same run forever -- and its slice still cannot outlive the
 * pass, because the remaining time is handed down as its own budget.
 */
const MIN_CONTINUE_BUDGET_MS = MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS;

/**
 * Ceiling on what one chunk's answer may cost. The prompt asks for a small
 * JSON array; an answer far past this is a model that has stopped following
 * the format, and paying for the rest of it buys nothing.
 */
const CHUNK_MAX_OUTPUT_TOKENS = 4_096;

/**
 * The provider call, as the pipeline sees it.
 *
 * Deliberately the *approved pair's* model, resolved from the lease rather
 * than from configuration read at call time: §11 forbids falling back to
 * another model or another prompt version, and the lease is what the user
 * confirmed and what the reservation was priced against. A pair that has
 * since been revoked or disabled never reaches this function — the handler
 * fails the chunk first, because silently substituting a model would charge
 * the user for one thing and run another.
 *
 * The hooks are not decoration. `onCallIssued` runs before the request
 * leaves so a crash mid-flight is still recoverable as "may have cost
 * something", and `signal` is the chunk's deadline so a request that has not
 * been sent is never sent.
 */
export const extractionModelAdapter: ExtractionAdapterFactory = (input) =>
    createExtractionProviderAdapter({
        model: input.model,
        maxOutputTokens: CHUNK_MAX_OUTPUT_TOKENS,
        signal: input.signal,
        onCallIssued: input.onCallIssued,
        onResult: input.onResult,
    });

/**
 * Loads exactly the conversations this chunk was planned around.
 *
 * Scoped to the run's owner as well as to the ids: the chunk plan is stored
 * data, and a stored id is not on its own a statement that the account still
 * owns that conversation. Ordering is by id so the same chunk always produces
 * the same prompt — `promptVersion` means nothing reproducible otherwise, and
 * the label map the parser uses is assigned by position.
 */
async function loadChunkConversations(
    userId: string,
    conversationIds: readonly string[]
): Promise<{
    conversations: ExtractionSourceConversationInput[];
    contentBytes: number;
}> {
    if (conversationIds.length === 0)
        return { conversations: [], contentBytes: 0 };
    const rows = await prisma.externalConversation.findMany({
        where: { id: { in: [...conversationIds] }, userId },
        orderBy: { id: "asc" },
        select: {
            id: true,
            title: true,
            contentBytes: true,
            messages: {
                orderBy: [{ ordinal: "asc" }, { id: "asc" }],
                select: {
                    id: true,
                    role: true,
                    content: true,
                    contentDigest: true,
                },
            },
        },
    });
    const conversations = rows.map((row) => ({
        externalConversationId: row.id,
        title: row.title,
        messages: row.messages
            // Only the two roles the prompt has labels for. A system or tool
            // turn from an imported export is not evidence about the user.
            .filter(
                (message): message is typeof message & {
                    role: "user" | "assistant";
                } => message.role === "user" || message.role === "assistant"
            )
            .map((message) => ({
                externalMessageId: message.id,
                role: message.role,
                content: message.content,
                contentDigest: message.contentDigest,
            })),
    }));
    return {
        conversations,
        // Carried alongside rather than inside the prompt input: the estimate
        // prices the chunk, and the prompt builder has no business knowing
        // what a conversation costs.
        contentBytes: rows.reduce(
            (total, row) => total + Number(row.contentBytes),
            0
        ),
    };
}

/**
 * How the handler reaches a model. Injectable for one reason: without a seam
 * here, every test of this function is a live provider call, so the storage
 * rules and the failure classification below could only be tested by paying
 * for them. Production always uses the default.
 */
export type ExtractionAdapterFactory = (input: {
    extractionModelId: string;
    model: AiModel;
    signal: AbortSignal;
    /** Awaited before the request leaves, so the cost is durable first. */
    onCallIssued: () => Promise<void> | void;
    onResult: (result: ExtractionProviderResult) => void;
}) => ExtractionModelAdapter;

/** A signal that is never aborted, for callers with no deadline of their own. */
const neverAborted = () => new AbortController().signal;

/**
 * One chunk: read its conversations, ask the model, hand the result to the
 * fenced commit. Returns a failure rather than throwing for anything the run
 * can retry — the driver counts attempts and decides when a chunk is spent.
 *
 * The step order exists so each failure is safe: admit the operational cost →
 * mark it issued durably, before the request → call → commit under the fence →
 * settle the cost regardless of what the commit decided. A worker fenced out
 * after its call still spent the money, and the guardrail has to see it.
 */
export async function handleMemoryExtractionChunk({
    lease,
    chunk,
    signal = neverAborted(),
    adapterFactory = extractionModelAdapter,
    register,
    environment,
}: {
    lease: MemoryExtractionLease;
    chunk: ClaimedExtractionChunk;
    signal?: AbortSignal;
    adapterFactory?: ExtractionAdapterFactory;
    register?: readonly MemoryExtractionEvalEntry[];
    environment?: Record<string, string | undefined>;
}): Promise<{ outcome: "completed" } | { outcome: "failed"; code: string }> {
    const failed = (code: string) => ({ outcome: "failed" as const, code });

    // Cheapest possible exit: the slice may already have given up before this
    // handler got its turn.
    if (signal.aborted) return failed("chunk_timeout");

    const { conversations, contentBytes } = await loadChunkConversations(
        lease.userId,
        chunk.conversationIds
    );
    if (conversations.length === 0) {
        // The plan named conversations that are gone — deleted, or their
        // import removed — so there is nothing to extract and nothing to
        // retry. Completing rather than failing lets the run finish; §13.1
        // already decided that deleting a source does not strand the run.
        return { outcome: "completed" };
    }

    const owner = await prisma.user.findUnique({
        where: { id: lease.userId },
        select: { plan: true },
    });
    let pricing;
    let model;
    try {
        // Re-resolved here rather than cached from run creation: a pair can be
        // revoked without a deploy, and a plan can change while a run sits
        // pending (§12.1).
        ({ pricing, model } = await resolveEffectiveExtractionPair({
            extractionModelId: lease.extractionModelId,
            promptVersion: lease.promptVersion,
            plan:
                owner?.plan === "Pro" || owner?.plan === "Max"
                    ? (owner.plan as ModelTier)
                    : "Free",
            register,
        }));
    } catch {
        return failed("pair_unavailable");
    }

    const chunkRow = await prisma.memoryExtractionChunk.findUnique({
        where: {
            runId_chunkIndex: {
                runId: lease.runId,
                chunkIndex: chunk.chunkIndex,
            },
        },
        select: { id: true },
    });
    if (!chunkRow) return failed("chunk_missing");

    const tier = pricing.tiers[0];
    const estimate = estimateExtraction(
        [
            {
                conversationIds: conversations.map(
                    (conversation) => conversation.externalConversationId
                ),
                contentBytes,
            },
        ],
        {
            inputMicroUsdPerMTokens: tier.inputUsdPerMillionTokens * 1_000_000,
            outputMicroUsdPerMTokens: tier.outputUsdPerMillionTokens * 1_000_000,
            // Credits are the run's business, settled once at a terminal
            // state. This estimate exists only to reserve operational cost.
            creditsPerCall: 0,
        }
    );

    const admission = await admitExtractionProviderCall({
        chunkId: chunkRow.id,
        attemptCount: chunk.attemptCount,
        provider: pricing.provider,
        modelId: lease.extractionModelId,
        estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
        environment,
    });
    if (!admission.admitted) return failed(`budget_${admission.scope}`);

    let callIssued = false;
    let providerResult: ExtractionProviderResult | null = null;
    const settledUsage = () => {
        const usage = providerResult?.usage ?? { usageFromProvider: false };
        return {
            ...usage,
            actualCostMicroUsd: usage.usageFromProvider
                ? Math.ceil(
                      (usage.inputTokens ?? 0) * tier.inputUsdPerMillionTokens +
                          (usage.outputTokens ?? 0) *
                              tier.outputUsdPerMillionTokens
                  )
                : undefined,
            responseId: providerResult?.responseId ?? null,
        };
    };
    /**
     * The one rule that separates this layer from the user's credits: a
     * request that went out is never given back. The user is refunded a
     * failed chunk because they did not get it; the provider may still have
     * billed for it, and erasing that would let a run that keeps failing
     * consume an unbounded share of a budget that reads as untouched.
     */
    const closeCost = async (failureCode?: string) => {
        if (!callIssued) {
            await releaseUnusedExtractionProviderCall({
                providerCallId: admission.providerCallId,
                // A reservation released without a request still records why
                // it never went out, so an account whose pairs keep
                // disappearing is visible rather than silent.
                failureCode: failureCode ?? "released",
            }).catch(() => ({ released: false }));
            return;
        }
        await settleExtractionProviderCall({
            providerCallId: admission.providerCallId,
            usage: settledUsage(),
            failureCode,
        }).catch(() => ({ settled: false }));
    };

    let analysis;
    try {
        analysis = await analyzeExtractionChunk({
            conversations,
            adapter: adapterFactory({
                extractionModelId: lease.extractionModelId,
                model,
                signal,
                onCallIssued: async () => {
                    // Durable before the request leaves, so a crash here is
                    // recoverable as "may have cost something".
                    callIssued = true;
                    await markExtractionProviderCallIssued(
                        admission.providerCallId
                    );
                },
                onResult: (result) => {
                    providerResult = result;
                },
            }),
        });
    } catch (error) {
        const aborted = signal.aborted;
        await closeCost(aborted ? "chunk_timeout" : "provider_error");
        console.error(
            JSON.stringify({
                event: "memory_extraction_chunk_provider_failed",
                runId: lease.runId,
                chunkIndex: chunk.chunkIndex,
                aborted,
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
        return failed(aborted ? "chunk_timeout" : "provider_error");
    }

    // An answer that parsed into nothing while reporting problems is a broken
    // answer, not an empty result: storing zero candidates for it would record
    // "this chunk had nothing to say" about a chunk nobody actually read.
    // Zero decisions with zero problems is a genuine empty result.
    if (analysis.decisions.length === 0 && analysis.problems.length > 0) {
        await closeCost("unparseable_answer");
        return failed("unparseable_answer");
    }

    // Fenced, and separate: this handler writes no candidate of its own, which
    // is what makes a late return from a timed-out chunk harmless.
    const commit = await commitExtractionChunk({
        lease,
        chunkIndex: chunk.chunkIndex,
        extractionModelId: lease.extractionModelId,
        promptVersion: lease.promptVersion,
        decisions: analysis.decisions,
    });
    await closeCost(commit.committed ? undefined : "fenced_out");

    if (commit.committed && commit.unsourced > 0) {
        // Recorded after the transaction, never inside it: a counter written
        // in a transaction that then rolls back reports work nothing did.
        // §22 gets its own kind here because a dropped candidate leaves no row
        // -- the whole point is that it was not stored.
        void recordMemoryCounter(
            "extraction_evidence_unverified",
            commit.unsourced
        );
    }

    // Content-free, per §22: counts only, never a statement.
    console.info(
        JSON.stringify({
            event: "memory_extraction_chunk_completed",
            runId: lease.runId,
            chunkIndex: chunk.chunkIndex,
            attempt: chunk.attemptCount,
            conversations: conversations.length,
            committed: commit.committed,
            ...(commit.committed
                ? {
                      stored: commit.stored,
                      individualReview: commit.individualReview,
                      discarded: commit.discarded,
                      unsourced: commit.unsourced,
                  }
                : { reason: commit.reason }),
            parseProblems: analysis.problems.length,
            usageConfirmed: settledUsage().usageFromProvider,
        })
    );

    if (!commit.committed) return failed("lease_lost");
    return { outcome: "completed" };
}

/**
 * Drives one run with the production handler.
 *
 * `owner` names which driver claimed it, so a run that keeps being taken over
 * mid-slice is diagnosable from the lease alone.
 */
export function driveMemoryExtractionRun(input: {
    runId: string;
    owner: string;
    now?: Date;
    adapterFactory?: ExtractionAdapterFactory;
    /**
     * Injected only by tests. Omitted, the driver re-checks the pair against
     * the shipped register on every chunk, which is what keeps §12.4's
     * fail-closed gate true for a run that was created while a pair was
     * approved and revoked halfway through.
     */
    register?: readonly MemoryExtractionEvalEntry[];
    /** Injected only by tests, so budget ceilings are deterministic. */
    environment?: Record<string, string | undefined>;
    /**
     * Caps this slice below its own default, so a run started by a dispatch
     * pass cannot outlive the pass. Omitted, the slice uses
     * `MEMORY_EXTRACTION_SLICE_BUDGET_MS`.
     */
    budgetMs?: number;
    /**
     * Caps how many chunks this slice attempts. Used by the kick, which is not
     * a worker with its own lifetime.
     */
    maxChunks?: number;
}): Promise<ExtractionSliceResult> {
    return driveMemoryExtractionRunSlice({
        runId: input.runId,
        owner: input.owner,
        environment: input.environment,
        handler: ({ lease, chunk, signal }) =>
            handleMemoryExtractionChunk({
                lease,
                chunk,
                signal,
                adapterFactory: input.adapterFactory,
                register: input.register,
                environment: input.environment,
            }),
        now: input.now,
        register: input.register,
        budgetMs: input.budgetMs,
        maxChunks: input.maxChunks,
    });
}

/**
 * How much of a run the post-response kick attempts: one chunk.
 *
 * Next's `after` reference states the callback "will run for the platform's
 * default or configured max duration of your route", so the kick is not a
 * background worker with its own lifetime -- it is time borrowed from a
 * request that has already answered. A kick that tried to finish the run would
 * routinely be killed part-way, and a kick killed mid-chunk leaves the run
 * `running` under a lease that has to lapse before the dispatcher can reclaim
 * it. The driver meant to reduce latency would then be adding a lease TTL
 * to it.
 *
 * One chunk is the useful amount: the user sees the run move immediately, and
 * finishing it is the dispatcher's job -- the division of labour §11.1
 * describes.
 */
const KICK_MAX_CHUNKS = 1;

/**
 * The post-response kick (§11.1).
 *
 * Started from `after()` so the user's request is not held open by work that
 * belongs to a background run. It never throws: a kick that fails is a
 * latency regression, not a lost run — the dispatcher below will pick the run
 * up regardless, which is exactly why the kick is allowed to be best-effort.
 */
export async function kickMemoryExtractionRun(runId: string): Promise<void> {
    try {
        const result = await driveMemoryExtractionRun({
            runId,
            owner: `kick:${runId}`,
            maxChunks: KICK_MAX_CHUNKS,
        });
        console.info(
            JSON.stringify({
                event: "memory_extraction_kick",
                runId,
                outcome: result.outcome,
                chunksProcessed: result.chunksProcessed,
                ...(result.reason ? { reason: result.reason } : {}),
            })
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "memory_extraction_kick_failed",
                runId,
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
    }
}

export type MemoryExtractionDispatchResult = {
    reclaimedRuns: number;
    dispatchedRuns: number;
    chunksProcessed: number;
    /** Pending runs this pass had no time left for; the next pass takes them. */
    skippedForTime: number;
};

/**
 * The fifteen-minute recovery dispatcher (§11.1).
 *
 * Reclaims first, then drives what it reclaimed along with everything else
 * already waiting. The order matters: a run whose worker died is `running`
 * with a lease nobody holds, and the claim is fenced on `leaseGeneration`
 * rather than on a deadline, so it does not become claimable until the sweep
 * moves it back to `pending`. Reclaiming without then driving is the failure
 * §11.1 names — the run is claimable and nothing claims it.
 *
 * One run's failure does not stop the cycle: each is driven independently and
 * a thrown error is logged and stepped over, because the alternative is one
 * poisoned run blocking every other account's recovery.
 *
 * The pass is bounded twice over, by `maxRuns` and by wall clock. Only the
 * second bound is a statement about how long maintenance is held: five runs is
 * five slice budgets, and the run count says nothing about that.
 */
export async function dispatchPendingMemoryExtractionRuns(
    now: Date = new Date(),
    maxRuns: number = MAX_RUNS_PER_DISPATCH,
    overrides: {
        adapterFactory?: ExtractionAdapterFactory;
        register?: readonly MemoryExtractionEvalEntry[];
        environment?: Record<string, string | undefined>;
        budgetMs?: number;
    } = {}
): Promise<MemoryExtractionDispatchResult> {
    const { reclaimedRuns } = await reconcileExpiredMemoryExtractionRuns(now);

    const pending = await prisma.memoryExtractionRun.findMany({
        where: { status: "pending" },
        // Oldest first: a run that has been waiting longest is the one whose
        // owner has been waiting longest, and it keeps a busy account from
        // starving the queue behind it.
        orderBy: { createdAt: "asc" },
        take: maxRuns,
        select: { id: true },
    });

    // Anchored on the real clock rather than on `now`: `now` is the sweep's
    // logical timestamp and the tests move it freely, but the budget this
    // guards is elapsed time inside one maintenance request.
    const deadline =
        Date.now() +
        Math.max(
            1,
            overrides.budgetMs ?? MEMORY_EXTRACTION_DISPATCH_BUDGET_MS
        );

    let attemptedRuns = 0;
    let dispatchedRuns = 0;
    let chunksProcessed = 0;
    let skippedForTime = 0;
    for (const run of pending) {
        const remaining = deadline - Date.now();
        if (attemptedRuns > 0 && remaining < MIN_CONTINUE_BUDGET_MS) {
            // Reported rather than silently dropped: a pass that keeps running
            // out of time is a signal that the interval, the run count or the
            // slice budget is wrong, and a silent skip reads as "there was
            // nothing to do".
            skippedForTime = pending.length - attemptedRuns;
            break;
        }
        attemptedRuns += 1;
        try {
            const result = await driveMemoryExtractionRun({
                runId: run.id,
                owner: `dispatch:${now.toISOString()}`,
                now,
                adapterFactory: overrides.adapterFactory,
                register: overrides.register,
                environment: overrides.environment,
                // A run's slice may not outlive the pass that started it. The
                // first run gets whatever is left even if that is little: a
                // slice that stops at its first boundary parks the run
                // cleanly, which still beats never starting it.
                budgetMs: Math.max(1, remaining),
            });
            if (result.outcome !== "not_claimed") dispatchedRuns += 1;
            chunksProcessed += result.chunksProcessed;
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: "memory_extraction_dispatch_failed",
                    runId: run.id,
                    errorName:
                        error instanceof Error ? error.name : "UnknownError",
                })
            );
        }
    }

    if (reclaimedRuns > 0 || dispatchedRuns > 0 || skippedForTime > 0) {
        console.info(
            JSON.stringify({
                event: "memory_extraction_dispatch",
                reclaimedRuns,
                dispatchedRuns,
                chunksProcessed,
                skippedForTime,
            })
        );
    }
    return { reclaimedRuns, dispatchedRuns, chunksProcessed, skippedForTime };
}
