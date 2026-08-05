import "server-only";

import { generateText } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModel } from "@/lib/models";
import {
    analyzeExtractionChunk,
    type ExtractionModelAdapter,
} from "@/lib/memoryExtractionPipeline";
import { MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS } from "@/lib/memoryExtractionCore";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import {
    driveMemoryExtractionRunSlice,
    reconcileExpiredMemoryExtractionRuns,
    type ClaimedExtractionChunk,
    type ExtractionSliceResult,
    type MemoryExtractionLease,
} from "@/lib/memoryExtractionService";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { ExtractionSourceConversationInput } from "@/lib/memoryExtractionPrompt";
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
 * Deliberately the *approved pair's* model, taken from the lease rather than
 * from configuration read at call time: §11 forbids falling back to another
 * model or another prompt version, and the lease is what the user confirmed
 * and what the reservation was priced against. A model that has since been
 * disabled makes this throw, which the driver records as a chunk failure —
 * the right outcome, because silently substituting a model would charge the
 * user for one thing and run another.
 */
export function extractionModelAdapter(
    extractionModelId: string
): ExtractionModelAdapter {
    return async ({ prompt }) => {
        const model = getModel(extractionModelId);
        // The lease named a model the catalogue no longer has. Throwing is the
        // honest outcome: the driver records a chunk failure, and the run
        // reaches its retry cap instead of quietly running something the user
        // did not confirm and the reservation was not priced against.
        if (!model) {
            throw new Error(
                `Extraction model ${extractionModelId} is no longer available.`
            );
        }
        const result = await generateText({
            model: getActiveAiModel(model),
            messages: [
                { role: "system", content: prompt.system },
                { role: "user", content: prompt.user },
            ],
            maxOutputTokens: CHUNK_MAX_OUTPUT_TOKENS,
        });
        return { text: result.text };
    };
}

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
): Promise<ExtractionSourceConversationInput[]> {
    if (conversationIds.length === 0) return [];
    const rows = await prisma.externalConversation.findMany({
        where: { id: { in: [...conversationIds] }, userId },
        orderBy: { id: "asc" },
        select: {
            id: true,
            title: true,
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
    return rows.map((row) => ({
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
}

/**
 * How the handler reaches a model. Injectable for one reason: without a seam
 * here, every test of this function is a live provider call, so the storage
 * rules and the failure classification below could only be tested by paying
 * for them. Production always uses the default.
 */
export type ExtractionAdapterFactory = (
    extractionModelId: string
) => ExtractionModelAdapter;

/**
 * One chunk: read its conversations, ask the model, store what the validator
 * allows. Returns a failure rather than throwing for anything the run can
 * retry — the driver counts attempts and decides when a chunk is spent.
 */
export async function handleMemoryExtractionChunk({
    lease,
    chunk,
    adapterFactory = extractionModelAdapter,
}: {
    lease: MemoryExtractionLease;
    chunk: ClaimedExtractionChunk;
    adapterFactory?: ExtractionAdapterFactory;
}): Promise<{ outcome: "completed" } | { outcome: "failed"; code: string }> {
    const conversations = await loadChunkConversations(
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

    let analysis;
    try {
        analysis = await analyzeExtractionChunk({
            conversations,
            adapter: adapterFactory(lease.extractionModelId),
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "memory_extraction_chunk_provider_failed",
                runId: lease.runId,
                chunkIndex: chunk.chunkIndex,
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
        return { outcome: "failed", code: "provider_error" };
    }

    // An answer that parsed into nothing while reporting problems is a broken
    // answer, not an empty result: storing zero candidates for it would record
    // "this chunk had nothing to say" about a chunk nobody actually read.
    // Zero decisions with zero problems is a genuine empty result.
    if (analysis.decisions.length === 0 && analysis.problems.length > 0) {
        return { outcome: "failed", code: "unparseable_answer" };
    }

    const stored = await prisma.$transaction((tx) =>
        persistExtractionChunkDecisions(tx, {
            userId: lease.userId,
            runId: lease.runId,
            chunkIndex: chunk.chunkIndex,
            extractionModelId: lease.extractionModelId,
            promptVersion: lease.promptVersion,
            decisions: analysis.decisions,
        })
    );

    // Content-free, per §22: counts only, never a statement.
    console.info(
        JSON.stringify({
            event: "memory_extraction_chunk_completed",
            runId: lease.runId,
            chunkIndex: chunk.chunkIndex,
            attempt: chunk.attemptCount,
            conversations: conversations.length,
            stored: stored.stored,
            individualReview: stored.individualReview,
            discarded: stored.discarded,
            replaced: stored.replaced,
        })
    );
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
    /**
     * Caps this slice below its own default, so a run started by a dispatch
     * pass cannot outlive the pass. Omitted, the slice uses
     * `MEMORY_EXTRACTION_SLICE_BUDGET_MS`.
     */
    budgetMs?: number;
}): Promise<ExtractionSliceResult> {
    return driveMemoryExtractionRunSlice({
        runId: input.runId,
        owner: input.owner,
        handler: ({ lease, chunk }) =>
            handleMemoryExtractionChunk({
                lease,
                chunk,
                adapterFactory: input.adapterFactory,
            }),
        now: input.now,
        register: input.register,
        budgetMs: input.budgetMs,
    });
}

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
