import { Prisma } from "@prisma/client";

import { amuxResultFailureSignature, amuxResultFailureStreak } from "./executionBudgetCore.ts";
import { AMUX_INFRA_FAILURE_REASONS, amuxIsInfraFailureReason } from "./infraFailureCore.ts";

/**
 * The infrastructure failures the bound counts start after a person last
 * sent the card back with `retry` (an owner's review decision or recovery).
 * A system resolver -- the Decision Maker's settlement among them -- does not
 * start the bound over: an autonomous retry that did would let the same
 * platform failure run forever with no person seeing it, so a card that used
 * the bound goes to a person (the settlement refuses its retry,
 * dmOwnerSettlementService.ts). Earlier failures still use none of the card's
 * attempts.
 */
export const AMUX_INFRA_WINDOW_RETRY_SQL = Prisma.sql`e."status" = 'resolved' AND e."resolutionOutcome" = 'retry'
  AND e."resolvedById" IS NOT NULL AND e."resolvedById" NOT LIKE 'system:%'`;
const lastRetry = (taskId: string) => Prisma.sql`(SELECT MAX(e."resolvedAt")
  FROM "AmuxHumanEscalation" e
  WHERE e."taskId" = ${taskId} AND ${AMUX_INFRA_WINDOW_RETRY_SQL})`;

/**
 * A Task's attempts as the budget reads them, in one statement: every row,
 * the greatest number, the reserved total, how many ended as an
 * infrastructure failure (lib/amux/infraFailureCore.ts), and how many of those
 * came after a person's last retry (`infraWindowRows`, what the
 * infrastructure bound counts).
 */
export async function readAmuxAttemptBudgetFacts(tx: Prisma.TransactionClient,
  taskId: string) {
  const reasons = [...AMUX_INFRA_FAILURE_REASONS];
  const [row] = await tx.$queryRaw<Array<{ rows: number; greatest: number | null;
    infra: number; infraWindow?: number; reserved: bigint | null;
    lastEndedAt?: Date | null; lastEndedReason?: string | null }>>`
    SELECT COUNT(*)::int AS "rows", MAX(a."attemptNumber") AS "greatest",
      (SELECT x."endedAt" FROM "AmuxExecutionAttempt" x WHERE x."taskId" = ${taskId}
        AND x."endedAt" IS NOT NULL ORDER BY x."endedAt" DESC, x."id" DESC LIMIT 1) AS "lastEndedAt",
      (SELECT x."reason" FROM "AmuxExecutionAttempt" x WHERE x."taskId" = ${taskId}
        AND x."endedAt" IS NOT NULL ORDER BY x."endedAt" DESC, x."id" DESC LIMIT 1) AS "lastEndedReason",
      (COUNT(*) FILTER (WHERE a."reason" = ANY(${reasons}::text[])))::int AS "infra",
      (COUNT(*) FILTER (WHERE a."reason" = ANY(${reasons}::text[]) AND
        (r."at" IS NULL OR a."startedAt" > r."at")))::int AS "infraWindow",
      SUM(a."reservedCostMicrousd")::bigint AS "reserved"
    FROM "AmuxExecutionAttempt" a CROSS JOIN (SELECT ${lastRetry(taskId)} AS "at") r
    WHERE a."taskId" = ${taskId}`;
  const infraRows = row?.infra ?? 0;
  return {
    historicalRows: row?.rows ?? 0,
    greatestAttemptNumber: row?.greatest ?? null,
    infraRows,
    infraWindowRows: row?.infraWindow ?? infraRows,
    /** When the newest ended run ended, and whether it was a platform failure. */
    lastEndedAt: row?.lastEndedAt ? new Date(row.lastEndedAt) : null,
    lastEndedIsInfra: amuxIsInfraFailureReason(row?.lastEndedReason),
    reservedMicrousd: row?.reserved ?? BigInt(0),
  };
}

/**
 * The workers of the Task's latest run of infrastructure failures, newest
 * first: the claim tries another worker, and another provider, first.
 */
export async function recentAmuxInfraFailureWorkers(tx: Prisma.TransactionClient,
  taskId: string): Promise<string[]> {
  const rows = await tx.amuxExecutionAttempt.findMany({
    where: { taskId, endedAt: { not: null } },
    orderBy: [{ endedAt: "desc" }, { id: "desc" }], take: 6,
    select: { worker: true, reason: true } });
  const workers: string[] = [];
  for (const row of rows) {
    if (!amuxIsInfraFailureReason(row.reason)) break;
    if (!workers.includes(row.worker)) workers.push(row.worker);
  }
  return workers;
}

/**
 * How many of the Task's newest ended runs failed the same way in a row (owner
 * direction 2026-11-18: the claim waits longer for it, executionBudgetCore.ts
 * amuxResultRetryDelayMs; nothing stops the card). Only runs the worker did the work for count: infrastructure
 * failures are left out, and so is everything before a person's last retry.
 * A run is compared as `outcome:reason`. The read covers the newest runs
 * only; the delay is already at its largest well before this many.
 */
const RESULT_STREAK_READ_ROWS = 16;
export async function readAmuxResultFailureStreak(tx: Prisma.TransactionClient,
  taskId: string): Promise<{ streak: number }> {
  const infra = [...AMUX_INFRA_FAILURE_REASONS];
  const rows = await tx.$queryRaw<Array<{ outcome: string | null; reason: string | null }>>`
    SELECT a."outcome", a."reason"
    FROM "AmuxExecutionAttempt" a CROSS JOIN (SELECT ${lastRetry(taskId)} AS "at") r
    WHERE a."taskId" = ${taskId} AND a."endedAt" IS NOT NULL
      AND (a."reason" IS NULL OR a."reason" <> ALL(${infra}::text[]))
      AND (r."at" IS NULL OR a."startedAt" > r."at")
    ORDER BY a."endedAt" DESC, a."id" DESC
    LIMIT ${RESULT_STREAK_READ_ROWS}`;
  return { streak: amuxResultFailureStreak(
    rows.map((row) => amuxResultFailureSignature(row.outcome, row.reason))) };
}

/**
 * The Task's infrastructure failures other than this attempt: all of them
 * (`total`, which the attempt number still counts) and those since a
 * person's last retry (`window`, which the bound counts). One statement.
 */
export async function countAmuxInfraAttemptsBefore(tx: Prisma.TransactionClient,
  taskId: string, attemptId: string):
  Promise<{ total: number; window: number }> {
  const [row] = await tx.$queryRaw<Array<{ total: number; infraWindow: number }>>`
    SELECT COUNT(*)::int AS "total",
      (COUNT(*) FILTER (WHERE r."at" IS NULL OR a."startedAt" > r."at"))::int AS "infraWindow"
    FROM "AmuxExecutionAttempt" a CROSS JOIN (SELECT ${lastRetry(taskId)} AS "at") r
    WHERE a."taskId" = ${taskId} AND a."id" <> ${attemptId}
      AND a."reason" = ANY(${[...AMUX_INFRA_FAILURE_REASONS]}::text[])`;
  const total = Number(row?.total ?? 0);
  return { total, window: Math.min(total, Number(row?.infraWindow ?? total)) };
}
