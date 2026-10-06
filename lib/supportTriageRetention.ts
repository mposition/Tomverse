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
 * One batch deletes every class in `RETENTION_CLASSES`, one window read and
 * one delete per class, each class with its own cursor: run rows 30 days
 * after creation, terminal suggestions and terminal groups 30 days after they
 * became terminal (both are immutable once terminal, so updatedAt and
 * keyRetiredAt are those moments), and decision records at their own
 * retentionUntil. A cancellation is charged to the class whose statement was
 * running, and only that class's window is skipped.
 */
import "server-only";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  LANE_TIMEOUTS,
  RETENTION_BATCH_SIZES,
  RETENTION_OVERDUE_GRACE_SECONDS,
  RETENTION_CLASSES,
  SUGGESTION_TERMINAL_STATES,
  SUPPORT_TRIAGE_RUN_RETENTION_DAYS,
  TERMINAL_GROUP_RETENTION_DAYS,
  TERMINAL_SUGGESTION_RETENTION_DAYS,
  mayStartRetentionBatch,
  type RetentionClass,
  reducedRetentionBatchSize,
} from "@/lib/supportTriageCore";
import { finishSupportTriageRun, startSupportTriageRun } from "@/lib/supportTriageRunStore";
import { armSupportTriageTransaction } from "@/lib/supportTriageTransaction";

const STATEMENT_CANCELLED = "57014";

/**
 * Whether an error is PostgreSQL's query_canceled (SQLSTATE 57014). Decided by
 * the code alone, never by message text: Prisma's adapter carries it as
 * `meta.driverAdapterError.cause.originalCode`, the pg driver as `code`, and
 * a wrapper may nest either under `cause`.
 */
export const isStatementCancelled = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === STATEMENT_CANCELLED || record.originalCode === STATEMENT_CANCELLED) return true;
    for (const key of ["cause", "meta", "driverAdapterError"]) queue.push(record[key]);
  }
  return false;
};

/** Where a class's next window starts: its ordering time, then id. */
type Cursor = { readonly at: Date; readonly id: string } | null;
type WindowRow = { id: string; at: Date };
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const GROUP_TERMINAL_STATES = ["dismissed", "expired", "invalidated"];

/** The rows of one class past their boundary, after the cursor, oldest first. */
const readWindow = (tx: Tx, cls: RetentionClass, after: Cursor, size: number) => {
  const afterAt = after?.at ?? null;
  const afterId = after?.id ?? "";
  switch (cls) {
    case "runs":
      return tx.$queryRaw<WindowRow[]>`
        SELECT r."id", r."createdAt" AS "at"
          FROM "SupportTriageRun" r
         WHERE r."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${SUPPORT_TRIAGE_RUN_RETENTION_DAYS}::integer)
           AND (${afterAt}::timestamp(3) IS NULL OR (r."createdAt", r."id") > (${afterAt}::timestamp(3), ${afterId}::text))
         ORDER BY r."createdAt", r."id"
         LIMIT ${size}::integer`;
    case "suggestions":
      return tx.$queryRaw<WindowRow[]>`
        SELECT s."id", s."updatedAt" AS "at"
          FROM "SupportTriageSuggestion" s
         WHERE s."state" = ANY(${[...SUGGESTION_TERMINAL_STATES]}::text[])
           AND s."updatedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${TERMINAL_SUGGESTION_RETENTION_DAYS}::integer)
           AND (${afterAt}::timestamp(3) IS NULL OR (s."updatedAt", s."id") > (${afterAt}::timestamp(3), ${afterId}::text))
         ORDER BY s."updatedAt", s."id"
         LIMIT ${size}::integer`;
    case "groups":
      return tx.$queryRaw<WindowRow[]>`
        SELECT g."id", g."keyRetiredAt" AS "at"
          FROM "SupportTriageGroup" g
         WHERE g."state" = ANY(${GROUP_TERMINAL_STATES}::text[])
           AND g."keyRetiredAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${TERMINAL_GROUP_RETENTION_DAYS}::integer)
           AND (${afterAt}::timestamp(3) IS NULL OR (g."keyRetiredAt", g."id") > (${afterAt}::timestamp(3), ${afterId}::text))
         ORDER BY g."keyRetiredAt", g."id"
         LIMIT ${size}::integer`;
    case "decisionRecords":
      return tx.$queryRaw<WindowRow[]>`
        SELECT d."id", d."retentionUntil" AS "at"
          FROM "SupportTriageDecisionRecord" d
         WHERE d."retentionUntil" <= (clock_timestamp() AT TIME ZONE 'UTC')
           AND (${afterAt}::timestamp(3) IS NULL OR (d."retentionUntil", d."id") > (${afterAt}::timestamp(3), ${afterId}::text))
         ORDER BY d."retentionUntil", d."id"
         LIMIT ${size}::integer`;
  }
};

/** Deletes exactly the rows a window read; every class here is immutable once due. */
const deleteWindow = async (tx: Tx, cls: RetentionClass, ids: string[]) => {
  const where = { id: { in: ids } };
  switch (cls) {
    case "runs":
      return (await tx.supportTriageRun.deleteMany({ where })).count;
    case "suggestions":
      return (await tx.supportTriageSuggestion.deleteMany({ where })).count;
    case "groups":
      return (await tx.supportTriageGroup.deleteMany({ where })).count;
    case "decisionRecords":
      // Its links go with it (cascade).
      return (await tx.supportTriageDecisionRecord.deleteMany({ where })).count;
  }
};

type ClassCounts = Record<RetentionClass, number>;
const zeroCounts = (): ClassCounts => ({ runs: 0, suggestions: 0, groups: 0, decisionRecords: 0 });

