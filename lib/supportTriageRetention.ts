/**
 * One support-triage retention run (docs/policy/support-triage.md §5).
 *
 * A run starts a `retention` row, then starts batches while the gate allows
 * (remaining budget above the batch's guarded budget, fewer than eight
 * batches), then finishes the row with its counters. Each batch is one
 * transaction: arm the lane timeouts, delete one window of rows past their
 * retention boundary, write the system audit entry, and as the last round
 * trip check the run's deadline in the database, so a late batch rolls back
 * whole.
 *
 * A batch cancelled by `statement_timeout` is retried smaller (500, 250, 125).
 * Two cancellations at the floor in one run move the cursor past that window
 * and count it as blocked: a row that never deletes cannot stop the step, and
 * is reported instead (`oldestOverdueAgeSeconds`).
 *
 * Today the only support-triage model is SupportTriageRun (30 days). Each
 * model the manifest adds gets its own delete statement in the same batch.
 */
import "server-only";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  LANE_TIMEOUTS,
  RETENTION_BATCH_SIZES,
  RETENTION_OVERDUE_GRACE_SECONDS,
  SUPPORT_TRIAGE_RUN_RETENTION_DAYS,
  mayStartRetentionBatch,
  reducedRetentionBatchSize,
} from "@/lib/supportTriageCore";
import { finishSupportTriageRun, startSupportTriageRun } from "@/lib/supportTriageRunStore";
import { armSupportTriageTransaction } from "@/lib/supportTriageTransaction";

const STATEMENT_CANCELLED = "57014";

const isStatementCancelled = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === STATEMENT_CANCELLED) return true;
    if (typeof record.message === "string" && record.message.includes("statement timeout")) return true;
    current = record.cause;
  }
  return false;
};

type Cursor = { readonly createdAt: Date; readonly id: string } | null;

const databaseNow = async (): Promise<Date> => {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return row.now;
};

type BatchResult =
  | { readonly kind: "deleted"; readonly deleted: number; readonly last: Cursor }
  | { readonly kind: "cancelled"; readonly window: Cursor; readonly windowRows: number };

const runBatch = async (input: {
  readonly runId: string;
  readonly deadlineAt: Date;
  readonly size: number;
  readonly after: Cursor;
}): Promise<BatchResult> => {
  let windowEnd: Cursor = null;
  let windowRows = 0;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await armSupportTriageTransaction(tx, "retention");
        const window = await tx.$queryRaw<{ id: string; createdAt: Date }[]>`
          SELECT r."id", r."createdAt"
            FROM "SupportTriageRun" r
           WHERE r."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${SUPPORT_TRIAGE_RUN_RETENTION_DAYS}::integer)
             AND (${input.after?.createdAt ?? null}::timestamp(3) IS NULL
                  OR (r."createdAt", r."id") > (${input.after?.createdAt ?? null}::timestamp(3), ${input.after?.id ?? ""}::text))
           ORDER BY r."createdAt", r."id"
           LIMIT ${input.size}::integer`;
        const lastRow = window[window.length - 1];
        windowEnd = lastRow ? { createdAt: lastRow.createdAt, id: lastRow.id } : null;
        windowRows = window.length;
        const deleted =
          window.length === 0
            ? 0
            : await tx.supportTriageRun.deleteMany({ where: { id: { in: window.map((row) => row.id) } } }).then(
                (result) => result.count
              );
        await writeSystemAuditLog({
          tx,
          systemActor: "support-triage-retention",
          action: "support_triage.retention_batch",
          targetType: "SupportTriageRun",
          targetId: input.runId,
          summary: "Support-triage retention batch",
          metadata: { deleted, batchSize: input.size },
        });
        // Last round trip: the database clock against the run deadline.
        await tx.$executeRaw`SELECT "support_triage_assert_deadline"(${input.deadlineAt}::timestamp(3))`;
        return { kind: "deleted" as const, deleted, last: windowEnd };
      },
      { timeout: LANE_TIMEOUTS.retention.prismaTransactionTimeoutMs }
    );
  } catch (error) {
    if (isStatementCancelled(error)) return { kind: "cancelled", window: windowEnd, windowRows };
    throw error;
  }
};

