import "server-only";

import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import {
    selectKnowledgeContext,
    type KnowledgeContextBudget,
    type KnowledgeContextSelection,
} from "@/lib/assistantKnowledgeRetrievalScoring";
import { prisma } from "@/lib/prisma";

/**
 * Server-driven knowledge retrieval (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §44, and §8.1
 * invariant 3, which this obeys for the same reason memory does: the client
 * never names what is retrieved. It sends its message; the server decides
 * which of the owner's chunks are relevant and which of them fit. There is no
 * request field here a caller could use to ask for a chunk by id, because
 * there is no parameter for one.
 *
 * The database narrows; `selectKnowledgeContext` decides. Splitting it that
 * way keeps the ranking pure and testable, and keeps the query to what an
 * index can actually answer.
 */

export type KnowledgeRetrievalInput = {
    userId: string;
    /** The version's manifest decides which files are in scope (§43). */
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
    const empty = () =>
        selectKnowledgeContext({ chunks: [], query: queryTerms, budget: input.budget });

    if (input.fileIds.length === 0 || queryTerms.length === 0) return empty();

    const rows = await prisma.assistantKnowledgeChunk.findMany({
        where: {
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
            searchTerms: { hasSome: queryTerms },
        },
        take: input.candidateLimit ?? KNOWLEDGE_CANDIDATE_LIMIT,
        // Stable, so two identical requests fetch the same candidate set even
        // when more chunks match than the limit takes.
        orderBy: [{ fileId: "asc" }, { ordinal: "asc" }],
        select: {
            id: true,
            fileId: true,
            ordinal: true,
            content: true,
            searchTerms: true,
            file: { select: { name: true } },
        },
    });

    return selectKnowledgeContext({
        chunks: rows.map((row) => ({
            id: row.id,
            fileId: row.fileId,
            fileName: row.file.name,
            ordinal: row.ordinal,
            content: row.content,
            searchTerms: row.searchTerms,
        })),
        query: queryTerms,
        budget: input.budget,
    });
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
