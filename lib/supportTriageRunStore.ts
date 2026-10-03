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

export type StartedRun = {
  readonly id: string;
  readonly kind: SupportTriageRunKind;
  readonly createdAt: Date;
  readonly deadlineAt: Date;
};

export const startSupportTriageRun = async (kind: SupportTriageRunKind): Promise<StartedRun> =>
  prisma.$transaction(
    async (tx) => {
      await armSupportTriageTransaction(tx, kind);
      const run = await tx.supportTriageRun.create({
        // The trigger replaces deadlineAt from the kind; the value here only
        // satisfies the client's type and is never stored.
        data: { id: randomUUID(), kind, deadlineAt: new Date(0) },
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

  return prisma.$transaction(
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
};
