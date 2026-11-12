import "server-only";

import { isImagePageMetadata, knowledgeNeighbours } from "@/lib/assistantKnowledgeEmbedding";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import {
    KNOWLEDGE_SEMANTIC_DEFAULTS,
    fuseKnowledgeScores,
    selectKnowledgeContext,
    selectKnowledgeContextRanked,
    type KnowledgeContextBudget,
    type KnowledgeContextSelection,
    type SemanticChunk,
} from "@/lib/assistantKnowledgeRetrievalScoring";
import { prisma } from "@/lib/prisma";
import { rerankForRetrieval } from "@/lib/semanticRetrieval";

/**
 * Server-driven knowledge retrieval (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §8.1
 * invariant 3, which this obeys for the same reason memory does: the client
 * never names what is retrieved. It sends its message; the server decides
 * which of the owner's chunks are relevant and which of them fit. There is no
 * request field here a caller could use to ask for a chunk by id, because
 * there is no parameter for one.
 *
 * The database narrows; `selectKnowledgeContext` decides. Splitting it that
 * way keeps the ranking pure and testable, and keeps the query to what an
 * index can actually answer.
 *
 * ## Semantic retrieval (§9a)
 *
 * Two optional steps sit between the two, each behind its own operator
 * switch and both off by default:
 *
 *   * **neighbours** -- chunks whose stored vector is near the question's are
 *     added to the lexical candidates, so a passage that shares no word with
 *     the question (a synonym, another language) can still be a candidate;
 *   * **rerank** -- the candidates are scored against the question by an
 *     external model, and that score replaces term overlap as relevance.
 *
 * With both off, or when either call is refused or fails, this is the lexical
 * path exactly as before, down to the retrieval version in the result.
 */

export type KnowledgeRetrievalInput = {
    userId: string;
    /** The version's manifest decides which files are in scope (§14). */
    fileIds: readonly string[];
    /** The current user message. */
    query: string;
    budget?: Partial<KnowledgeContextBudget>;
    /**
     * How many candidate chunks to pull before ranking. Larger than the number
     * that can be selected, because the database orders by nothing useful --
     * relevance is computed in the selector, so a narrow fetch would rank a
     * slice the database happened to return first.
     */
    candidateLimit?: number;
};

export const KNOWLEDGE_CANDIDATE_LIMIT = 60;

const CHUNK_SELECT = {
    id: true,
    fileId: true,
    ordinal: true,
    content: true,
    searchTerms: true,
    sourceMetadata: true,
    file: { select: { name: true } },
} as const;

// Stable, so two identical requests fetch the same candidate set even when
// more chunks match than the limit takes.
const DOCUMENT_ORDER = [{ fileId: "asc" as const }, { ordinal: "asc" as const }];

/**
 * The chunks worth putting in this turn's prompt.
 *
 * Returns an empty selection rather than throwing when there is nothing to
 * retrieve: no files in scope, a query with no usable terms, or a profile
 * whose files all failed processing are three different situations that a
 * caller handles identically — the prompt simply carries no knowledge block.
 */
export const retrieveKnowledgeContext = async (
    input: KnowledgeRetrievalInput
): Promise<KnowledgeContextSelection> => {
    const queryTerms = memoryRetrievalTerms(input.query);
    const lexical = (chunks: readonly SemanticChunk[]) =>
        selectKnowledgeContext({ chunks, query: queryTerms, budget: input.budget });

    if (input.fileIds.length === 0) return lexical([]);

    const scope = {
        // Ownership first, and by column rather than through the file:
        // a chunk whose owner had to be derived is a chunk a mistyped
        // join could return to the wrong account.
        userId: input.userId,
        fileId: { in: [...input.fileIds] },
        // Only a processed file has chunks worth reading. The CHECK
        // constraint makes this true already; asking for it here means a
        // future path that loosens the constraint does not silently start
        // retrieving from half-processed files.
        file: { processingStatus: "ready" },
    };

    const lexicalRows =
        queryTerms.length === 0
            ? []
            : await prisma.assistantKnowledgeChunk.findMany({
                  where: { ...scope, searchTerms: { hasSome: queryTerms } },
                  take: input.candidateLimit ?? KNOWLEDGE_CANDIDATE_LIMIT,
                  orderBy: DOCUMENT_ORDER,
                  select: CHUNK_SELECT,
              });

    // Null when embedding is off; an empty map is treated the same way, so a
    // question with no neighbour leaves the lexical result untouched.
    const found = await knowledgeNeighbours({
        userId: input.userId,
        fileIds: input.fileIds,
        query: input.query,
    });
    const neighbours = found && found.size > 0 ? found : null;

    let rows = lexicalRows;
    if (neighbours) {
        const known = new Set(lexicalRows.map((row) => row.id));
        const missing = [...neighbours.keys()].filter((id) => !known.has(id));
        if (missing.length > 0) {
            const extra = await prisma.assistantKnowledgeChunk.findMany({
                // The same scope again: an id is never enough to read a chunk.
                where: { ...scope, id: { in: missing } },
                orderBy: DOCUMENT_ORDER,
                select: CHUNK_SELECT,
            });
            rows = [...lexicalRows, ...extra].sort((a, b) =>
                a.fileId !== b.fileId ? (a.fileId < b.fileId ? -1 : 1) : a.ordinal - b.ordinal
            );
        }
    }

    const chunks: SemanticChunk[] = rows.map((row) => ({
        id: row.id,
        fileId: row.fileId,
        fileName: row.file.name,
        ordinal: row.ordinal,
        content: row.content,
        searchTerms: row.searchTerms,
        ...(isImagePageMetadata(row.sourceMetadata) ? { imagePage: true } : {}),
    }));
    if (chunks.length === 0) return lexical([]);

    // A scanned page's stored text is a pointer, so it is not sent to be
    // reranked; its image similarity is its relevance.
    const passages = chunks.filter((chunk) => !chunk.imagePage);
    const reranked = await rerankForRetrieval({
        feature: "knowledgeRerank",
        userId: input.userId,
        query: input.query,
        documents: passages.map((chunk) => ({ id: chunk.id, text: chunk.content })),
    });

    if (reranked) {
        return selectKnowledgeContextRanked({
            chunks,
            scores: reranked,
            imagePageSimilarities: neighbours ?? undefined,
            query: queryTerms,
            minScore: KNOWLEDGE_SEMANTIC_DEFAULTS.minRerankScore,
            budget: input.budget,
        });
    }
    if (neighbours) {
        return selectKnowledgeContextRanked({
            chunks,
            scores: fuseKnowledgeScores({ chunks: passages, query: queryTerms, similarities: neighbours }),
            imagePageSimilarities: neighbours,
            query: queryTerms,
            budget: input.budget,
        });
    }
    return lexical(chunks);
};

/**
 * Which of a version's manifest files are actually retrievable right now.
 *
 * §14 makes a manifest audit metadata: it can prove a file was listed at
 * publish time and cannot resurrect a deleted one. This is the query half of
 * `resolveKnowledgeManifest()` — it reports what exists, is owned by this
 * account, and has finished processing, and the pure resolver decides what
 * that means for each manifest entry.
 */
export const availableKnowledgeFiles = async (
    userId: string,
    fileIds: readonly string[]
) => {
    if (fileIds.length === 0) return [];
    const files = await prisma.assistantKnowledgeFile.findMany({
        where: { userId, id: { in: [...fileIds] } },
        select: { id: true, digest: true, processingStatus: true },
    });
    return files.map((file) => ({
        fileId: file.id,
        digest: file.digest,
        processed: file.processingStatus === "ready",
    }));
};
