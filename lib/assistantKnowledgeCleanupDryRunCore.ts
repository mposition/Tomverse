/**
 * What a retention dry run may say about the knowledge tombstone queue.
 *
 * The dry run reported one number for knowledge and it was the wrong one.
 * `storageCleanupQueues` counts *completed* cleanup rows past their retention
 * cutoff -- rows being garbage-collected long after their bytes went -- and it
 * merges image assets and knowledge into a single figure. An operator about to
 * type RUN CLEANUP could not see how many objects the run would actually
 * delete from R2, whether one run would clear the backlog, or whether anything
 * was stuck. That was found by the `227be331` staging round, which had to
 * observe the sweep from a cron log and a Cloudflare console because no
 * surface reported it (record: finding 1).
 *
 * Pure, so the shape and its invariants are testable without a database
 * (tests/assistantKnowledgeCleanupDryRun.test.mjs).
 *
 * Three decisions are load-bearing.
 *
 * **`pendingTombstones` is derived, never counted.** A pending row is either
 * retryable or exhausted and nothing else, so counting all three separately
 * would read the table at three instants and could report a total that
 * disagrees with its own parts. A dry run whose numbers do not add up is worse
 * than one with fewer numbers.
 *
 * **`truncated` compares the cap against `retryable` alone.** The drain
 * selects `completedAt: null AND attempts < max` and takes `executionLimit` of
 * them, so exhausted rows are not competing for those slots. Counting them
 * would report a backlog the run was never going to touch.
 *
 * **The orphan scan is reported as not run, rather than omitted.** It is the
 * arm that lists the bucket, and listing the object store is not something a
 * dry run should do -- but a dry run that simply leaves it out reads as "there
 * is nothing to collect", which is a claim about the bucket made without
 * looking at it.
 *
 * Nothing here carries an object key, a file name, or any file content: the
 * result is written to `AdminRetentionRun.result` and to the audit log
 * (docs/policy/external-conversation-import-and-memory.md §14), and counts
 * are what those records are for.
 */

export type KnowledgeCleanupQueueCounts = {
    /** Pending and still under the attempt ceiling: what the drain will take. */
    retryable: number;
    /** Pending and past the ceiling: no longer retried, still not deleted. */
    exhausted: number;
    /** `createdAt` of the oldest pending row, retryable or not. */
    oldestPendingAt: Date | null;
    /** The cap the execution actually passes to the drain. */
    executionLimit: number;
};

export type KnowledgeCleanupDryRun = {
    pendingTombstones: number;
    retryable: number;
    exhausted: number;
    /**
     * Oldest of *all* pending rows. With `exhausted: 0` this is how far behind
     * the drain is; with `exhausted` above zero it may belong to a row the
     * drain has given up on, which is why both are reported.
     */
    oldestPendingAt: string | null;
    executionLimit: number;
    /** More retryable rows than one execution can take. */
    truncated: boolean;
    orphanScan: { status: "not_run"; reason: string };
};

const ORPHAN_SCAN_NOT_RUN = {
    status: "not_run",
    reason: "A dry run does not list the object store.",
} as const;

export function describeKnowledgeCleanupQueue(
    counts: KnowledgeCleanupQueueCounts
): KnowledgeCleanupDryRun {
    const retryable = Math.max(0, Math.trunc(counts.retryable));
    const exhausted = Math.max(0, Math.trunc(counts.exhausted));
    const executionLimit = Math.max(0, Math.trunc(counts.executionLimit));
    return {
        pendingTombstones: retryable + exhausted,
        retryable,
        exhausted,
        oldestPendingAt: counts.oldestPendingAt
            ? counts.oldestPendingAt.toISOString()
            : null,
        executionLimit,
        truncated: retryable > executionLimit,
        orphanScan: ORPHAN_SCAN_NOT_RUN,
    };
}
