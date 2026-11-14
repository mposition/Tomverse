import type { Prisma } from "@prisma/client";

import { AMUX_V22_CLI_FAILURE_REASON_CODES } from "./v22TaskExecutionCore.ts";
import { AMUX_V52_REVIEW_REJECTED_TWICE_REASON } from "./v52ReviewCore.ts";
import { amuxV22ReadBackProceedEnabled } from "./v22ReadBackProceedCore.ts";

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
 *
 * The same owner retry also releases the Task's own expired attempt whose
 * final result the server stored (lib/amux/reviewApprovalCore.ts,
 * amuxV22ReviewRetryHasVerifiedOutcome: outcome expired, toStatus blocked,
 * and the Task's latest AmuxV22TaskResult belongs to exactly that attempt).
 * The bridge reports CLI usage after it stores the result, so a lease that
 * expired between the two leaves no usage row at all, and the retry the owner
 * approved waited as usage_unverified forever (AMUX-FILEGEN-003, review
 * r-20261107-061707-e4a9a6). Nothing is written for that attempt either: every
 * other Task is still refused that worker.
 *
 * The same holds for a finished run the v52 review server rejected twice
 * (outcome succeeded, reason review_server_rejected_twice, with its reject
 * record), which the owner may also retry (owner decision 2026-11-07).
 *
 * An attempt the owner accepted as unknown is left out for every Task (owner
 * decision 2026-11-10; lib/amux/v22AttemptUsageAcceptance.ts): by itself from
 * the card's execution history, or with a recovery approval, one-click
 * pre-approval or review retry of its Task, which accepts all of that Task's
 * earlier unknown attempts. Before this only archiving released one, and
 * Admin archives only every card at once, so from 2026-11-09 19:54 AEST the
 * three implement workers stayed refused. The attempt's cap, cost and usage
 * rows are unchanged; only this gate stops counting it.
 *
 * With TOMVERSE_AMUX_V22_READ_BACK_PROCEED=enabled (owner decision
 * 2026-11-14, lib/amux/v22ReadBackProceedCore.ts) only a budget-bound attempt
 * counts: one whose assignment ran under a risk-accepted recovery approval,
 * the read-only API route where money is spent. A subscription CLI's unknown
 * usage is recorded and costs nothing more, so it holds no worker.
 */
export async function amuxV22WorkerUsageUnverified(tx: Prisma.TransactionClient,
  workerName: string, priorAttemptId: string | null, taskId: string,
  paidOnly: boolean = amuxV22ReadBackProceedEnabled()): Promise<boolean> {
  const retryableReasons = [...AMUX_V22_CLI_FAILURE_REASON_CODES];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "AmuxExecutionAttempt" a
    JOIN "AmuxWorkItem" w ON w."id" = a."taskId"
    WHERE a."worker" = ${workerName}
      AND a."id" IS DISTINCT FROM ${priorAttemptId}
      AND a."endedAt" IS NOT NULL
      AND w."sourceSystem" = 'admin-idea-v4'
      AND w."archivedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22AttemptUsageAcceptance" x
        WHERE x."attemptId" = a."id")
      AND (NOT EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
           WHERE u."attemptId" = a."id")
        OR EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
           WHERE u."attemptId" = a."id"
             AND u."completeness" <> 'reported_complete'))
      AND NOT COALESCE(a."taskId" = ${taskId}
        AND a."v22AssignmentId" IS NOT NULL
        AND a."toStatus" = 'blocked'
        AND ((a."outcome" = 'blocked'
            AND a."reason" = ANY(${retryableReasons}::text[]))
          OR (a."outcome" = 'expired'
            AND (SELECT r."attemptId" FROM "AmuxV22TaskResult" r
              WHERE r."taskId" = a."taskId"
              ORDER BY r."createdAt" DESC, r."attemptId" DESC
              LIMIT 1) = a."id")
          OR (a."outcome" = 'succeeded'
            AND a."reason" = ${AMUX_V52_REVIEW_REJECTED_TWICE_REASON}
            AND EXISTS (SELECT 1 FROM "AmuxV52ReviewRecord" r
              WHERE r."attemptId" = a."id" AND r."taskId" = a."taskId"
                AND r."verdict" = 'reject')))
        AND EXISTS (SELECT 1 FROM "AmuxReviewProposal" p
          JOIN "AmuxReviewDecision" d ON d."proposalId" = p."id"
            AND d."escalationId" = p."escalationId"
          WHERE p."attemptId" = a."id" AND p."taskId" = a."taskId"
            AND p."outcome" = 'retry' AND d."outcome" = 'retry'), FALSE)
      AND (${!paidOnly} OR EXISTS (SELECT 1 FROM "AmuxV22WorkerAssignment" g
        JOIN "AmuxV22TaskRecoveryApproval" ap ON ap."id" = g."recoveryApprovalId"
        WHERE g."id" = a."v22AssignmentId" AND ap."riskAcceptanceId" IS NOT NULL))
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
