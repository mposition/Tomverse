import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { lockAccountMemoryItems } from "@/lib/memoryItemLock";
import { prisma } from "@/lib/prisma";
import { currentEmbeddingLabel, embedForIndexing } from "@/lib/semanticRetrieval";
import { cosineSimilarity, decodeVector, encodeVector } from "@/lib/semanticRetrievalCore";

/**
 * Finding an active memory that says what a new candidate says, in other
 * words (docs/policy/external-conversation-import-and-memory.md §9a, §8.3).
 *
 * The conflict key is an exact, normalised match, so "likes coffee" and "is a
 * coffee lover" are two memories today. With the operator's switch on, a
 * candidate's vector is compared with the account's active memories of the
 * same kind, and a near match is handed to the existing topic rule as one
 * more conflict: the newer statement wins, and a memory the user wrote,
 * edited or pinned is never replaced.
 *
 * A near match is deliberately not "drop the candidate". A statement and its
 * negation sit close together in an embedding space, and dropping the newer
 * of "likes coffee" / "no longer drinks coffee" as a duplicate would keep the
 * stale one. Routed through the topic rule, the newer one supersedes it.
 *
 * The provider is called before the write transaction opens and never inside
 * it: the transaction holds the account's memory lock, and a network call
 * under a lock is how one slow provider stalls every memory write.
 */

/** Cosine similarity at which two statements of one kind are the same topic. */
export const MEMORY_DUPLICATE_SIMILARITY = 0.9;

/** How many of the account's unembedded memories one preparation embeds. */
const BACKFILL_PER_PREPARATION = 96;

/** The most active memories compared against. Matches retrieval's own bound. */
const MAX_ACTIVE_MEMORIES = 400;

/**
 * The label stored beside a memory's vector: the model's label and a digest
 * of the statement it was computed from. A statement can be edited in place
 * on several paths; carrying the digest means a vector for the old wording is
 * recognised as stale wherever the edit happened, with nothing to remember to
 * clear.
 */
export const memoryEmbeddingLabel = (modelLabel: string, statement: string) =>
    `${modelLabel}#${createHash("sha256").update(statement, "utf8").digest("hex").slice(0, 16)}`;

export type MemoryDuplicateContext = {
    modelLabel: string;
    /** Candidate statement -> its vector. A statement that failed is absent. */
    vectors: ReadonlyMap<string, Int8Array>;
};

/**
 * Vectors for a chunk's candidate statements, and for some of the account's
 * active memories that do not have a current one yet.
 *
 * Null when the switch is off, nothing could be embedded, or anything went
 * wrong: the chunk is then stored exactly as it would have been.
 */
export async function prepareMemoryDuplicateContext(input: {
    userId: string;
    statements: readonly string[];
}): Promise<MemoryDuplicateContext | null> {
    try {
        const statements = [...new Set(input.statements)];
        if (statements.length === 0) return null;
        const modelLabel = await currentEmbeddingLabel("memoryDuplicates");
        if (!modelLabel) return null;

        const active = await prisma.memoryItem.findMany({
            where: { userId: input.userId, status: "active" },
            orderBy: { id: "asc" },
            take: MAX_ACTIVE_MEMORIES,
            select: { id: true, statement: true, embeddingModel: true },
        });
        const stale = active
            .filter((row) => row.embeddingModel !== memoryEmbeddingLabel(modelLabel, row.statement))
            .slice(0, BACKFILL_PER_PREPARATION);

        const result = await embedForIndexing({
            feature: "memoryDuplicates",
            kind: "text",
            inputs: [...statements, ...stale.map((row) => row.statement)],
        });
        if (!result) return null;

        const vectors = new Map<string, Int8Array>();
        statements.forEach((statement, index) => {
            const vector = result.vectors[index];
            if (vector) vectors.set(statement, vector);
        });

        const backfill = stale.flatMap((row, index) => {
            const vector = result.vectors[statements.length + index];
            return vector ? [{ row, vector }] : [];
        });
        if (backfill.length > 0) {
            await prisma.$transaction(async (tx) => {
                await lockAccountMemoryItems(tx, input.userId);
                for (const { row, vector } of backfill) {
                    await tx.memoryItem.updateMany({
                        // The statement is part of the condition: a vector is
                        // never attached to wording it was not computed from.
                        where: { id: row.id, userId: input.userId, statement: row.statement },
                        data: {
                            embedding: encodeVector(vector),
                            embeddingModel: memoryEmbeddingLabel(result.modelLabel, row.statement),
                        },
                    });
                }
            });
        }

        return vectors.size > 0 ? { modelLabel: result.modelLabel, vectors } : null;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "memory_duplicate_context_failed",
                error: error instanceof Error ? error.name : "unknown",
            })
        );
        return null;
    }
}

export type EmbeddedMemory = { id: string; kind: string; statement: string; vector: Int8Array };

/** The account's active memories that carry a current vector. */
export async function loadEmbeddedActiveMemories(
    tx: Prisma.TransactionClient,
    userId: string,
    modelLabel: string
): Promise<EmbeddedMemory[]> {
    const rows = await tx.memoryItem.findMany({
        where: { userId, status: "active", embedding: { not: null } },
        orderBy: { id: "asc" },
        take: MAX_ACTIVE_MEMORIES,
        select: { id: true, kind: true, statement: true, embedding: true, embeddingModel: true },
    });
    const embedded: EmbeddedMemory[] = [];
    for (const row of rows) {
        if (row.embeddingModel !== memoryEmbeddingLabel(modelLabel, row.statement)) continue;
        const vector = decodeVector(row.embedding);
        if (vector) embedded.push({ id: row.id, kind: row.kind, statement: row.statement, vector });
    }
    return embedded;
}

/** Active memories of the candidate's kind that say nearly the same thing. */
export const semanticDuplicatesOf = (
    candidate: { kind: string; vector: Int8Array },
    memories: readonly EmbeddedMemory[]
): EmbeddedMemory[] =>
    memories.filter(
        (memory) =>
            memory.kind === candidate.kind &&
            cosineSimilarity(candidate.vector, memory.vector) >= MEMORY_DUPLICATE_SIMILARITY
    );
