import type { Prisma } from "@prisma/client";

/**
 * The per-account lock on memory writes.
 *
 * Policy: docs/policy/external-conversation-import-and-memory.md §13.1.
 *
 * Every transaction that reads memory rows and then writes memory rows based
 * on what it read takes this first: manual create/approve/edit/delete
 * (lib/memoryService.ts), extraction persistence
 * (lib/memoryExtractionPersistence.ts), and both imported-source deletions
 * (lib/externalImportService.ts).
 *
 * The deletions are why this is one function rather than a key string written
 * in three places. A deletion classifies the memories its source backs and
 * then cascades the evidence away. Without this lock an extraction could commit
 * a candidate and its evidence between those two steps: the classification
 * would not include it, the cascade would remove its evidence, and a
 * source-derived statement would remain with nothing behind it and no sweep to
 * find it (MEM-SOURCE-DELETE-01). Holding this lock, the deletion either waits
 * for that extraction and then classifies what it wrote, or runs first and the
 * extraction's evidence re-verification finds the source gone.
 *
 * Order relative to row locks: a source deletion takes its `ExternalImport` and
 * `ExternalConversation` row locks first and this lock after them. No holder of
 * this lock waits on those rows -- extraction verifies evidence with plain
 * reads, and evidence rows reference `ExternalMessage` only -- so the two
 * orders cannot form a cycle.
 */
export function lockAccountMemoryItems(
    tx: Prisma.TransactionClient,
    userId: string
) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"memory-items:" + userId}))`;
}
