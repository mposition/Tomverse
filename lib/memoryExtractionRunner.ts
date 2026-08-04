import "server-only";

import {
    MEMORY_EXTRACTION_OUTPUT_TOKENS_PER_CHUNK,
    estimateExtraction,
} from "@/lib/memoryExtractionCore";
import { reserveMemoryExtractionAttempt } from "@/lib/memoryExtractionAdmission";
import { commitExtractionChunkCandidates } from "@/lib/memoryExtractionCommit";
import { analyzeExtractionChunk } from "@/lib/memoryExtractionPipeline";
import {
    createExtractionProviderAdapter,
    type ExtractionProviderResult,
} from "@/lib/memoryExtractionProvider";
import {
    releaseUnusedExtractionAttempt,
    settleExtractionAttempt,
} from "@/lib/memoryExtractionSettlement";
import { resolveEffectiveExtractionPair } from "@/lib/memoryExtractionService";
import type {
    ExtractionChunkHandler,
    MemoryExtractionLease,
} from "@/lib/memoryExtractionService";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import { getModelUsageCredits, type ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * The live chunk handler (Release B, slice 1.6c): the one place where
 * admission, the provider call, candidate storage and settlement are composed
 * into a single chunk of work.
 *
 * docs/policy/external-conversation-import-and-memory.md §11.
 *
 * The ordering here is the whole contract, and each step exists to make the
 * next one safe to fail:
 *
 *   1. reserve — money is committed BEFORE the call, in one transaction with
 *      the fencing check, so a call can never happen without a reservation
 *      behind it;
 *   2. mark the call issued — durably, before the request goes out, so a crash
 *      mid-flight is recoverable as "may have cost something" rather than as
 *      "nothing happened";
 *   3. call;
 *   4. commit candidates — only while the fencing token still holds;
 *   5. settle — ALWAYS, whatever step 4 decided. A worker that lost its lease
 *      still pays for what it used.
 *
 * A failure before step 2 releases the reservation whole. A failure after it
 * settles instead, because releasing would erase a cost that really happened.
 */

type ChunkSource = {
    externalConversationId: string;
    title: string;
    contentBytes: number;
    messages: Array<{
        externalMessageId: string;
        role: "user" | "assistant";
        content: string;
        contentDigest: string;
    }>;
};

/** Loads a chunk's conversations and their messages, scoped to the owner. */
async function loadChunkSources(
    userId: string,
    conversationIds: readonly string[]
): Promise<ChunkSource[]> {
    if (conversationIds.length === 0) return [];
    const conversations = await prisma.externalConversation.findMany({
        where: { id: { in: [...conversationIds] }, userId, finalized: true },
        select: { id: true, title: true, contentBytes: true },
    });
    if (conversations.length === 0) return [];
    const messages = await prisma.externalMessage.findMany({
        where: {
            externalConversationId: { in: conversations.map((row) => row.id) },
            userId,
        },
        orderBy: [{ externalConversationId: "asc" }, { ordinal: "asc" }],
        select: {
            id: true,
            externalConversationId: true,
            role: true,
            content: true,
            contentDigest: true,
        },
    });
    // Chunk order follows the stored plan, so the prompt a retry builds is the
    // prompt the first attempt built.
    const order = new Map(conversationIds.map((id, index) => [id, index]));
    return conversations
        .sort(
            (left, right) =>
                (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
        )
        .map((conversation) => ({
            externalConversationId: conversation.id,
            title: conversation.title ?? "",
            contentBytes: Number(conversation.contentBytes),
            messages: messages
                .filter(
                    (message) =>
                        message.externalConversationId === conversation.id &&
                        (message.role === "user" || message.role === "assistant")
                )
                .map((message) => ({
                    externalMessageId: message.id,
                    role: message.role as "user" | "assistant",
                    content: message.content,
                    contentDigest: message.contentDigest,
                })),
        }));
}

export type ExtractionChunkFailure =
    | "sources_missing"
    | "pair_unavailable"
    | "provider_error"
    | `admission_${string}`;

/**
 * Builds the handler `driveMemoryExtractionRunSlice` calls for each chunk.
 *
 * A factory rather than a bare function so tests can substitute the provider
 * without the production path gaining a "fake provider" branch: what is
 * injected here is the same seam the pipeline already takes.
 */
export function createExtractionChunkHandler(options?: {
    register?: readonly MemoryExtractionEvalEntry[];
    environment?: Record<string, string | undefined>;
    /** Test seam. Production passes nothing and gets the real adapter. */
    adapterFactory?: typeof createExtractionProviderAdapter;
}): ExtractionChunkHandler {
    const buildAdapter =
        options?.adapterFactory ?? createExtractionProviderAdapter;

    return async ({ lease, chunk }) => {
        const failed = (code: ExtractionChunkFailure) =>
            ({ outcome: "failed" as const, code });

        const sources = await loadChunkSources(
            lease.userId,
            chunk.conversationIds
        );
        if (sources.length === 0) {
            // The conversations were deleted after the run was planned. Not a
            // retryable provider problem — nothing is left to extract from.
            return failed("sources_missing");
        }

        const user = await prisma.user.findUnique({
            where: { id: lease.userId },
            select: { plan: true },
        });
        let pricing;
        let model;
        try {
            ({ pricing, model } = await resolveEffectiveExtractionPair({
                extractionModelId: lease.extractionModelId,
                promptVersion: lease.promptVersion,
                plan:
                    user?.plan === "Pro" || user?.plan === "Max"
                        ? (user.plan as ModelTier)
                        : "Free",
                register: options?.register,
            }));
        } catch {
            return failed("pair_unavailable");
        }

        const tier = pricing.tiers[0];
        const estimate = estimateExtraction(
            [
                {
                    conversationIds: sources.map(
                        (source) => source.externalConversationId
                    ),
                    contentBytes: sources.reduce(
                        (total, source) => total + source.contentBytes,
                        0
                    ),
                },
            ],
            {
                inputMicroUsdPerMTokens: tier.inputUsdPerMillionTokens * 1_000_000,
                outputMicroUsdPerMTokens:
                    tier.outputUsdPerMillionTokens * 1_000_000,
                creditsPerCall: getModelUsageCredits(model),
            }
        );

        const admission = await reserveMemoryExtractionAttempt({
            runId: lease.runId,
            chunkIndex: chunk.chunkIndex,
            leaseGeneration: lease.leaseGeneration,
            reservedCostMicroUsd: estimate.estimatedCostMicroUsd,
            environment: options?.environment,
            register: options?.register,
        });
        if (!admission.admitted) {
            return failed(`admission_${admission.reason}`);
        }

        // Durable before the request leaves: a crash from here on means cost
        // may have been incurred, and the recovery path has to know that.
        await prisma.memoryExtractionAttempt.update({
            where: { id: admission.attemptId },
            data: { status: "calling", providerCallIssued: true },
        });

        let providerResult: ExtractionProviderResult | null = null;
        // Read through helpers rather than inline: the value is assigned from
        // the adapter's callback, which control-flow analysis cannot see.
        const reportedUsage = (): ExtractionProviderResult["usage"] =>
            providerResult?.usage ?? { usageFromProvider: false };
        const reportedResponseId = () => providerResult?.responseId ?? null;
        let analysis;
        try {
            analysis = await analyzeExtractionChunk({
                conversations: sources,
                adapter: buildAdapter({
                    model,
                    maxOutputTokens: MEMORY_EXTRACTION_OUTPUT_TOKENS_PER_CHUNK,
                    onResult: (result) => {
                        providerResult = result;
                    },
                }),
            });
        } catch {
            // The call failed, but it was issued. Settling at the reservation
            // is the conservative direction: refusing to charge for a request
            // the provider may well have billed understates both the account's
            // spend and the provider budget.
            await settleExtractionAttempt({
                attemptId: admission.attemptId,
                usage: { usageFromProvider: false },
                outcome: "failed",
                // Still the lease holder — there is simply nothing to commit.
                // `discarded_stale` would misreport this as a fencing loss and
                // hide the real failure from the attempt history.
                commitAllowed: true,
            });
            return failed("provider_error");
        }

        // The answer is durable before the commit, so a crash between the two
        // does not mean paying for the same answer again.
        await prisma.memoryExtractionAttempt.update({
            where: { id: admission.attemptId },
            data: {
                status: "responded",
                respondedAt: new Date(),
                providerResponse: {
                    promptVersion: analysis.promptVersion,
                    counts: analysis.counts,
                    problems: analysis.problems,
                    responseId: reportedResponseId(),
                },
            },
        });

        const commit = await commitExtractionChunkCandidates({
            userId: lease.userId,
            runId: lease.runId,
            leaseGeneration: lease.leaseGeneration,
            extractionModelId: lease.extractionModelId,
            analysis,
        });

        await settleExtractionAttempt({
            attemptId: admission.attemptId,
            usage: reportedUsage(),
            outcome: commit.committed ? "completed" : "cancelled",
            commitAllowed: commit.committed,
        });

        console.info(
            JSON.stringify({
                event: "memory_extraction_chunk_committed",
                runId: lease.runId,
                chunkIndex: chunk.chunkIndex,
                committed: commit.committed,
                // Content-free: counts only, never a statement (§22).
                ...commit.counts,
                parseProblems: analysis.problems.length,
            })
        );

        if (!commit.committed) {
            // Fenced out. The run is somebody else's now; reporting a failure
            // would let this worker mark a chunk it no longer owns, and
            // `completeExtractionChunk` rejects it on the same fence anyway.
            return failed("admission_lease_lost");
        }
        return { outcome: "completed" };
    };
}

/** Releases an attempt reserved for a chunk that never reached a provider. */
export async function releaseExtractionAttemptForChunk(
    lease: Pick<MemoryExtractionLease, "runId">,
    chunkIndex: number,
    attemptNumber: number
) {
    const attempt = await prisma.memoryExtractionAttempt.findFirst({
        where: {
            attemptNumber,
            chunk: { runId: lease.runId, chunkIndex },
            providerCallIssued: false,
            settledAt: null,
        },
        select: { id: true },
    });
    if (!attempt) return { released: false };
    return releaseUnusedExtractionAttempt({
        attemptId: attempt.id,
        reason: "cancelled",
    });
}
