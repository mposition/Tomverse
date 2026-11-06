import type { Prisma } from "@prisma/client";

/**
 * Whether a worker has an ended v4 attempt whose CLI usage was never reported
 * in full. A new cost-bound assignment to that worker waits until it is
 * settled: an absent or partial observation is never read as a zero-cost run.
 *
 * An attempt on an archived card is left out (owner decision 2026-11-06). Such
 * a card can no longer be retried, so the owner recovery path that excludes a
 * Task's own prior attempt can never reach it, and before this every new Task
 * on that worker was refused indefinitely (no v22 assignment from 2026-11-02).
 * Archiving the card is the owner accepting that its unknown usage stays
 * unknown.
 */
export async function amuxV22WorkerUsageUnverified(tx: Prisma.TransactionClient,
  workerName: string, priorAttemptId: string | null): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "AmuxExecutionAttempt" a
    JOIN "AmuxWorkItem" w ON w."id" = a."taskId"
    WHERE a."worker" = ${workerName}
      AND a."id" IS DISTINCT FROM ${priorAttemptId}
      AND a."endedAt" IS NOT NULL
      AND w."sourceSystem" = 'admin-idea-v4'
      AND w."archivedAt" IS NULL
      AND (NOT EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
           WHERE u."attemptId" = a."id")
        OR EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
           WHERE u."attemptId" = a."id"
             AND u."completeness" <> 'reported_complete'))
    LIMIT 1`;
  return rows.length > 0;
}
