import "server-only";

import {
    MEMORY_EXTRACTION_OUTPUT_TOKENS_PER_CHUNK,
    estimateExtraction,
} from "@/lib/memoryExtractionCore";
import { commitExtractionChunk } from "@/lib/memoryExtractionCommit";
import { analyzeExtractionChunk } from "@/lib/memoryExtractionPipeline";
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
import { resolveEffectiveExtractionPair } from "@/lib/memoryExtractionService";
import type { ExtractionChunkHandler } from "@/lib/memoryExtractionService";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * The live chunk handler: the one place a paid chunk of extraction work is
 * composed (policy §11).
 *
 * Three layers meet here, and they are deliberately not the same layer:
 *
 *  - **User credits** are reserved per run and settled at a terminal state by
 *    the run service. Nothing here touches them. A failed chunk is refunded to
 *    the user because they did not get it.
 *  - **Operational provider cost** is per actual call. Released only if no
 *    request went out; otherwise settled whatever happened afterwards —
 *    including an abort, a lost lease, or a chunk this slice already wrote off.
 *  - **Candidates** are committed by a separate fenced transaction, and this
 *    function performs no candidate write of its own. That is what makes a
 *    late return from a timed-out handler harmless: there is nothing for it to
 *    land.
 *
 * The ordering exists so each step is safe to fail:
 *   admit cost → mark issued (durably, before the request) → call → commit
 *   under the fence → settle cost regardless of the commit's verdict.
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
    // Chunk order follows the stored plan, so a retry builds the prompt the
    // first attempt built.
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

export function createExtractionChunkHandler(options?: {
    register?: readonly MemoryExtractionEvalEntry[];
    environment?: Record<string, string | undefined>;
    /** Test seam. Production passes nothing and gets the real adapter. */
    adapterFactory?: typeof createExtractionProviderAdapter;
}): ExtractionChunkHandler {
    const buildAdapter =
        options?.adapterFactory ?? createExtractionProviderAdapter;

    return async ({ lease, chunk, signal }) => {
        const failed = (code: string) =>
            ({ outcome: "failed" as const, code });

        // Cheapest possible exit: the slice may already have given up before
        // this handler got its turn.
        if (signal.aborted) return failed("chunk_timeout");

        const sources = await loadChunkSources(
            lease.userId,
            chunk.conversationIds
        );
        // The conversations were deleted after the run was planned. Not a
        // retryable provider problem — there is nothing left to extract from.
        if (sources.length === 0) return failed("sources_missing");

        const user = await prisma.user.findUnique({
            where: { id: lease.userId },
            select: { plan: true },
        });
        let pricing;
        let model;
        try {
            // Re-resolved here rather than cached from run creation: a pair can
            // be revoked without a deploy, and a plan can change while a run
            // sits pending (§12.1).
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
                creditsPerCall: 0,
            }
        );

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

        const admission = await admitExtractionProviderCall({
            chunkId: chunkRow.id,
            attemptCount: chunk.attemptCount,
            provider: pricing.provider,
            modelId: lease.extractionModelId,
            estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
            environment: options?.environment,
        });
        if (!admission.admitted) {
            return failed(`budget_${admission.scope}`);
        }

        let callIssued = false;
        let providerResult: ExtractionProviderResult | null = null;
        const reportedUsage = () =>
            providerResult?.usage ?? { usageFromProvider: false };
        const reportedResponseId = () => providerResult?.responseId ?? null;
        const costOf = (usage: ExtractionProviderResult["usage"]) =>
            Math.ceil(
                ((usage.inputTokens ?? 0) * tier.inputUsdPerMillionTokens) +
                    (usage.outputTokens ?? 0) * tier.outputUsdPerMillionTokens
            );

        let analysis;
        try {
            analysis = await analyzeExtractionChunk({
                conversations: sources,
                adapter: buildAdapter({
                    model,
                    maxOutputTokens: MEMORY_EXTRACTION_OUTPUT_TOKENS_PER_CHUNK,
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
            if (!callIssued) {
                // Nothing went out, so nothing was spent. This is the only
                // path that gives the operational budget back.
                await releaseUnusedExtractionProviderCall({
                    providerCallId: admission.providerCallId,
                    failureCode: aborted ? "chunk_timeout" : "provider_error",
                }).catch(() => ({ released: false }));
            } else {
                // A request did go out. Whether the abort reached the provider
                // in time is exactly what we cannot know, so the cost stays.
                await settleExtractionProviderCall({
                    providerCallId: admission.providerCallId,
                    usage: reportedUsage(),
                    failureCode: aborted ? "chunk_timeout" : "provider_error",
                }).catch(() => ({ settled: false }));
            }
            void error;
            return failed(aborted ? "chunk_timeout" : "provider_error");
        }

        // The commit is fenced and separate; this handler writes no candidate
        // of its own, which is what makes a late return harmless.
        const commit = await commitExtractionChunk({
            lease,
            chunkIndex: chunk.chunkIndex,
            extractionModelId: lease.extractionModelId,
            promptVersion: analysis.promptVersion,
            decisions: analysis.decisions,
        });

        // Settled whatever the commit decided. A worker fenced out after its
        // call still spent the money, and the guardrail has to see it.
        const usage = reportedUsage();
        await settleExtractionProviderCall({
            providerCallId: admission.providerCallId,
            usage: {
                ...usage,
                actualCostMicroUsd: usage.usageFromProvider
                    ? costOf(usage)
                    : undefined,
                responseId: reportedResponseId(),
            },
            failureCode: commit.committed ? undefined : "fenced_out",
        }).catch(() => ({ settled: false }));

        console.info(
            JSON.stringify({
                event: "memory_extraction_chunk_finished",
                runId: lease.runId,
                chunkIndex: chunk.chunkIndex,
                committed: commit.committed,
                // Content-free: counts only, never a statement (§22).
                ...(commit.committed
                    ? {
                          stored: commit.stored,
                          individualReview: commit.individualReview,
                          discarded: commit.discarded,
                      }
                    : { reason: commit.reason }),
                parseProblems: analysis.problems.length,
                usageConfirmed: usage.usageFromProvider,
            })
        );

        if (!commit.committed) return failed("lease_lost");
        return { outcome: "completed" };
    };
}
