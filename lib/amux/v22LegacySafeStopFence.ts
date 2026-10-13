import "server-only";

import type { Prisma } from "@prisma/client";

export const AMUX_V22_SAFE_STOP_FENCE_ERROR = "worker_safe_stop_fenced" as const;
export const AMUX_V22_SAFE_STOP_FENCE_CONSTRAINT =
  "AmuxV22LegacySafeStop_worker_fenced_check" as const;

/**
 * A safe-stop request permanently fences every configured member of its
 * physical profile. Evidence, runtime generations and later registrations do
 * not release it; v37 intentionally has no resume writer.
 */
export async function amuxV22SafeStopFencedWorkers(
  tx: Prisma.TransactionClient,
  workerNames: readonly string[],
) {
  if (!workerNames.length) return new Set<string>();
  const rows = await tx.$queryRaw<Array<{ workerName: string }>>`
    SELECT DISTINCT member AS "workerName"
    FROM "AmuxV22TaskRecoveryInspectionRequest" request,
      unnest(request."profileWorkerNames") AS member
    WHERE request."requestKind" = 'safe_stop'
      AND member = ANY(${[...workerNames]}::text[])
    ORDER BY member
  `;
  return new Set(rows.map((row) => row.workerName));
}

export async function amuxV22WorkerSafeStopFenced(
  tx: Prisma.TransactionClient,
  workerName: string,
) {
  return (await amuxV22SafeStopFencedWorkers(tx, [workerName])).has(workerName);
}

/** Defensive translation for rolling-deploy writers caught by the DB guard. */
export function isAmuxV22SafeStopFenceConstraintError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const meta = "meta" in error && error.meta && typeof error.meta === "object" ?
    JSON.stringify(error.meta) : "";
  return error.message.includes(AMUX_V22_SAFE_STOP_FENCE_CONSTRAINT) ||
    meta.includes(AMUX_V22_SAFE_STOP_FENCE_CONSTRAINT);
}
