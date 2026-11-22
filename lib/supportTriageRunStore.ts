/**
 * The only writer of `SupportTriageRun` (docs/policy/support-triage.md §4, §7).
 *
 * Each write is one transaction that arms the lane's timeouts first and
 * records its system audit entry in the same transaction, so a run row and
 * its audit entry commit or roll back together. The database owns the times:
 * the insert trigger stamps `createdAt` and `deadlineAt` and enforces the daily
 * cap, and the update trigger stamps `finishedAt` and records a late success
 * as `deadline_exceeded`.
 *
 * Finishing writes the audit entry before the update, and the update is the
 * transaction's last statement: if the row is not running any more the update
 * matches nothing, this throws, and the audit entry rolls back with it.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import type { SupportTriageSystemAuditActor } from "@/lib/adminAuditSystemActors";
import { amuxRolledBackWriteCode, amuxTransientDatabaseCode } from "@/lib/amux/readFailureCore";
import { prisma } from "@/lib/prisma";
import {
  LANE_TIMEOUTS,
  RETENTION_BATCHES_PER_RUN_MAX,
  type SupportTriageRunKind,
  type SupportTriageRunOutcome,
} from "@/lib/supportTriageCore";
import { armSupportTriageTransaction } from "@/lib/supportTriageTransaction";

const ACTOR: Readonly<Record<SupportTriageRunKind, SupportTriageSystemAuditActor>> = Object.freeze({
  worker: "support-triage-worker",
  retention: "support-triage-retention",
});

export class SupportTriageRunNotRunning extends Error {
  constructor(readonly runId: string) {
    super(`SupportTriageRun ${runId} is not running`);
    this.name = "SupportTriageRunNotRunning";
  }
}

/**
 * One more try for a run-row write whose session failed, without ever
 * writing the row or its audit entry twice.
 *
 * These two transactions run under the lane's timeouts, and the retention
 * lane allows 150 ms idle between statements. On 2026-11-21 (dev) one of them
 * lost its session to 25P03 (idle_in_transaction_session_timeout) and failed
 * the whole run: the batches retry a lost session (supportTriageRetention.ts),
 * but these did not.
 *
 * - A failure PostgreSQL rolled back as a whole (25P03 with its code, a
 *   deadlock, a serialization failure) committed nothing: write again.
 * - A lost session with no such code -- the usual form of an idle timeout,
 *   which the pg client reports at the next statement or at COMMIT as a
 *   closed connection -- may have lost only the COMMIT's answer. `committed`
 *   reads whether this write took effect, and its result is returned instead
 *   of writing again; only a write that did not take effect is repeated.
 *
 * Any other failure, and a second failure, is thrown as before.
 */
export const retryRunWriteOnce = async <T>(input: {
  readonly write: () => Promise<T>;
  /** This write's result if it committed, else null. Read after a lost session only. */
  readonly committed: () => Promise<T | null>;
}): Promise<T> => {
  try {
    return await input.write();
  } catch (error) {
    const rolledBack = amuxRolledBackWriteCode(error);
    const lost = rolledBack ? null : amuxTransientDatabaseCode(error);
    if (!rolledBack && !lost) throw error;
    console.warn(JSON.stringify({ event: "support_triage_run_write_retried", code: rolledBack ?? lost }));
    if (!rolledBack) {
      const done = await input.committed();
      if (done !== null) return done;
    }
    return input.write();
  }
};

export type StartedRun = {
  readonly id: string;
  readonly kind: SupportTriageRunKind;
  readonly createdAt: Date;
  readonly deadlineAt: Date;
};

export const startSupportTriageRun = async (kind: SupportTriageRunKind): Promise<StartedRun> => {
  // Chosen before the transaction, so a retry after a lost COMMIT answer can
  // tell whether this run row (and the audit entry in its transaction) exists.
  const id = randomUUID();
  return retryRunWriteOnce({
    write: () => startRunTransaction(kind, id),
    committed: async () => {
      const row = await prisma.supportTriageRun.findUnique({
        where: { id },
        select: { id: true, createdAt: true, deadlineAt: true },
      });
      return row ? { id: row.id, kind, createdAt: row.createdAt, deadlineAt: row.deadlineAt } : null;
    },
  });
};

