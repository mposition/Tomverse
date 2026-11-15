import type { Prisma } from "@prisma/client";

import { AMUX_INFRA_FAILURE_REASONS, amuxInfraFailureRoutingEnabled,
  amuxIsInfraFailureReason } from "./infraFailureCore.ts";

/**
 * A Task's attempts as the budget reads them, in one statement: every row,
 * the greatest number, the reserved total, and how many ended as an
 * infrastructure failure (lib/amux/infraFailureCore.ts). With
 * TOMVERSE_AMUX_INFRA_FAILURE_ROUTING=disabled the last is always 0, so every
 * attempt counts again as before.
 */
export async function readAmuxAttemptBudgetFacts(tx: Prisma.TransactionClient,
  taskId: string, enabled = amuxInfraFailureRoutingEnabled()) {
  const reasons = enabled ? [...AMUX_INFRA_FAILURE_REASONS] : [];
  const [row] = await tx.$queryRaw<Array<{ rows: number; greatest: number | null;
    infra: number; reserved: bigint | null }>>`
    SELECT COUNT(*)::int AS "rows", MAX(a."attemptNumber") AS "greatest",
      (COUNT(*) FILTER (WHERE a."reason" = ANY(${reasons}::text[])))::int AS "infra",
      SUM(a."reservedCostMicrousd")::bigint AS "reserved"
    FROM "AmuxExecutionAttempt" a WHERE a."taskId" = ${taskId}`;
  return {
    historicalRows: row?.rows ?? 0,
    greatestAttemptNumber: row?.greatest ?? null,
    infraRows: row?.infra ?? 0,
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

/** The Task's infrastructure failures other than this attempt. */
export async function countAmuxInfraAttemptsBefore(tx: Prisma.TransactionClient,
  taskId: string, attemptId: string, enabled = amuxInfraFailureRoutingEnabled()) {
  if (!enabled) return 0;
  return tx.amuxExecutionAttempt.count({ where: { taskId, id: { not: attemptId },
    reason: { in: [...AMUX_INFRA_FAILURE_REASONS] } } });
}
