import type { Prisma } from "@prisma/client";

import { AMUX_V22_CLI_FAILURE_REASON_CODES } from "./v22TaskExecutionCore.ts";

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
 *
 * The claimed Task's own failed attempt is also left out when the CLI named
 * its failure (lib/amux/v22TaskExecutionCore.ts, AMUX_V22_CLI_FAILURE_REASONS)
 * and the owner resolved the review with a retry bound to exactly that attempt
 * (AmuxReviewProposal.attemptId plus its AmuxReviewDecision). An ordinary
 * review retry creates no recovery approval, so without this the approved
 * retry waited as usage_unverified for as long as the failed attempt was the
 * worker's (owner decision 2026-11-06; review r-20261107-015440-41ac19).
 * The receipt stays partial: every other Task still sees the attempt and is
 * still refused that worker.
 */
export async function amuxV22WorkerUsageUnverified(tx: Prisma.TransactionClient,
  workerName: string, priorAttemptId: string | null, taskId: string): Promise<boolean> {
  const retryableReasons = [...AMUX_V22_CLI_FAILURE_REASON_CODES];
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
      AND NOT COALESCE(a."taskId" = ${taskId}
        AND a."v22AssignmentId" IS NOT NULL
        AND a."outcome" = 'blocked' AND a."toStatus" = 'blocked'
        AND a."reason" = ANY(${retryableReasons}::text[])
        AND EXISTS (SELECT 1 FROM "AmuxReviewProposal" p
          JOIN "AmuxReviewDecision" d ON d."proposalId" = p."id"
            AND d."escalationId" = p."escalationId"
          WHERE p."attemptId" = a."id" AND p."taskId" = a."taskId"
            AND p."outcome" = 'retry' AND d."outcome" = 'retry'), FALSE)
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * The routes whose worker has no unsettled usage, checked before a route is
 * chosen. Checking only the chosen (cheapest) route refused the whole claim
 * tick whenever that one worker was unsettled, so a settled worker on the
 * same Task was never tried (production 2026-11-06: investigate/routine
 * always chose codex-chore and never reached copilot-chore).
 */
export async function amuxV22RoutesWithSettledUsage<T extends { workerName: string }>(
  tx: Prisma.TransactionClient, routes: readonly T[], priorAttemptId: string | null,
  taskId: string,
): Promise<{ routes: T[]; unsettled: boolean }> {
  const unsettled = new Set<string>();
  for (const workerName of new Set(routes.map((route) => route.workerName))) {
    if (await amuxV22WorkerUsageUnverified(tx, workerName, priorAttemptId, taskId)) {
      unsettled.add(workerName);
    }
  }
  return { routes: routes.filter((route) => !unsettled.has(route.workerName)),
    unsettled: unsettled.size > 0 };
}