const startRunTransaction = (kind: SupportTriageRunKind, id: string): Promise<StartedRun> =>
  prisma.$transaction(
    async (tx) => {
      await armSupportTriageTransaction(tx, kind);
      const run = await tx.supportTriageRun.create({
        // The trigger replaces deadlineAt from the kind; the value here only
        // satisfies the client's type and is never stored.
        data: { id, kind, deadlineAt: new Date(0) },
        select: { id: true, kind: true, createdAt: true, deadlineAt: true },
      });
      await writeSystemAuditLog({
        tx,
        systemActor: ACTOR[kind],
        action: "support_triage.run_started",
        targetType: "SupportTriageRun",
        targetId: run.id,
        summary: `Support-triage ${kind} run started`,
        metadata: { kind },
      });
      return { id: run.id, kind, createdAt: run.createdAt, deadlineAt: run.deadlineAt };
    },
    { timeout: LANE_TIMEOUTS[kind].prismaTransactionTimeoutMs }
  );

export type RunCounters = {
  readonly batchesCompleted?: number;
  readonly overdueRemaining?: number;
  readonly oldestOverdueAgeSeconds?: number;
  readonly blocked?: number;
};

const FINISHED_OUTCOMES: readonly SupportTriageRunOutcome[] = Object.freeze([
  "success",
  "partial",
  "failed",
]);

export type FinishedRun = {
  readonly id: string;
  /** What the database recorded: a late success comes back as deadline_exceeded. */
  readonly outcome: SupportTriageRunOutcome;
  readonly finishedAt: Date;
};

export const finishSupportTriageRun = async (input: {
  readonly id: string;
  readonly kind: SupportTriageRunKind;
  readonly outcome: "success" | "partial" | "failed";
  readonly counters?: RunCounters;
}): Promise<FinishedRun> => {
  if (!FINISHED_OUTCOMES.includes(input.outcome)) {
    throw new RangeError("a run finishes as success, partial or failed");
  }
  const counters = input.counters ?? {};
  for (const [name, value] of Object.entries(counters)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative integer`);
    }
  }
  if (
    input.kind === "retention" &&
    counters.batchesCompleted !== undefined &&
    counters.batchesCompleted > RETENTION_BATCHES_PER_RUN_MAX
  ) {
    throw new RangeError("a retention run completes at most eight batches");
  }

  return retryRunWriteOnce({
    write: () => finishRunTransaction(input, counters),
    // Finished, and by this writer: only this transaction writes the
    // run_finished entry, and it commits with the update or not at all.
    committed: async () => {
      const [row, audit] = await Promise.all([
        prisma.supportTriageRun.findFirst({
          where: { id: input.id, kind: input.kind, outcome: { not: "running" }, finishedAt: { not: null } },
          select: { id: true, outcome: true, finishedAt: true },
        }),
        prisma.adminAuditLog.findFirst({
          where: { targetType: "SupportTriageRun", targetId: input.id, action: "support_triage.run_finished" },
          select: { id: true },
        }),
      ]);
      return row?.finishedAt && audit
        ? { id: row.id, outcome: row.outcome as SupportTriageRunOutcome, finishedAt: row.finishedAt }
        : null;
    },
  });
};

const finishRunTransaction = (
  input: { readonly id: string; readonly kind: SupportTriageRunKind; readonly outcome: "success" | "partial" | "failed" },
  counters: RunCounters
): Promise<FinishedRun> =>
  prisma.$transaction(
    async (tx) => {
      await armSupportTriageTransaction(tx, input.kind);
      // The audit entry first; the update below is the last statement, so an
      // update that matches nothing rolls this entry back too.
      await writeSystemAuditLog({
        tx,
        systemActor: ACTOR[input.kind],
        action: "support_triage.run_finished",
        targetType: "SupportTriageRun",
        targetId: input.id,
        summary: `Support-triage ${input.kind} run finished`,
        metadata: { kind: input.kind, requestedOutcome: input.outcome },
      });
      const updated = await tx.supportTriageRun.updateManyAndReturn({
        where: { id: input.id, kind: input.kind, outcome: "running" },
        data: {
          outcome: input.outcome,
          batchesCompleted: counters.batchesCompleted,
          overdueRemaining: counters.overdueRemaining,
          oldestOverdueAgeSeconds: counters.oldestOverdueAgeSeconds,
          blocked: counters.blocked,
        },
        select: { id: true, outcome: true, finishedAt: true },
      });
      const [row] = updated;
      if (!row || row.finishedAt === null) throw new SupportTriageRunNotRunning(input.id);
      return { id: row.id, outcome: row.outcome as SupportTriageRunOutcome, finishedAt: row.finishedAt };
    },
    { timeout: LANE_TIMEOUTS[input.kind].prismaTransactionTimeoutMs }
  );