const databaseNow = async (): Promise<Date> => {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return row.now;
};

type BatchResult =
  | {
      readonly kind: "deleted";
      readonly deleted: ClassCounts;
      /** Per class, where the window ended; absent when it was empty. */
      readonly last: Partial<Record<RetentionClass, Cursor>>;
      /** Classes whose window was full: more may lie past the cursor. */
      readonly full: readonly RetentionClass[];
    }
  | { readonly kind: "cancelled"; readonly cls: RetentionClass; readonly window: Cursor; readonly windowRows: number };

const runBatch = async (input: {
  readonly runId: string;
  readonly deadlineAt: Date;
  readonly size: number;
  readonly classes: readonly RetentionClass[];
  readonly cursors: Readonly<Partial<Record<RetentionClass, Cursor>>>;
}): Promise<BatchResult> => {
  let current: RetentionClass = input.classes[0];
  let windowEnd: Cursor = null;
  let windowRows = 0;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await armSupportTriageTransaction(tx, "retention");
        const deleted = zeroCounts();
        const last: Partial<Record<RetentionClass, Cursor>> = {};
        const full: RetentionClass[] = [];
        for (const cls of input.classes) {
          current = cls;
          windowEnd = null;
          windowRows = 0;
          const window = await readWindow(tx, cls, input.cursors[cls] ?? null, input.size);
          const lastRow = window[window.length - 1];
          windowEnd = lastRow ? { at: lastRow.at, id: lastRow.id } : null;
          windowRows = window.length;
          if (windowEnd) last[cls] = windowEnd;
          if (window.length === input.size) full.push(cls);
          if (window.length > 0) deleted[cls] = await deleteWindow(tx, cls, window.map((row) => row.id));
        }
        const total = RETENTION_CLASSES.reduce((sum, cls) => sum + deleted[cls], 0);
        // Nothing past its boundary: nothing written, so nothing to audit.
        if (total === 0) return { kind: "deleted" as const, deleted, last, full };
        await writeSystemAuditLog({
          tx,
          systemActor: "support-triage-retention",
          action: "support_triage.retention_batch",
          targetType: "SupportTriageRun",
          targetId: input.runId,
          summary: "Support-triage retention batch",
          metadata: { deleted: total, batchSize: input.size, ...deleted },
        });
        // Last round trip: the database clock against the run deadline.
        await tx.$executeRaw`SELECT "support_triage_assert_deadline"(${input.deadlineAt}::timestamp(3))`;
        return { kind: "deleted" as const, deleted, last, full };
      },
      { timeout: LANE_TIMEOUTS.retention.prismaTransactionTimeoutMs }
    );
  } catch (error) {
    if (isStatementCancelled(error)) return { kind: "cancelled", cls: current, window: windowEnd, windowRows };
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

/** Rows past their boundary in every class, and how long the oldest has waited. */
const overdueState = async () => {
  const [row] = await prisma.$queryRaw<{ remaining: bigint | null; oldestAgeSeconds: number | null }[]>`
    WITH now_utc AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS t),
    due AS (
      SELECT r."createdAt" + make_interval(days => ${SUPPORT_TRIAGE_RUN_RETENTION_DAYS}::integer) AS "dueAt"
        FROM "SupportTriageRun" r
      UNION ALL
      SELECT s."updatedAt" + make_interval(days => ${TERMINAL_SUGGESTION_RETENTION_DAYS}::integer)
        FROM "SupportTriageSuggestion" s WHERE s."state" = ANY(${[...SUGGESTION_TERMINAL_STATES]}::text[])
      UNION ALL
      SELECT g."keyRetiredAt" + make_interval(days => ${TERMINAL_GROUP_RETENTION_DAYS}::integer)
        FROM "SupportTriageGroup" g WHERE g."state" = ANY(${GROUP_TERMINAL_STATES}::text[])
      UNION ALL
      SELECT d."retentionUntil" FROM "SupportTriageDecisionRecord" d
    )
    SELECT count(*) AS remaining,
           floor(extract(epoch FROM (SELECT t FROM now_utc) - min(due."dueAt")))::integer AS "oldestAgeSeconds"
      FROM due
     WHERE due."dueAt" <= (SELECT t FROM now_utc)`;
  return {
    overdueRemaining: Number(row.remaining ?? 0),
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
  const cursors: Partial<Record<RetentionClass, Cursor>> = {};
  // Classes that may still hold rows past the cursor; a class leaves when its
  // window comes back short.
  let pending: RetentionClass[] = [...RETENTION_CLASSES];
  try {
    for (;;) {
      const remainingMs = run.deadlineAt.getTime() - (await databaseNow()).getTime();
      if (!mayStartRetentionBatch({ remainingMs, batchesStarted })) break;
      batchesStarted += 1;
      const result = await runBatch({ runId: run.id, deadlineAt: run.deadlineAt, size, classes: pending, cursors });
      if (result.kind === "deleted") {
        const batchDeleted = RETENTION_CLASSES.reduce((sum, cls) => sum + result.deleted[cls], 0);
        // A batch counts as completed when it deleted something: an empty
        // batch after a skipped window is not progress.
        if (batchDeleted > 0) batchesCompleted += 1;
        deleted += batchDeleted;
        // A committed batch clears the strike: two floor cancellations of the
        // same window, in a row, are what move the cursor.
        floorCancellations = 0;
        for (const cls of pending) {
          const windowEnd = result.last[cls];
          if (windowEnd) cursors[cls] = windowEnd;
        }
        pending = pending.filter((cls) => result.full.includes(cls));
        if (pending.length === 0) break; // nothing more past its boundary after any cursor
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
        if (result.window) cursors[result.cls] = result.window;
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
