import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { readLatestQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import { qaReleaseTrainSelectionFrom, type QaReleaseTrainSelection } from "@/lib/qaReleaseTrainCargoCore";
import type { QaReleaseTrainPick } from "@/lib/qaReleaseTrainCore";

/**
 * The release train's records (docs/policy/qa-release-agent.md section 8 item
 * 12). The audit chain is the ledger: an admission and a report are system
 * audit rows of the merge lane's actor, written in the caller's transaction
 * through the shared writer. No table of its own and no raw SQL here.
 */
export const QA_RELEASE_TRAIN_ADMITTED_ACTION = "qa_release.train_admitted";
export const QA_RELEASE_TRAIN_REPORTED_ACTION = "qa_release.train_reported";
const TARGET_TYPE = "QaReleaseTrain";
/** Prisma's interactive-transaction limit: one lock, one read, one audit append. */
const TRANSACTION_MS = 15_000;

export type QaReleaseTrainRefusal = "revision_mismatch" | "no_control" | "already_admitted";

/**
 * Whether this departure may run: the caller's revision is the newest and this
 * departure was not admitted before. Both are read after the audit chain lock,
 * so neither can change between the read and the admission. A refusal writes
 * nothing. The develop merge lane's latch is not read (owner decision
 * 2026-10-23): a dev deploy problem says nothing about the picked pull
 * requests, which run main's own CI and are merged by a person.
 */
export async function admitQaReleaseTrain(input: {
  callerRevision: number | null;
  slot: string;
}): Promise<{ admitted: true; controlRevision: number } | { admitted: false; reason: QaReleaseTrainRefusal }> {
  return prisma.$transaction(
    async (tx) => {
      await takeAuditChainLock(tx);
      const control = await readLatestQaReleaseOperatorControl(tx);
      if (!control) return { admitted: false as const, reason: "no_control" as const };
      if (input.callerRevision !== control.revision) return { admitted: false as const, reason: "revision_mismatch" as const };
      // One admission per departure: an empty or failed train is not rerun
      // by the next tick inside the same hour.
      const earlier = await tx.adminAuditLog.findFirst({
        where: { action: QA_RELEASE_TRAIN_ADMITTED_ACTION, targetType: TARGET_TYPE, targetId: input.slot },
        select: { id: true },
      });
      if (earlier) return { admitted: false as const, reason: "already_admitted" as const };
      await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-merge-lane",
        action: QA_RELEASE_TRAIN_ADMITTED_ACTION,
        targetType: TARGET_TYPE,
        targetId: input.slot,
        summary: `Release train ${input.slot} admitted.`,
        metadata: { slot: input.slot, controlRevision: control.revision },
      });
      return { admitted: true as const, controlRevision: control.revision };
    },
    { maxWait: 5_000, timeout: TRANSACTION_MS },
  );
}

export type QaReleaseTrainReport = {
  slot: string;
  outcome: "opened" | "empty" | "failed";
  /** Set when a pull request was opened. */
  pullRequestNumber: number | null;
  branch: string | null;
  rcSha: string | null;
  /** A short code, never a log line: why a failed train failed. */
  failure: string | null;
  picks: QaReleaseTrainPick[];
};

/** What a train did. Kept whatever the revision, so a late report is never lost. */
export async function reportQaReleaseTrain(input: { callerRevision: number | null; report: QaReleaseTrainReport }): Promise<{ recorded: true }> {
  const { report } = input;
  await prisma.$transaction(
    async (tx) => {
      await takeAuditChainLock(tx);
      await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-merge-lane",
        action: QA_RELEASE_TRAIN_REPORTED_ACTION,
        targetType: TARGET_TYPE,
        targetId: report.slot,
        summary:
          report.outcome === "opened"
            ? `Release train ${report.slot} opened pull request #${report.pullRequestNumber}.`
            : `Release train ${report.slot}: ${report.outcome}.`,
        metadata: { ...report, callerRevision: input.callerRevision },
      });
    },
    { maxWait: 5_000, timeout: TRANSACTION_MS },
  );
  return { recorded: true };
}

export type QaReleaseTrainRecord = { slot: string; at: Date; report: QaReleaseTrainReport };

/** The newest train reports, for Admin. Rows that do not parse are left out. */
export async function readQaReleaseTrainReports(limit = 5): Promise<QaReleaseTrainRecord[]> {
  const rows = await prisma.adminAuditLog.findMany({
    where: { action: QA_RELEASE_TRAIN_REPORTED_ACTION, targetType: TARGET_TYPE },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { targetId: true, createdAt: true, metadata: true },
  });
  return rows.flatMap((row) => {
    const metadata = row.metadata as Partial<QaReleaseTrainReport> | null;
    if (!metadata || typeof metadata.outcome !== "string" || !Array.isArray(metadata.picks) || typeof row.targetId !== "string") return [];
    return [{ slot: row.targetId, at: row.createdAt, report: metadata as QaReleaseTrainReport }];
  });
}

/* ------------------------------------------------------------------------- */
/* The next train's cargo, picked in Admin (owner decision 2026-10-23)        */
/* ------------------------------------------------------------------------- */

export const QA_RELEASE_TRAIN_CARGO_ACTION = "qa_release.train_cargo_selected";
export const QA_RELEASE_TRAIN_CARGO_TARGET_TYPE = "QaReleaseTrainCargo";
export const QA_RELEASE_TRAIN_CARGO_TARGET_ID = "next";

/**
 * What the next train carries: the newest saved pick, unless a train was
 * admitted after it (that train took it). Read from the audit chain the pick
 * and the admissions are written to; nothing else stores it.
 */
export async function readQaReleaseTrainSelection(db: Prisma.TransactionClient = prisma): Promise<QaReleaseTrainSelection> {
  const [pick, admission] = await Promise.all([
    db.adminAuditLog.findFirst({
      where: { action: QA_RELEASE_TRAIN_CARGO_ACTION, targetType: QA_RELEASE_TRAIN_CARGO_TARGET_TYPE, targetId: QA_RELEASE_TRAIN_CARGO_TARGET_ID },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, actorEmail: true, metadata: true },
    }),
    db.adminAuditLog.findFirst({
      where: { action: QA_RELEASE_TRAIN_ADMITTED_ACTION, targetType: TARGET_TYPE },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, targetId: true },
    }),
  ]);
  const metadata = pick?.metadata as { numbers?: unknown } | null | undefined;
  return qaReleaseTrainSelectionFrom({
    pick: pick ? { numbers: metadata?.numbers ?? null, at: pick.createdAt, by: pick.actorEmail } : null,
    admission: admission && typeof admission.targetId === "string" ? { slot: admission.targetId, at: admission.createdAt } : null,
  });
}
