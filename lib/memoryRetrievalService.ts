import "server-only";

import { createHash } from "node:crypto";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import {
    CORE_MEMORY_KINDS,
    MEMORY_RETRIEVAL_ALGORITHM_VERSION,
    MEMORY_SEMANTIC_DEFAULTS,
    MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION,
    memoryTier,
    selectMemoryContext,
    type MemoryContextBudget,
    type MemoryContextSelection,
    type RetrievableMemory,
} from "@/lib/memoryRetrievalScoring";
import { getMemorySettings } from "@/lib/memoryService";
import { STYLE_MEMORY_KINDS } from "@/lib/memoryValidatorCore";
import { prisma } from "@/lib/prisma";
import { rerankForRetrieval, semanticFeatureReady } from "@/lib/semanticRetrieval";
import type { SemanticCallMode } from "@/lib/semanticRetrievalCore";

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
 * ## Semantic relevance (docs/policy/external-conversation-import-and-memory.md §9a)
 *
 * With the operator's memory-rerank switch on, a second query adds recent
 * relevance-gated memories that share no term with the request -- the point
 * is to find one that shares none -- and the relevance-gated memories are
 * scored against the request by an external model. The lexical query and its
 * limit are unchanged, and core, pinned and style memories are untouched.
 * When the switch is off, or the call is refused or fails, the added
 * memories are dropped and the selection is the lexical one.
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

/**
 * The §12.4 provenance restriction, expressed in the query rather than
 * applied to the result.
 *
 * Filtering after the fetch would silently shrink the candidate set: rows
 * produced by a revoked pair would still occupy their share of
 * MAX_CANDIDATES and then be discarded, so an account with many revoked
 * memories would retrieve less than one with none — for a reason nothing
 * reports. Same argument as the always-considered union above.
 */
const provenanceFilter = (
    approvedPairs: ReadonlyArray<{
        extractionModelId: string;
        promptVersion: string;
    }>
) => ({
    OR: [
        // User-authored: no extraction pair, not subject to eval approval.
        { extractionModelId: null, promptVersion: null },
        // Edits and new manual grounds preserve the original extraction pair.
        // Individual approval cannot override an unapproved or revoked pair.
        ...approvedPairs.map((pair) => ({
            extractionModelId: pair.extractionModelId,
            promptVersion: pair.promptVersion,
        })),
    ],
});

/**
 * The §7.1 source-lock exclusion, also expressed in the query.
 *
 * `setExternalConversationLock()` already moves these rows out of `active`, so
 * in a consistent database this filter matches everything and costs a join.
 * It is here for the window where the database is *not* consistent — evidence
 * added to a memory after its source was locked, a reconciliation sweep that
 * has not run yet — because the two halves fail in opposite directions: the
 * status transition is what the user sees on their review screen, and this is
 * what decides whether a locked conversation's content can shape an answer.
 * Only one of those is worth being lazy about.
 *
 * A memory with no evidence rows at all is deliberately kept: that is the
 * §13.1 source-delete situation, which has its own status, and a lock
 * elsewhere in the account must not claim it.
 */
const reachableEvidenceFilter = {
    OR: [
        { evidences: { none: {} } },
        {
            evidences: {
                some: {
                    OR: [
                        // Manual grounds the user typed, and (later, §8.5)
                        // Tomverse messages: no source lock hides either.
                        { externalMessageId: null },
                        { externalMessage: { conversation: { password: null } } },
                    ],
                },
            },
        },
    ],
};