export type RetentionRunResult = {
  readonly runId: string;
  readonly outcome: string;
  readonly batchesCompleted: number;
  readonly deleted: number;
  readonly blocked: number;
  readonly overdueRemaining: number;
  readonly oldestOverdueAgeSeconds: number;
  /** True when the route must answer non-2xx: no progress, or a row past its grace. */
  readonly notProgressing: boolean;
};

const overdueState = async () => {
  const [row] = await prisma.$queryRaw<{ remaining: bigint; oldestAgeSeconds: number | null }[]>`
    SELECT count(*) AS remaining,
           floor(extract(epoch FROM (clock_timestamp() AT TIME ZONE 'UTC')
                 - (min(r."createdAt") + make_interval(days => ${SUPPORT_TRIAGE_RUN_RETENTION_DAYS}::integer))))::integer
             AS "oldestAgeSeconds"
      FROM "SupportTriageRun" r
     WHERE r."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${SUPPORT_TRIAGE_RUN_RETENTION_DAYS}::integer)`;
  return {
    overdueRemaining: Number(row.remaining),
    oldestOverdueAgeSeconds: Math.max(0, row.oldestAgeSeconds ?? 0),
  };
};

export const runSupportTriageRetention = async (): Promise<RetentionRunResult> => {
  const run = await startSupportTriageRun("retention");
  let batchesStarted = 0;
  let batchesCompleted = 0;
  let deleted = 0;
  let blocked = 0;
  let size: number = RETENTION_BATCH_SIZES[0];
  let floorCancellations = 0;
  let cursor: Cursor = null;
  try {
    for (;;) {
      const remainingMs = run.deadlineAt.getTime() - (await databaseNow()).getTime();
      if (!mayStartRetentionBatch({ remainingMs, batchesStarted })) break;
      batchesStarted += 1;
      const result = await runBatch({ runId: run.id, deadlineAt: run.deadlineAt, size, after: cursor });
      if (result.kind === "deleted") {
        // A batch counts as completed when it deleted something: an empty
        // batch after a skipped window is not progress.
        if (result.deleted > 0) batchesCompleted += 1;
        deleted += result.deleted;
        if (result.deleted < size) break; // nothing more past its boundary after the cursor
        continue;
      }
      const smaller = reducedRetentionBatchSize(size);
      if (smaller !== null) {
        size = smaller;
        continue;
      }
      floorCancellations += 1;
      if (floorCancellations >= 2) {
        // Move past the window that keeps cancelling; the next run starts over.
        // Count the rows actually skipped, not the batch size. A window that
        // was never read cannot be skipped; the gate's batch cap ends the run.
        blocked += result.windowRows;
        if (result.window) cursor = result.window;
        floorCancellations = 0;
      }
    }
    const { overdueRemaining, oldestOverdueAgeSeconds } = await overdueState();
    const finished = await finishSupportTriageRun({
      id: run.id,
      kind: "retention",
      outcome: overdueRemaining === 0 && blocked === 0 ? "success" : "partial",
      counters: { batchesCompleted, overdueRemaining, oldestOverdueAgeSeconds, blocked },
    });
    return {
      runId: run.id,
      outcome: finished.outcome,
      batchesCompleted,
      deleted,
      blocked,
      overdueRemaining,
      oldestOverdueAgeSeconds,
      notProgressing:
        (batchesCompleted === 0 && overdueRemaining > 0) ||
        oldestOverdueAgeSeconds > RETENTION_OVERDUE_GRACE_SECONDS,
    };
  } catch (error) {
    await finishSupportTriageRun({
      id: run.id,
      kind: "retention",
      outcome: "failed",
      counters: { batchesCompleted, blocked },
    }).catch(() => undefined);
    throw error;
  }
};
