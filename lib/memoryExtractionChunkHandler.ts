import "server-only";

import { generateText } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import { getModel } from "@/lib/models";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import {
    analyzeExtractionChunk,
    type ExtractionModelAdapter,
} from "@/lib/memoryExtractionPipeline";
import type { ExtractionSourceConversationInput } from "@/lib/memoryExtractionPrompt";
import type { ExtractionChunkHandler } from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * The production chunk handler (policy §11): read this chunk's conversations,
 * ask the approved pair, store what it decided.
 *
 * `driveMemoryExtractionRunSlice()` owns claiming, fencing, the boundary
 * re-checks and lease release; this owns one chunk's work and nothing else. It
 * never throws for an expected condition -- a provider that errors or answers
 * with nonsense is a `failed` chunk with a code, which §11's bounded retry
 * then handles, not an exception for the driver to interpret.
 *
 * The model called is always the one the run recorded. §11 forbids falling
 * back to an unapproved model or a different promptVersion when the recorded
 * pair is unavailable: the run fails and the user is told, because a silent
 * substitution means the model named on the screen is not the model that read
 * their conversations.
 */

/** One chunk's provider call is bounded; a hung request must not hold a lease. */
const CHUNK_PROVIDER_TIMEOUT_MS = 90_000;

export const MEMORY_EXTRACTION_CHUNK_FAILURE_CODES = {
    modelUnavailable: "model_unavailable",
    noConversations: "no_conversations",
    providerError: "provider_error",
    persistError: "persist_error",
} as const;

/**
 * Loads a chunk's conversations in the order the plan recorded them.
 *
 * Order matters beyond tidiness: prompt labels are assigned by position, so
 * the same chunk has to produce the same prompt for `promptVersion` to mean
 * anything reproducible. `findMany` makes no ordering promise, so the stored
 * plan order is re-imposed here rather than trusted from the query.
 */
