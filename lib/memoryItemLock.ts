import type { Prisma } from "@prisma/client";

/**
 * The per-account lock on memory writes.
 *
 * Policy: docs/policy/external-conversation-import-and-memory.md §13.1.
 *
 * Every transaction that writes `MemoryItem` rows takes this before it reads
 * the rows it decides on:
 *
 *   - memory CRUD and review in lib/memoryService.ts (create, approve, bulk
 *     approve, reject, edit, pin, delete, delete-all)
 *   - extraction persistence (lib/memoryExtractionPersistence.ts)
 *   - both imported-source deletions (lib/externalImportService.ts)
 *   - the source lock and its reconciliation
 *     (lib/externalConversationLockService.ts)
 *   - the expiry sweep, per account (lib/memoryExpiryService.ts)
 *   - the search-term backfill (scripts/backfill-memory-search-terms.mjs)
 *
 * A path may enumerate which rows to work on without the lock, but the status,
 * statement and evidence it decides on are read again after taking it -- or,
 * for the expiry sweep, re-stated in the update's where clause.
 * tests/sourceDeletionLockOrder.test.mjs holds each writer to that.
 *
 * The deletions are why this is one function rather than a key string written
 * in several places. A deletion classifies the memories its source backs and
 * then acts on that classification before the cascade removes the evidence.
 * Any memory write landing in between makes the classification stale:
 *
 *   - an extraction commits a candidate the classification never saw, whose
 *     evidence the cascade then removes, leaving a source-derived statement with
 *     nothing behind it and no sweep to find it (MEM-SOURCE-DELETE-01);
 *   - an edit turns a derived memory user-touched after it was planned for
 *     deletion, and the stale plan deletes the user's edit;
 *   - a lock transition or an expiry moves a status the plan then overwrites
 *     or skips.
 *
 * Holding this lock, each of those either runs entirely before the deletion's
 * classification or entirely after its cascade.
 *
 * Order. Row locks that a path needs on `MemoryExtractionRun`,
 * `ExternalImport` or `ExternalConversation` are taken BEFORE this lock:
 *
 *   - extraction commit: its run row, then this lock
 *   - delete-all: the account's run rows, then this lock
 *   - source deletion: import row, snapshot rows by id, then this lock, then
 *     any continuation `Conversation` rows it keeps a title on
 *   - source lock: the snapshot row (its UPDATE), then this lock
 *
 * No holder of this lock then waits on a run, import or snapshot row: evidence
 * verification is a plain read, and evidence rows reference `ExternalMessage`
 * only. So the orders cannot form a cycle. The credit-account lock, where a
 * path needs one, comes before all of these (AGENTS.md).
 */
export function lockAccountMemoryItems(
    tx: Prisma.TransactionClient,
    userId: string
) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"memory-items:" + userId}))`;
}
