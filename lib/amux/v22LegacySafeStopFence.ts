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

/**
 * The routing snapshot's two worker facts in one statement: which named
 * workers own an open card (todo or doing, not archived; the same rule as
 * amuxWorkersOwningOpenCards) and which are permanently safe-stop fenced (the
 * same rule as amuxV22SafeStopFencedWorkers). One read keeps the snapshot
 * inside its Prisma-call ceiling and selection-route budget.
 */
export async function amuxV22OpenCardOwnersAndSafeStopFenced(
  tx: Prisma.TransactionClient,
  workerNames: readonly string[],
) {
  if (!workerNames.length) return { busy: new Set<string>(), fenced: new Set<string>() };
  const rows = await tx.$queryRaw<Array<{ workerName: string; busy: boolean; fenced: boolean }>>`
    SELECT name AS "workerName",
      EXISTS (SELECT 1 FROM "AmuxWorkItem" item
        WHERE item."owner" = name AND item."archivedAt" IS NULL
          AND item."status" IN ('todo', 'doing')) AS "busy",
      EXISTS (SELECT 1 FROM "AmuxV22TaskRecoveryInspectionRequest" request
        WHERE request."requestKind" = 'safe_stop'
          AND name = ANY(request."profileWorkerNames")) AS "fenced"
    FROM unnest(${[...workerNames]}::text[]) AS name
    ORDER BY name
  `;
  return {
    busy: new Set(rows.filter((row) => row.busy).map((row) => row.workerName)),
    fenced: new Set(rows.filter((row) => row.fenced).map((row) => row.workerName)),
  };
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
