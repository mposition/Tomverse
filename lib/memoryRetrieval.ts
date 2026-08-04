import "server-only";

import type { Prisma } from "@prisma/client";
import {
    DEFAULT_MEMORY_CONTEXT_BUDGET,
    MEMORY_RETRIEVAL_VERSION,
    isStyleMemoryKind,
    memorySearchTerms,
    scoreMemory,
    selectMemoryContext,
    tokenizeMemoryText,
    type MemoryContextBudget,
    type MemoryContextSelection,
    type RetrievableMemory,
} from "@/lib/memoryRetrievalCore";
import { prisma } from "@/lib/prisma";

/**
 * The database half of retrieval v1 (Release B, slice B4).
 *
 * docs/policy/external-conversation-import-and-memory.md §9.
 *
 * Two properties this file exists to hold:
 *
 *  - **The candidate set is narrowed in Postgres, the choice is made in code.**
 *    The GIN index on `searchTerms` answers "which of this account's active
 *    memories share a term with the request" cheaply; ranking then happens in
 *    lib/memoryRetrievalCore.ts, where it is pure and testable. Ranking in SQL
 *    would put the rules a prompt depends on somewhere no unit test reaches.
 *  - **Retrieval is server-side and account-scoped, always.** §9 forbids
 *    client-side retrieval computation or selection, so nothing here accepts a
 *    memory id from a caller: it takes a user id and a request text, and the
 *    owner filter is on every read.
 */

/**
 * Rows one retrieval may draw from before scoring.
 *
 * Bounded so an account with a very large store cannot make a chat turn slow.
 * The ordering below decides what survives the cut — pinned first, then most
 * recently updated — so a truncated candidate set loses the least relevant
 * rows rather than an arbitrary page.
 */
const CANDIDATE_LIMIT = 200;

export type MemoryRetrievalResult = {
    retrievalVersion: number;
    queryTermCount: number;
    candidateCount: number;
    selection: MemoryContextSelection;
};

/**
 * Retrieves the memories that should accompany one request.
 *
 * Only `active` memories are eligible: a candidate awaiting review, a rejected
 * one, and one suspended by a source lock or delete are all memories the user
 * has not agreed to use (§8.3, §7.1). Expiry is applied in the same read
 * rather than by a sweep, so a memory stops being used the moment it lapses
 * rather than at the next cleanup.
 */
export async function retrieveMemoriesForRequest(input: {
    userId: string;
    /** The user's request text. Never a caller-supplied memory selection. */
    query: string;
    budget?: MemoryContextBudget;
    /** False when the account turned answer-style memory off (§21). */
    includeStyle?: boolean;
    now?: Date;
}): Promise<MemoryRetrievalResult> {
    const now = input.now ?? new Date();
    const queryTerms = tokenizeMemoryText(input.query);
    const budget = input.budget ?? DEFAULT_MEMORY_CONTEXT_BUDGET;
    const includeStyle = input.includeStyle !== false;

    // Pinned memories are fetched whether or not the request shares a term
    // with them: pinning is the user saying "this is always relevant", and a
    // term filter would quietly overrule that.
    const relevance: Prisma.MemoryItemWhereInput =
        queryTerms.length > 0
            ? { OR: [{ pinned: true }, { searchTerms: { hasSome: queryTerms } }] }
            : { pinned: true };

    const rows = await prisma.memoryItem.findMany({
        where: {
            userId: input.userId,
            status: "active",
            AND: [
                { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                relevance,
            ],
        },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
        take: CANDIDATE_LIMIT,
        select: {
            id: true,
            kind: true,
            statement: true,
            searchTerms: true,
            confidence: true,
            importance: true,
            pinned: true,
            updatedAt: true,
            evidences: {
                select: {
                    sourceType: true,
                    externalMessage: {
                        select: { externalConversationId: true },
                    },
                },
            },
        },
    });

    const candidates: RetrievableMemory[] = rows
        .filter((row) => includeStyle || !isStyleMemoryKind(row.kind))
        .map((row) => ({
            id: row.id,
            kind: row.kind,
            statement: row.statement,
            searchTerms: row.searchTerms,
            confidence: row.confidence,
            importance: row.importance,
            pinned: row.pinned,
            updatedAt: row.updatedAt,
            // One source is one imported conversation. Manual grounds get a
            // per-memory key, so a hand-written memory never competes with
            // another for the same-source allowance.
            sourceKeys: [
                ...new Set(
                    row.evidences.map(
                        (evidence) =>
                            evidence.externalMessage?.externalConversationId ??
                            `${evidence.sourceType}:${row.id}`
                    )
                ),
            ],
        }));

    const termSet = new Set(queryTerms);
    const scored = candidates.map((memory) =>
        scoreMemory(memory, termSet, now)
    );

    return {
        retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        queryTermCount: termSet.size,
        candidateCount: candidates.length,
        selection: selectMemoryContext(scored, budget),
    };
}

/**
 * Recomputes `searchTerms` for memories that predate retrieval v1, or whose
 * terms were written by an older tokenizer.
 *
 * Idempotent and bounded per call. Rows are matched on `retrievalVersion`
 * rather than on an empty term array: a memory can legitimately produce no
 * terms, and re-scanning those forever would make the backfill never finish.
 */
export async function backfillMemorySearchTerms(
    limit = 500
): Promise<{ updated: number; remaining: number }> {
    const stale = await prisma.memoryItem.findMany({
        where: { retrievalVersion: { lt: MEMORY_RETRIEVAL_VERSION } },
        take: limit,
        select: { id: true, kind: true, statement: true },
    });
    for (const row of stale) {
        await prisma.memoryItem.update({
            where: { id: row.id },
            data: {
                searchTerms: memorySearchTerms(row),
                retrievalVersion: MEMORY_RETRIEVAL_VERSION,
            },
        });
    }
    const remaining = await prisma.memoryItem.count({
        where: { retrievalVersion: { lt: MEMORY_RETRIEVAL_VERSION } },
    });
    return { updated: stale.length, remaining };
}