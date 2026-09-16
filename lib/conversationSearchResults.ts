/**
 * Merging native and imported message hits into one search answer.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.2.
 *
 * Pure, and fed only rows the caller has already authorised. That ordering is
 * the contract: every cap and every `truncated` decision here is made over
 * rows the viewer may see, so a locked conversation with a thousand matches
 * changes nothing about the answer -- not its length, not its order, not
 * whether it says more exist.
 */

/** At most this many hits in one answer. */
export const SEARCH_RESULT_LIMIT = 30;
/** At most this many hits per conversation, so one long transcript cannot fill the list. */
export const SEARCH_RESULTS_PER_CONVERSATION = 5;
/**
 * Candidate rows read per conversation (or imported snapshot): one more than
 * may be shown, so a group with more than it can show is known to have them.
 */
export const SEARCH_CANDIDATES_PER_GROUP = SEARCH_RESULTS_PER_CONVERSATION + 1;
/**
 * Candidate rows read per kind. Rows arrive in the order of the answer, so any
 * hit beyond these sits behind `SEARCH_RESULT_LIMIT + 1` groups that each rank
 * above it and could not have been returned.
 */
export const SEARCH_CANDIDATE_ROW_LIMIT = (SEARCH_RESULT_LIMIT + 1) * SEARCH_CANDIDATES_PER_GROUP;
/** How many continuations one imported message is shown under. */
export const SEARCH_BRANCHES_PER_SOURCE_MESSAGE = 3;

/**
 * A literal substring for `LIKE`/`ILIKE` (and Prisma `contains`, which is the
 * same operator and does not escape `%` or `_`). PostgreSQL's default escape
 * character is `\`.
 */
export function escapeLikePattern(query: string): string {
    return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export type RankedSearchHit<T> = {
    /** The conversation the hit opens. */
    conversationId: string;
    /** That conversation's last activity, the primary order. */
    conversationUpdatedAt: Date;
    kind: "native" | "imported";
    /**
     * Newest-first within its kind: native `createdAt` milliseconds, imported
     * `ordinal`. Only compared between hits of the same kind.
     */
    recency: number;
    /**
     * Stable tie-break, unique per hit, compared descending -- the direction the
     * candidate SQL breaks equal timestamps (`id DESC`), so the rows it keeps
     * are the rows this ranking would keep.
     */
    key: string;
    value: T;
};

const compareHits = <T>(a: RankedSearchHit<T>, b: RankedSearchHit<T>) => {
    const activity = b.conversationUpdatedAt.getTime() - a.conversationUpdatedAt.getTime();
    if (activity !== 0) return activity;
    if (a.conversationId !== b.conversationId) {
        return a.conversationId < b.conversationId ? -1 : 1;
    }
    // Inside one conversation the Tomverse turns come first: they are the part
    // the reader wrote here, and the imported half is the older history.
    if (a.kind !== b.kind) return a.kind === "native" ? -1 : 1;
    if (a.recency !== b.recency) return b.recency - a.recency;
    return a.key > b.key ? -1 : a.key < b.key ? 1 : 0;
};

/**
 * Orders, caps per conversation and caps overall.
 *
 * `candidatesExhausted` is false when a candidate read stopped at a cap of its
 * own (its row limit, or an imported message shown under fewer continuations
 * than it has) -- the other ways an answer can be incomplete.
 */
export function rankSearchHits<T>(
    hits: readonly RankedSearchHit<T>[],
    { candidatesExhausted }: { candidatesExhausted: boolean }
): { results: T[]; truncated: boolean } {
    const perConversation = new Map<string, number>();
    const kept: RankedSearchHit<T>[] = [];
    let droppedByConversationCap = false;
    for (const hit of [...hits].sort(compareHits)) {
        const seen = perConversation.get(hit.conversationId) ?? 0;
        if (seen >= SEARCH_RESULTS_PER_CONVERSATION) {
            droppedByConversationCap = true;
            continue;
        }
        perConversation.set(hit.conversationId, seen + 1);
        kept.push(hit);
    }
    return {
        results: kept.slice(0, SEARCH_RESULT_LIMIT).map((hit) => hit.value),
        truncated:
            kept.length > SEARCH_RESULT_LIMIT ||
            droppedByConversationCap ||
            !candidatesExhausted,
    };
}

/**
 * Whether an error is PostgreSQL cancelling a statement for its timeout
 * (SQLSTATE 57014), however deeply the driver adapter wrapped it.
 */
export function isStatementTimeout(error: unknown): boolean {
    // Prisma 7 with adapter-pg puts the SQLSTATE at
    // `meta.driverAdapterError.cause.originalCode`; older shapes use `code`
    // or `cause`. Walked structurally, so a localised server message cannot
    // hide it.
    const seen = new Set<unknown>();
    const queue: unknown[] = [error];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);
        const record = current as Record<string, unknown>;
        if (record.code === "57014" || record.originalCode === "57014") return true;
        queue.push(record.cause, record.meta, record.driverAdapterError);
    }
    return false;
}
