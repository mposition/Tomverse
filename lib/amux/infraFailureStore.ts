import { Prisma } from "@prisma/client";

import { AMUX_INFRA_FAILURE_REASONS, amuxInfraFailureRoutingEnabled,
  amuxIsInfraFailureReason } from "./infraFailureCore.ts";

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
 * infrastructure bound counts). With TOMVERSE_AMUX_INFRA_FAILURE_ROUTING=
 * disabled both are always 0, so every attempt counts again as before.
 */
export async function readAmuxAttemptBudgetFacts(tx: Prisma.TransactionClient,
  taskId: string, enabled = amuxInfraFailureRoutingEnabled()) {
  const reasons = enabled ? [...AMUX_INFRA_FAILURE_REASONS] : [];
  const [row] = await tx.$queryRaw<Array<{ rows: number; greatest: number | null;
    infra: number; infraWindow?: number; reserved: bigint | null }>>`
    SELECT COUNT(*)::int AS "rows", MAX(a."attemptNumber") AS "greatest",
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
    reservedMicrousd: row?.reserved ?? BigInt(0),
  };
}

/**
 * The workers of the Task's latest run of infrastructure failures, newest
 * first: the claim tries another worker, and another provider, first.
 */
export async function recentAmuxInfraFailureWorkers(tx: Prisma.TransactionClient,
  taskId: string, enabled = amuxInfraFailureRoutingEnabled()): Promise<string[]> {
  if (!enabled) return [];
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
 * The Task's latest ended runs other than this one that its workers did the
 * work for (infrastructure failures left out), newest first, as
 * `outcome:reason` (lib/amux/executionBudgetCore.ts amuxRepeatedResultFailure).
 */
export async function readAmuxRecentResultSignatures(tx: Prisma.TransactionClient,
  taskId: string, attemptId: string, count: number): Promise<string[]> {
  const infra = amuxInfraFailureRoutingEnabled() ? [...AMUX_INFRA_FAILURE_REASONS] : [];
  const rows = await tx.amuxExecutionAttempt.findMany({
    where: { taskId, id: { not: attemptId }, endedAt: { not: null },
      ...(infra.length ? { OR: [{ reason: null }, { reason: { notIn: infra } }] } : {}) },
    orderBy: [{ endedAt: "desc" }, { id: "desc" }], take: Math.max(0, count),
    select: { outcome: true, reason: true } });
  return rows.map((row) => `${row.outcome ?? "unknown"}:${row.reason ?? "unknown"}`);
}

/**
 * The Task's infrastructure failures other than this attempt: all of them
 * (`total`, which the attempt number still counts) and those since a
 * person's last retry (`window`, which the bound counts). One statement.
 */
export async function countAmuxInfraAttemptsBefore(tx: Prisma.TransactionClient,
  taskId: string, attemptId: string, enabled = amuxInfraFailureRoutingEnabled()):
  Promise<{ total: number; window: number }> {
  if (!enabled) return { total: 0, window: 0 };
  const [row] = await tx.$queryRaw<Array<{ total: number; infraWindow: number }>>`
    SELECT COUNT(*)::int AS "total",
      (COUNT(*) FILTER (WHERE r."at" IS NULL OR a."startedAt" > r."at"))::int AS "infraWindow"
    FROM "AmuxExecutionAttempt" a CROSS JOIN (SELECT ${lastRetry(taskId)} AS "at") r
    WHERE a."taskId" = ${taskId} AND a."id" <> ${attemptId}
      AND a."reason" = ANY(${[...AMUX_INFRA_FAILURE_REASONS]}::text[])`;
  const total = Number(row?.total ?? 0);
  return { total, window: Math.min(total, Number(row?.infraWindow ?? total)) };
}