export async function retrieveMemoryContext(input: {
    userId: string;
    /** The current request text. */
    query: string;
    now?: Date;
    budget?: Partial<MemoryContextBudget>;
    /**
     * "cached_only" on the route that verifies a context bundle: the rerank
     * reuses what the issuing route stored and never calls the provider.
     * Defaults to "allow".
     */
    semantic?: SemanticCallMode;
    /**
     * Extraction pairs whose memories may be injected (§12.4). Omit to
     * consider every stored memory — which is right for diagnostics and for
     * the account's own review screens, and never right for a prompt.
     */
    approvedPairs?: ReadonlyArray<{
        extractionModelId: string;
        promptVersion: string;
    }>;
}): Promise<MemoryRetrievalResult> {
    const now = input.now ?? new Date();
    const settings = await getMemorySettings(input.userId);
    if (!settings.masterEnabled) {
        return { ...EMPTY_RESULT, resultHash: hashSignature(EMPTY_RESULT.signature) };
    }

    const queryTerms = memoryRetrievalTerms(input.query);

    // What every candidate has to satisfy, whichever query fetches it.
    const eligible = [
        // Expiry is filtered here as well as in the scorer: a row that
        // expired last month should not occupy one of the candidate
        // slots just to be dropped after it was fetched.
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ...(input.approvedPairs ? [provenanceFilter(input.approvedPairs)] : []),
        reachableEvidenceFilter,
    ];
    const select = {
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
                externalMessage: {
                    select: {
                        externalConversationId: true,
                        // Read so a locked snapshot can be dropped from the
                        // source set below.
                        conversation: { select: { password: true } },
                    },
                },
            },
        },
    } as const;

    const rows = await prisma.memoryItem.findMany({
        where: {
            userId: input.userId,
            status: RETRIEVABLE_STATUS,
            AND: [
                ...eligible,
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
        select,
    });

    // Semantic candidates (§9a) are fetched beside the lexical ones, never
    // instead of them. The query above is exactly the lexical query, with its
    // own limit, so nothing it would have returned can be pushed out by a
    // memory that is only here to be reranked -- and when the rerank is
    // refused or fails, the extras are dropped and the selection is the
    // lexical one, row for row. The extras are relevance-gated memories that
    // share no term with the request, newest first, at most one search unit's
    // worth. A request with no usable term asks for none: there is nothing to
    // rank them against.
    const rerank =
        input.semantic !== "off" &&
        queryTerms.length > 0 &&
        (await semanticFeatureReady("memoryRerank")) !== null;
    const extraRows = rerank
        ? await prisma.memoryItem.findMany({
              where: {
                  userId: input.userId,
                  status: RETRIEVABLE_STATUS,
                  AND: [
                      ...eligible,
                      { id: { notIn: rows.map((row) => row.id) } },
                      { pinned: false },
                      { kind: { notIn: ALWAYS_CONSIDERED_KINDS } },
                  ],
              },
              orderBy: [{ createdAt: "desc" }, { id: "asc" }],
              take: MEMORY_SEMANTIC_DEFAULTS.maxRerankCandidates,
              select,
          })
        : [];

    const toMemory = (row: (typeof rows)[number]): RetrievableMemory => ({
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
        // A locked snapshot is not a source for this purpose: the cap exists so
        // one conversation cannot supply the whole context, and a conversation
        // that contributes nothing should not spend a slot for the memory that
        // survived it on other evidence.
        sourceIds: [
            ...new Set(
                row.evidences
                    .map((evidence) =>
                        evidence.externalMessage &&
                        evidence.externalMessage.conversation.password == null
                            ? evidence.externalMessage.externalConversationId
                            : null
                    )
                    .filter((id): id is string => Boolean(id))
            ),
        ],
    });
    const memories = rows.map(toMemory);
    const extras = extraRows.map(toMemory);

    // Only the memories the selector would relevance-gate are sent -- the
    // lexical candidates first, in the query's own deterministic order, then
    // the extras -- and never one that has expired.
    const externalRelevance = rerank
        ? await rerankForRetrieval({
              feature: "memoryRerank",
              userId: input.userId,
              query: input.query,
              documents: [...memories, ...extras]
                  .filter(
                      (memory) =>
                          memoryTier(memory) === "relevant" &&
                          !(memory.expiresAt && memory.expiresAt.getTime() <= now.getTime())
                  )
                  .slice(0, MEMORY_SEMANTIC_DEFAULTS.maxRerankCandidates)
                  .map((memory) => ({ id: memory.id, text: memory.statement })),
              now,
              mode: input.semantic,
          })
        : null;

    const selection = selectMemoryContext({
        // Without a ranking the extras were never candidates.
        memories: externalRelevance ? [...memories, ...extras] : memories,
        query: queryTerms,
        now,
        styleEnabled: settings.styleEnabled,
        budget: input.budget,
        ...(externalRelevance ? { externalRelevance } : {}),
    });

    return {
        ...selection,
        resultHash: hashSignature(selection.signature),
        algorithmVersion: externalRelevance
            ? MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION
            : MEMORY_RETRIEVAL_ALGORITHM_VERSION,
        consideredCount: rows.length + (externalRelevance ? extraRows.length : 0),
    };
}
