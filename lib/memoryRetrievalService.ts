import "server-only";

import { createHash } from "node:crypto";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import {
    CORE_MEMORY_KINDS,
    MEMORY_RETRIEVAL_ALGORITHM_VERSION,
    selectMemoryContext,
    type MemoryContextBudget,
    type MemoryContextSelection,
    type RetrievableMemory,
} from "@/lib/memoryRetrievalScoring";
import { getMemorySettings } from "@/lib/memoryService";
import { STYLE_MEMORY_KINDS } from "@/lib/memoryValidatorCore";
import { prisma } from "@/lib/prisma";

/**
 * Retrieval v1 against the database (policy §9).
 *
 * The one query this makes is deliberately wider than the final selection:
 * it asks for the account's active memories that either share a term with the
 * request or are always-relevant (pinned, core, style), and lets the pure
 * scorer decide. Pushing the whole ranking into SQL would make the selection
 * depend on the planner, and §10 needs it to depend only on the inputs.
 *
 * What this function does NOT do is decide whether memory may be used at all.
 * The `memoryInjectionEnabled` flag, the approved-pair check and the
 * conversation-level mode belong to the caller that builds the prompt — this
 * one only answers "given that it may be used, which memories". The single
 * exception is the account's own master toggle, which is read here so no
 * caller can forget it: with it off the answer is always empty (§8.1).
 *
 * Nothing here writes. Retrieval never re-indexes a row it happens to notice
 * is stale — a read path that mutates on read turns a user's question into a
 * write and makes the same query non-idempotent. `npm run
 * maintenance:memory-search-terms` is the place that fixes those.
 */

/** Statuses that may reach a prompt. Everything else is excluded by §8.3. */
const RETRIEVABLE_STATUS = "active";

/**
 * Kinds the scorer never relevance-gates, so the query must fetch them even
 * when they share no term with the request: core facts describe who the user
 * is, and an answer-style preference applies to every answer.
 */
const ALWAYS_CONSIDERED_KINDS: string[] = [
    ...CORE_MEMORY_KINDS,
    ...STYLE_MEMORY_KINDS,
];

/**
 * Upper bound on rows considered before scoring. Large enough that a normal
 * account is never truncated, small enough that one pathological account
 * cannot make a chat request scan unboundedly.
 */
const MAX_CANDIDATES = 400;

export type MemoryRetrievalResult = MemoryContextSelection & {
    /** Stable hash of the selection, for the §10 context bundle to bind. */
    resultHash: string;
    algorithmVersion: number;
    /** How many rows the query returned before scoring, for §22 metrics. */
    consideredCount: number;
};

const EMPTY_RESULT: MemoryRetrievalResult = {
    selected: [],
    tokens: 0,
    omitted: {
        expired: 0,
        below_relevance: 0,
        duplicate: 0,
        source_cap: 0,
        token_budget: 0,
        item_cap: 0,
    },
    signature: `v${MEMORY_RETRIEVAL_ALGORITHM_VERSION}`,
    resultHash: "",
    algorithmVersion: MEMORY_RETRIEVAL_ALGORITHM_VERSION,
    consideredCount: 0,
};

const hashSignature = (signature: string) =>
    createHash("sha256").update(signature, "utf8").digest("hex");

export async function retrieveMemoryContext(input: {
    userId: string;
    /** The current request text. */
    query: string;
    now?: Date;
    budget?: Partial<MemoryContextBudget>;
}): Promise<MemoryRetrievalResult> {
    const now = input.now ?? new Date();
    const settings = await getMemorySettings(input.userId);
    if (!settings.masterEnabled) {
        return { ...EMPTY_RESULT, resultHash: hashSignature(EMPTY_RESULT.signature) };
    }

    const queryTerms = memoryRetrievalTerms(input.query);
    const rows = await prisma.memoryItem.findMany({
        where: {
            userId: input.userId,
            status: RETRIEVABLE_STATUS,
            AND: [
                // Expiry is filtered here as well as in the scorer: a row that
                // expired last month should not occupy one of the candidate
                // slots just to be dropped after it was fetched.
                { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                // The candidate union has to mirror what the scorer considers
                // always-relevant, or the two disagree and the disagreement is
                // invisible: a core or style memory the scorer would never
                // relevance-gate simply never arrives to be scored. Term
                // matches ride the GIN index; the rest are unioned in.
                ...(queryTerms.length > 0
                    ? [
                          {
                              OR: [
                                  { searchTerms: { hasSome: queryTerms } },
                                  { pinned: true },
                                  { kind: { in: ALWAYS_CONSIDERED_KINDS } },
                              ],
                          },
                      ]
                    : []),
            ],
        },
        orderBy: [{ pinned: "desc" }, { importance: "desc" }, { id: "asc" }],
        take: MAX_CANDIDATES,
        select: {
            id: true,
            kind: true,
            statement: true,
            conflictKey: true,
            confidence: true,
            importance: true,
            pinned: true,
            searchTerms: true,
            expiresAt: true,
            createdAt: true,
            approvedAt: true,
            // The source of a memory is the *conversation* its evidence came
            // from, not the message: the diversity cap exists so one imported
            // conversation cannot supply the whole context, and two messages
            // from the same conversation are one source.
            evidences: {
                select: {
                    externalMessage: { select: { externalConversationId: true } },
                },
            },
        },
    });

    const memories: RetrievableMemory[] = rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        statement: row.statement,
        conflictKey: row.conflictKey,
        confidence: row.confidence,
        importance: row.importance,
        pinned: row.pinned,
        searchTerms: row.searchTerms,
        // When the memory became true for this account. A candidate that sat
        // in review for a month is as old as its approval, not as its
        // extraction.
        effectiveAt: row.approvedAt ?? row.createdAt,
        expiresAt: row.expiresAt,
        sourceIds: [
            ...new Set(
                row.evidences
                    .map(
                        (evidence) =>
                            evidence.externalMessage?.externalConversationId ?? null
                    )
                    .filter((id): id is string => Boolean(id))
            ),
        ],
    }));

    const selection = selectMemoryContext({
        memories,
        query: queryTerms,
        now,
        styleEnabled: settings.styleEnabled,
        budget: input.budget,
    });

    return {
        ...selection,
        resultHash: hashSignature(selection.signature),
        algorithmVersion: MEMORY_RETRIEVAL_ALGORITHM_VERSION,
        consideredCount: rows.length,
    };
}
