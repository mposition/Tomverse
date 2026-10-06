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
 *
 * A suggestion is kept 30 days after it became terminal or after its report
 * closed, whichever is earlier. The report keeps no closure timestamp (a
 * closure without a notification writes no lifecycle event), so two rules
 * stand in for it:
 *
 *   * each batch first moves open suggestions of closed reports to
 *     `invalidated`, so a suggestion's terminal time is at most one
 *     retention interval after its report closed;
 *   * a terminal suggestion is also due once its closed report's updatedAt
 *     is 30 days old. updatedAt is never earlier than the closure, so this
 *     never deletes early, and it bounds a backlog: a report closed long ago
 *     does not restart its suggestion's 30 days at the invalidation.
 *
 * What remains is the gap between a closure and the next successful retention
 * run, which the liveness heartbeat bounds.
 *
 * A class whose statement was cancelled is quarantined for the rest of the
 * run: later batches carry the other classes without it, so their deletes
 * commit, and the quarantined class is retried alone, smaller, and skipped
 * past its window after two cancellations at the floor size.
 */
import "server-only";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { FEEDBACK_STATUSES, isTerminalFeedbackStatus } from "@/lib/feedbackLifecycleCore";
import { prisma } from "@/lib/prisma";
import {
  LANE_TIMEOUTS,
  RETENTION_BATCH_SIZES,
  RETENTION_OVERDUE_GRACE_SECONDS,
  RETENTION_CLASSES,
  SUGGESTION_STATES,
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
const CLOSED_REPORT_STATUSES = FEEDBACK_STATUSES.filter(isTerminalFeedbackStatus);
const OPEN_SUGGESTION_STATES = SUGGESTION_STATES.filter((state) => !SUGGESTION_TERMINAL_STATES.includes(state));

/**
 * Moves up to `size` open suggestions of closed reports to invalidated. The
 * report is read, not locked: this write locks only suggestion rows, so an
 * account deletion holding the report waits here and never the other way.
 * The open-state condition is repeated on the updated row: a second run that
 * waited for the first one's lock re-reads the row and skips it, instead of
 * updating a terminal row the guard trigger refuses.
 */
export const invalidateClosedReportSuggestions = (tx: Tx, size: number) =>
  tx.$executeRaw`
    UPDATE "SupportTriageSuggestion" s
       SET "state" = 'invalidated'
     WHERE s."state" = ANY(${OPEN_SUGGESTION_STATES}::text[])
       AND s."id" IN (
       SELECT o."id"
         FROM "SupportTriageSuggestion" o
         JOIN "Feedback" f ON f."id" = o."feedbackId"
        WHERE f."status" = ANY(${CLOSED_REPORT_STATUSES}::text[])
          AND o."state" = ANY(${OPEN_SUGGESTION_STATES}::text[])
        ORDER BY o."id"
        LIMIT ${size}::integer)`;

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
          JOIN "Feedback" f ON f."id" = s."feedbackId"
         WHERE s."state" = ANY(${[...SUGGESTION_TERMINAL_STATES]}::text[])
           AND (s."updatedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${TERMINAL_SUGGESTION_RETENTION_DAYS}::integer)
                OR (f."status" = ANY(${CLOSED_REPORT_STATUSES}::text[])
                    AND f."updatedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${TERMINAL_SUGGESTION_RETENTION_DAYS}::integer)))
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
      readonly invalidated: number;
      /** Per class, where the window ended; absent when it was empty. */
      readonly last: Partial<Record<RetentionClass, Cursor>>;
      /** Classes that may hold more work past the cursor. */
      readonly full: readonly RetentionClass[];
    }
  | { readonly kind: "cancelled"; readonly cls: RetentionClass; readonly window: Cursor; readonly windowRows: number };

const runBatch = async (input: {
  readonly runId: string;
  readonly deadlineAt: Date;
  readonly sizes: Readonly<Record<RetentionClass, number>>;
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
        let invalidated = 0;
        const last: Partial<Record<RetentionClass, Cursor>> = {};
        const full: RetentionClass[] = [];
        for (const cls of input.classes) {
          current = cls;
          windowEnd = null;
          windowRows = 0;
          const size = input.sizes[cls];
          if (cls === "suggestions") {
            invalidated = await invalidateClosedReportSuggestions(tx, size);
            if (invalidated === size) full.push(cls);
          }
          const window = await readWindow(tx, cls, input.cursors[cls] ?? null, size);
          const lastRow = window[window.length - 1];
          windowEnd = lastRow ? { at: lastRow.at, id: lastRow.id } : null;
          windowRows = window.length;
          if (windowEnd) last[cls] = windowEnd;
          if (window.length === size && !full.includes(cls)) full.push(cls);
          if (window.length > 0) deleted[cls] = await deleteWindow(tx, cls, window.map((row) => row.id));
        }
        const total = RETENTION_CLASSES.reduce((sum, cls) => sum + deleted[cls], 0);
        // Nothing written, so nothing to audit.
        if (total === 0 && invalidated === 0) return { kind: "deleted" as const, deleted, invalidated, last, full };
        await writeSystemAuditLog({
          tx,
          systemActor: "support-triage-retention",
          action: "support_triage.retention_batch",
          targetType: "SupportTriageRun",
          targetId: input.runId,
          summary: "Support-triage retention batch",
          metadata: {
            deleted: total,
            batchSize: Math.max(...input.classes.map((cls) => input.sizes[cls])),
            ...deleted,
            invalidated,
          },
        });
        // Last round trip: the database clock against the run deadline.
        await tx.$executeRaw`SELECT "support_triage_assert_deadline"(${input.deadlineAt}::timestamp(3))`;
        return { kind: "deleted" as const, deleted, invalidated, last, full };
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
      -- The earlier of: terminal for 30 days, or its report closed for 30
      -- days. The report's updatedAt is no earlier than its closure, so the
      -- second arm can only under-state how long a row has been due.
      SELECT LEAST(
               CASE WHEN s."state" = ANY(${[...SUGGESTION_TERMINAL_STATES]}::text[]) THEN s."updatedAt" END,
               CASE WHEN f."status" = ANY(${CLOSED_REPORT_STATUSES}::text[]) THEN f."updatedAt" END
             ) + make_interval(days => ${TERMINAL_SUGGESTION_RETENTION_DAYS}::integer)
        FROM "SupportTriageSuggestion" s JOIN "Feedback" f ON f."id" = s."feedbackId"
       WHERE s."state" = ANY(${[...SUGGESTION_TERMINAL_STATES]}::text[])
          OR f."status" = ANY(${CLOSED_REPORT_STATUSES}::text[])
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
  const cursors: Partial<Record<RetentionClass, Cursor>> = {};
  const sizes = Object.fromEntries(RETENTION_CLASSES.map((cls) => [cls, RETENTION_BATCH_SIZES[0]])) as Record<
    RetentionClass,
    number
  >;
  const floorCancellations = zeroCounts();
  // Classes that may still hold work past the cursor; a class leaves when its
  // window comes back short.
  let pending: RetentionClass[] = [...RETENTION_CLASSES];
  // Classes cancelled in this run: retried alone so they cannot hold back the rest.
  const quarantined = new Set<RetentionClass>();
  try {
    for (;;) {
      if (pending.length === 0) break; // nothing more past its boundary after any cursor
      const remainingMs = run.deadlineAt.getTime() - (await databaseNow()).getTime();
      if (!mayStartRetentionBatch({ remainingMs, batchesStarted })) break;
      batchesStarted += 1;
      const healthy = pending.filter((cls) => !quarantined.has(cls));
      const classes = healthy.length > 0 ? healthy : [pending[0]];
      const result = await runBatch({ runId: run.id, deadlineAt: run.deadlineAt, sizes, classes, cursors });
      if (result.kind === "deleted") {
        const batchDeleted = RETENTION_CLASSES.reduce((sum, cls) => sum + result.deleted[cls], 0);
        // A batch counts as completed when it wrote something: an empty batch
        // after a skipped window is not progress.
        if (batchDeleted + result.invalidated > 0) batchesCompleted += 1;
        deleted += batchDeleted;
        for (const cls of classes) {
          const windowEnd = result.last[cls];
          if (windowEnd) cursors[cls] = windowEnd;
          // A committed batch clears the strike: two floor cancellations of
          // the same window, in a row, are what move the cursor.
          floorCancellations[cls] = 0;
        }
        pending = pending.filter((cls) => !classes.includes(cls) || result.full.includes(cls));
        continue;
      }
      const cls = result.cls;
      if (classes.length > 1) {
        // Set it aside at a smaller size; the others go on without it.
        quarantined.add(cls);
        sizes[cls] = reducedRetentionBatchSize(sizes[cls]) ?? sizes[cls];
        continue;
      }
      const smaller = reducedRetentionBatchSize(sizes[cls]);
      if (smaller !== null) {
        sizes[cls] = smaller;
        continue;
      }
      floorCancellations[cls] += 1;
      if (floorCancellations[cls] >= 2) {
        // Move past the window that keeps cancelling; the next run starts over.
        // Count the rows actually skipped, not the batch size. A window that
        // was never read cannot be skipped; the gate's batch cap ends the run.
        blocked += result.windowRows;
        if (result.window) cursors[cls] = result.window;
        floorCancellations[cls] = 0;
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
