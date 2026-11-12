import "server-only";

import { Prisma } from "@prisma/client";
import { KNOWLEDGE_SEMANTIC_DEFAULTS } from "@/lib/assistantKnowledgeRetrievalScoring";
import { prisma } from "@/lib/prisma";
import {
    currentEmbeddingLabel,
    embedForIndexing,
    embedQueryForRetrieval,
    readSemanticCache,
    writeSemanticCache,
} from "@/lib/semanticRetrieval";
import {
    decodeVector,
    encodeVector,
    nearestByCosine,
    neighbourCacheKey,
} from "@/lib/semanticRetrievalCore";

/**
 * Semantic vectors for knowledge chunks (docs/policy/external-conversation-import-and-memory.md §9a): writing them, and
 * finding the chunks nearest a question.
 *
 * Vectors are bytes on the chunk row and are compared here, in the
 * application. No extension and no vector index: a profile's files are a few
 * thousand chunks at most, the comparison is a dot product per chunk, and a
 * database that needs nothing installed is one fewer thing every environment
 * has to agree on.
 *
 * A chunk without a vector is not an error. It is found by lexical retrieval
 * as before, and the sweep embeds it later.
 */

/** `sourceMetadata.kind` of a scanned page stored as a pointer chunk. */
export const KNOWLEDGE_IMAGE_PAGE_KIND = "image_page";

export const isImagePageMetadata = (metadata: unknown): boolean =>
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>).kind === KNOWLEDGE_IMAGE_PAGE_KIND;

/**
 * What a scanned page's chunk says. Descriptive, never an instruction: the
 * knowledge block is untrusted data and the model is told not to obey it.
 */
export const imagePageChunkContent = (pageNumber: number) =>
    `[Page ${pageNumber}]\n(Scanned page: an image with no extractable text. ` +
    `It was matched to the question by visual similarity; its contents are not available as text.)`;

/**
 * The most vectors one retrieval reads. Above this the scan is truncated in
 * document order, which is deterministic and means the files past the cut are
 * found by lexical retrieval only.
 */
export const KNOWLEDGE_EMBEDDING_SCAN_LIMIT = 2_000;

/**
 * The chunks nearest the question by meaning, with their similarity, or null
 * when embedding is off or the question could not be embedded.
 *
 * The result is cached like a ranking, and for the same reason. Vectors are
 * still being written while a turn is in flight -- the sweep fills in files
 * that predate the switch -- so a search repeated a few seconds later can
 * find a neighbour the first one could not. The first answer, including "no
 * neighbour", is the answer for every rebuild of that turn. An id that no
 * longer exists by then is simply not read back: the caller re-reads the
 * chunks by id under its own ownership and file scope.
 */
export async function knowledgeNeighbours(input: {
    userId: string;
    fileIds: readonly string[];
    query: string;
}): Promise<Map<string, number> | null> {
    if (input.fileIds.length === 0) return null;
    const embedded = await embedQueryForRetrieval({
        feature: "knowledgeEmbed",
        userId: input.userId,
        query: input.query,
    });
    if (!embedded) return null;

    const key = neighbourCacheKey({
        userId: input.userId,
        modelLabel: embedded.modelLabel,
        query: input.query,
        fileIds: input.fileIds,
    });
    const cached = await readSemanticCache(key);
    if (cached?.kind === "neighbours") return new Map(cached.scores);

    const rows = await prisma.assistantKnowledgeChunk.findMany({
        where: {
            userId: input.userId,
            fileId: { in: [...input.fileIds] },
            file: { processingStatus: "ready" },
            // A vector from another model or dimension is not comparable.
            embeddingModel: embedded.modelLabel,
            embedding: { not: null },
        },
        orderBy: [{ fileId: "asc" }, { ordinal: "asc" }],
        take: KNOWLEDGE_EMBEDDING_SCAN_LIMIT,
        select: { id: true, embedding: true },
    });

    const candidates: Array<{ id: string; vector: Int8Array }> = [];
    for (const row of rows) {
        const vector = decodeVector(row.embedding);
        if (vector) candidates.push({ id: row.id, vector });
    }
    const nearest = nearestByCosine(embedded.vector, candidates, {
        limit: KNOWLEDGE_SEMANTIC_DEFAULTS.neighbourLimit,
        minSimilarity: KNOWLEDGE_SEMANTIC_DEFAULTS.minSimilarity,
    });
    const stored = await writeSemanticCache(key, input.userId, {
        kind: "neighbours",
        scores: nearest.map((entry) => [entry.id, entry.similarity]),
    });
    // Not confirmed stored: the next rebuild could not find these neighbours,
    // so this one does not use them either.
    return stored?.kind === "neighbours" ? new Map(stored.scores) : null;
}