export async function loadChunkConversations(
    userId: string,
    conversationIds: readonly string[]
): Promise<ExtractionSourceConversationInput[]> {
    if (conversationIds.length === 0) return [];
    const rows = await prisma.externalConversation.findMany({
        where: { id: { in: [...conversationIds] }, userId, finalized: true },
        select: {
            id: true,
            title: true,
            messages: {
                select: {
                    id: true,
                    role: true,
                    content: true,
                    contentDigest: true,
                    ordinal: true,
                },
                orderBy: { ordinal: "asc" },
            },
        },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered: ExtractionSourceConversationInput[] = [];
    for (const id of conversationIds) {
        const row = byId.get(id);
        // A conversation deleted between planning and running is simply not
        // there. Dropping it is right -- the run cannot read what no longer
        // exists -- and the chunk still runs over the rest rather than failing
        // the whole run over one missing source.
        if (!row) continue;
        ordered.push({
            externalConversationId: row.id,
            title: row.title ?? "",
            messages: row.messages
                .filter(
                    (message) =>
                        message.role === "user" || message.role === "assistant"
                )
                .map((message) => ({
                    externalMessageId: message.id,
                    role: message.role as "user" | "assistant",
                    content: message.content,
                    contentDigest: message.contentDigest,
                })),
        });
    }
    return ordered;
}

/**
 * The adapter that actually contacts the provider.
 *
 * The answer comes back as text and `parseExtractionOutput()` is what decides
 * whether it is usable. That is deliberate rather than a shortcut: the parser
 * has to re-derive every citation against the server's own label map anyway --
 * a provider-side schema can promise the shape of an answer but not that the
 * evidence it cites is real -- so putting the schema on the request would add
 * a second, weaker check without removing the one that matters.
 *
 * No `service_tier` and no `inference_geo`, deliberately. Every profile in
 * lib/modelPricing.ts records Standard, globally routed pricing, which is only
 * true while no request selects a tier -- and the run was priced against those
 * profiles before the user confirmed it.
 */
export function extractionAdapterFor(modelId: string): ExtractionModelAdapter {
    const model = getModel(modelId);
    if (!model) {
        throw new Error(`Unknown extraction model: ${modelId}`);
    }
    return async ({ prompt }) => {
        const generated = await generateText({
            model: getActiveAiModel(model),
            system: prompt.system,
            prompt: prompt.user,
            ...getModelGenerationSettings(model, { temperature: 0 }),
            maxRetries: 1,
            abortSignal: AbortSignal.timeout(CHUNK_PROVIDER_TIMEOUT_MS),
        });
        return { text: generated.text };
    };
}

export type ChunkHandlerDeps = {
    /** Injected by the tests so no provider is contacted. */
    adapterFor?: (modelId: string) => ExtractionModelAdapter;
    now?: () => Date;
};

/**
 * Builds the handler `driveMemoryExtractionRunSlice()` calls per chunk.
 */
export function memoryExtractionChunkHandler(
    deps: ChunkHandlerDeps = {}
): ExtractionChunkHandler {
    const adapterFor = deps.adapterFor ?? extractionAdapterFor;
    const clock = deps.now ?? (() => new Date());

    return async ({ lease, chunk }) => {
        const conversations = await loadChunkConversations(
            lease.userId,
            chunk.conversationIds
        );
        if (conversations.length === 0) {
            // Every source this chunk covered is gone. Nothing to ask about,
            // and nothing the retry budget could improve.
            return {
                outcome: "failed",
                code: MEMORY_EXTRACTION_CHUNK_FAILURE_CODES.noConversations,
            };
        }

        let adapter: ExtractionModelAdapter;
        try {
            adapter = adapterFor(lease.extractionModelId);
        } catch {
            // The recorded pair is not callable. §11 forbids substituting a
            // different model or promptVersion, so this fails rather than
            // quietly reading the user's conversations with something else.
            return {
                outcome: "failed",
                code: MEMORY_EXTRACTION_CHUNK_FAILURE_CODES.modelUnavailable,
            };
        }

        const now = clock();
        let analysis;
        try {
            analysis = await analyzeExtractionChunk({
                conversations,
                adapter,
                now,
            });
        } catch (error) {
            // An adapter that fails is this handler's error to report, not the
            // driver's to interpret. Content-free: the message could carry a
            // fragment of the user's conversation.
            console.warn(
                JSON.stringify({
                    event: "memory_extraction_chunk_provider_failed",
                    runId: lease.runId,
                    chunkIndex: chunk.chunkIndex,
                    attempt: chunk.attemptCount,
                    reason: error instanceof Error ? error.name : "unknown",
                    at: now.toISOString(),
                })
            );
            return {
                outcome: "failed",
                code: MEMORY_EXTRACTION_CHUNK_FAILURE_CODES.providerError,
            };
        }

        try {
            const stored = await prisma.$transaction((tx) =>
                persistExtractionChunkDecisions(tx, {
                    userId: lease.userId,
                    runId: lease.runId,
                    chunkIndex: chunk.chunkIndex,
                    extractionModelId: lease.extractionModelId,
                    promptVersion: analysis.promptVersion,
                    decisions: analysis.decisions,
                    now,
                })
            );
            // §22 counters, content-free by construction: counts only, never a
            // statement, a title or an external id.
            console.info(
                JSON.stringify({
                    event: "memory_extraction_chunk_completed",
                    runId: lease.runId,
                    chunkIndex: chunk.chunkIndex,
                    attempt: chunk.attemptCount,
                    parsed: analysis.counts.parsed,
                    stored: stored.stored,
                    individualReview: stored.individualReview,
                    discarded: stored.discarded,
                    replaced: stored.replaced,
                    problems: analysis.problems.length,
                    at: now.toISOString(),
                })
            );
            return { outcome: "completed" };
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: "memory_extraction_chunk_persist_failed",
                    runId: lease.runId,
                    chunkIndex: chunk.chunkIndex,
                    reason: error instanceof Error ? error.name : "unknown",
                    at: now.toISOString(),
                })
            );
            return {
                outcome: "failed",
                code: MEMORY_EXTRACTION_CHUNK_FAILURE_CODES.persistError,
            };
        }
    };
}