export type KnowledgeEmbeddingResult = { considered: number; embedded: number };

/**
 * Embeds text chunks that have no vector under the current model.
 *
 * Driven twice: straight after a file is processed, so a new upload is
 * searchable by meaning while its owner is still on the page, and from the
 * maintenance sweep, which also catches files that predate the switch and
 * chunks whose vector came from a model that is no longer configured.
 *
 * Restartable and idempotent: it looks for what is still missing, and a chunk
 * that was replaced while its vector was in flight is simply not updated.
 */
export async function embedKnowledgeChunks(input: {
    fileId?: string;
    limit?: number;
} = {}): Promise<KnowledgeEmbeddingResult> {
    const label = await currentEmbeddingLabel("knowledgeEmbed");
    if (!label) return { considered: 0, embedded: 0 };

    // Raw, because the two null-sensitive tests here are exactly what a
    // generated NOT filter gets wrong: a text chunk has no `kind` key, and a
    // never-embedded one has no label.
    const rows = await prisma.$queryRaw<Array<{ id: string; content: string }>>(
        Prisma.sql`
            SELECT c."id", c."content"
            FROM "AssistantKnowledgeChunk" c
            JOIN "AssistantKnowledgeFile" f ON f."id" = c."fileId"
            WHERE f."processingStatus" = 'ready'
              AND c."embeddingModel" IS DISTINCT FROM ${label}
              AND (c."sourceMetadata"->>'kind') IS DISTINCT FROM ${KNOWLEDGE_IMAGE_PAGE_KIND}
              ${input.fileId ? Prisma.sql`AND c."fileId" = ${input.fileId}` : Prisma.empty}
            ORDER BY c."createdAt" ASC, c."id" ASC
            LIMIT ${Math.max(1, Math.min(input.limit ?? 192, 2_000))}
        `
    );
    if (rows.length === 0) return { considered: 0, embedded: 0 };

    const result = await embedForIndexing({
        feature: "knowledgeEmbed",
        kind: "text",
        inputs: rows.map((row) => row.content),
    });
    if (!result) return { considered: rows.length, embedded: 0 };

    let embedded = 0;
    for (const [index, row] of rows.entries()) {
        const vector = result.vectors[index];
        if (!vector) continue;
        const updated = await prisma.assistantKnowledgeChunk.updateMany({
            // The content is part of the condition: a vector must never be
            // attached to text it was not computed from.
            where: { id: row.id, content: row.content },
            data: { embedding: encodeVector(vector), embeddingModel: result.modelLabel },
        });
        embedded += updated.count;
    }
    return { considered: rows.length, embedded };
}

/** Never lets an embedding failure reach the caller; indexing is best effort. */
export const embedKnowledgeChunksQuietly = async (
    input: { fileId?: string; limit?: number } = {}
): Promise<KnowledgeEmbeddingResult> => {
    try {
        return await embedKnowledgeChunks(input);
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "assistant_knowledge_embedding_failed",
                error: error instanceof Error ? error.name : "unknown",
            })
        );
        return { considered: 0, embedded: 0 };
    }
};

export type ImagePageVector = {
    pageNumber: number;
    embedding: Uint8Array<ArrayBuffer>;
    embeddingModel: string;
};

/**
 * Vectors for scanned pages, from their rendered images.
 *
 * Returns only the pages that were embedded. A page without a vector gets no
 * chunk at all: a pointer nothing can retrieve would only make an unreadable
 * file look processed.
 */
export async function embedImagePages(
    pages: ReadonlyArray<{ pageNumber: number; jpeg: Buffer }>
): Promise<ImagePageVector[]> {
    if (pages.length === 0) return [];
    try {
        const result = await embedForIndexing({
            feature: "knowledgeImagePages",
            kind: "image",
            inputs: pages.map((page) => `data:image/jpeg;base64,${page.jpeg.toString("base64")}`),
        });
        if (!result) return [];
        const vectors: ImagePageVector[] = [];
        pages.forEach((page, index) => {
            const vector = result.vectors[index];
            if (vector) {
                vectors.push({
                    pageNumber: page.pageNumber,
                    embedding: encodeVector(vector),
                    embeddingModel: result.modelLabel,
                });
            }
        });
        return vectors;
    } catch {
        return [];
    }
}
