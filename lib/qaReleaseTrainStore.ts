import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { readLatestQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import {
  qaReleaseTrainEmergencyAdmissible,
  qaReleaseTrainEmergencyFrom,
  qaReleaseTrainFoundOnMain,
  qaReleaseTrainHiddenFrom,
  qaReleaseTrainLastTrainFrom,
  qaReleaseTrainSelectionFrom,
  type QaReleaseTrainEmergency,
  type QaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainCargoCore";
import type { QaReleaseTrainPick } from "@/lib/qaReleaseTrainCore";

/**
 * The release train's records (docs/policy/qa-release-agent.md section 8 item
 * 12). The audit chain is the ledger: an admission and a report are system
 * audit rows of the merge lane's actor, written in the caller's transaction
 * through the shared writer. No table of its own and no raw SQL here.
 */
export const QA_RELEASE_TRAIN_ADMITTED_ACTION = "qa_release.train_admitted";
/** An emergency departure's admission: its own action, so it never spends the scheduled trains' pick. */
export const QA_RELEASE_TRAIN_EMERGENCY_ADMITTED_ACTION = "qa_release.train_emergency_admitted";
export const QA_RELEASE_TRAIN_REPORTED_ACTION = "qa_release.train_reported";
const TARGET_TYPE = "QaReleaseTrain";
/** Prisma's interactive-transaction limit: one lock, one read, one audit append. */
const TRANSACTION_MS = 15_000;

export type QaReleaseTrainRefusal = "revision_mismatch" | "no_control" | "already_admitted" | "no_emergency";

/**
 * Whether this departure may run: the caller's revision is the newest and this
 * departure was not admitted before (as either kind). An emergency departure
 * also needs the very request the train read to be the one still pending, so
 * a replayed or stale call, or one assembled from a request since replaced or
 * withdrawn, cannot start one. All of it is read after the audit chain lock, so nothing
 * can change between the read and the admission. A refusal writes nothing.
 * The develop merge lane's latch is not read (owner decision 2026-10-23): a
 * dev deploy problem says nothing about the picked pull requests, which run
 * main's own CI and are merged by a person.
 */
export async function admitQaReleaseTrain(input: {
  callerRevision: number | null;
  slot: string;
  /** The pending emergency request the train read and assembled from (its audit row id). */
  emergencyRequestId?: string;
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
        where: { action: { in: [QA_RELEASE_TRAIN_ADMITTED_ACTION, QA_RELEASE_TRAIN_EMERGENCY_ADMITTED_ACTION] }, targetType: TARGET_TYPE, targetId: input.slot },
        select: { id: true },
      });
      if (earlier) return { admitted: false as const, reason: "already_admitted" as const };
      const emergency = input.emergencyRequestId !== undefined;
      const pending = emergency ? (await readQaReleaseTrainEmergency(tx)).pending : null;
      if (input.emergencyRequestId !== undefined && !qaReleaseTrainEmergencyAdmissible(pending, input.emergencyRequestId)) {
        return { admitted: false as const, reason: "no_emergency" as const };
      }
      await writeSystemAuditLog({
        tx,
        systemActor: "qa-release-merge-lane",
        action: emergency ? QA_RELEASE_TRAIN_EMERGENCY_ADMITTED_ACTION : QA_RELEASE_TRAIN_ADMITTED_ACTION,
        targetType: TARGET_TYPE,
        targetId: input.slot,
        summary: emergency ? `Emergency release train ${input.slot} admitted.` : `Release train ${input.slot} admitted.`,
        metadata: { slot: input.slot, controlRevision: control.revision, ...(pending ? { emergency: true, requestId: pending.id, numbers: pending.numbers } : {}) },
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

export type QaReleaseTrainNext = QaReleaseTrainSelection & { emergency: QaReleaseTrainEmergency };

/**
 * What the next train carries: the newest saved pick, unless a scheduled
 * train was admitted after it (that train took it, and what it left out rides
 * next), and any emergency request still waiting. Read from the audit chain
 * the picks, the admissions and the reports are written to; nothing else
 * stores it. The carry comes from that scheduled train's own report, so an
 * emergency train reporting later never replaces it.
 */
export async function readQaReleaseTrainSelection(db: Prisma.TransactionClient = prisma): Promise<QaReleaseTrainNext> {
  const [pick, admission, emergency] = await Promise.all([
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
    readQaReleaseTrainEmergency(db),
  ]);
  const report =
    admission && typeof admission.targetId === "string"
      ? await db.adminAuditLog.findFirst({
          where: { action: QA_RELEASE_TRAIN_REPORTED_ACTION, targetType: TARGET_TYPE, targetId: admission.targetId },
          orderBy: { createdAt: "desc" },
          select: { metadata: true },
        })
      : null;
  const metadata = pick?.metadata as { numbers?: unknown } | null | undefined;
  return {
    ...qaReleaseTrainSelectionFrom({
      pick: pick ? { numbers: metadata?.numbers ?? null, at: pick.createdAt, by: pick.actorEmail } : null,
      admission: admission && typeof admission.targetId === "string" ? { slot: admission.targetId, at: admission.createdAt } : null,
      lastTrain: report ? qaReleaseTrainLastTrainFrom(report.metadata) : null,
    }),
    emergency,
  };
}

/* ------------------------------------------------------------------------- */
/* Emergency trains (owner request 2026-10-25)                                */
/* ------------------------------------------------------------------------- */

export const QA_RELEASE_TRAIN_EMERGENCY_ACTION = "qa_release.train_emergency_requested";
export const QA_RELEASE_TRAIN_EMERGENCY_TARGET_TYPE = "QaReleaseTrainEmergency";
export const QA_RELEASE_TRAIN_EMERGENCY_TARGET_ID = "next";

/** The newest emergency request, pending until an emergency admission after it takes it. */
export async function readQaReleaseTrainEmergency(db: Prisma.TransactionClient = prisma): Promise<QaReleaseTrainEmergency> {
  const [request, admission] = await Promise.all([
    db.adminAuditLog.findFirst({
      where: { action: QA_RELEASE_TRAIN_EMERGENCY_ACTION, targetType: QA_RELEASE_TRAIN_EMERGENCY_TARGET_TYPE, targetId: QA_RELEASE_TRAIN_EMERGENCY_TARGET_ID },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, actorEmail: true, metadata: true },
    }),
    db.adminAuditLog.findFirst({
      where: { action: QA_RELEASE_TRAIN_EMERGENCY_ADMITTED_ACTION, targetType: TARGET_TYPE },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, targetId: true },
    }),
  ]);
  const metadata = request?.metadata as { numbers?: unknown; reason?: unknown } | null | undefined;
  return qaReleaseTrainEmergencyFrom({
    request: request
      ? { id: request.id, numbers: metadata?.numbers ?? null, reason: metadata?.reason ?? null, at: request.createdAt, by: request.actorEmail }
      : null,
    admission: admission && typeof admission.targetId === "string" ? { slot: admission.targetId, at: admission.createdAt } : null,
  });
}

export type QaReleaseTrainAdmission = { slot: string; at: Date; emergency: boolean };

/**
 * Admissions of either kind since a moment, newest first, for the departure
 * board: a train admitted but not yet reported is still on it. `limit` only
 * bounds a runaway week; the board's week is far below it.
 */
export async function readQaReleaseTrainAdmissions(since: Date, limit = 200): Promise<QaReleaseTrainAdmission[]> {
  const rows = await prisma.adminAuditLog.findMany({
    where: {
      action: { in: [QA_RELEASE_TRAIN_ADMITTED_ACTION, QA_RELEASE_TRAIN_EMERGENCY_ADMITTED_ACTION] },
      targetType: TARGET_TYPE,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { action: true, targetId: true, createdAt: true },
  });
  return rows.flatMap((row) =>
    typeof row.targetId === "string" ? [{ slot: row.targetId, at: row.createdAt, emergency: row.action === QA_RELEASE_TRAIN_EMERGENCY_ADMITTED_ACTION }] : [],
  );
}

/**
 * Pull requests a train skipped as already on main since a moment, by the
 * newest train that did: the train compared their content with main, which
 * the cargo list's GitHub records cannot (lib/qaReleaseTrainCargoCore.ts).
 * `limit` only bounds a runaway fortnight.
 */
export async function readQaReleaseTrainFoundOnMain(since: Date, limit = 500): Promise<Map<number, string>> {
  const rows = await prisma.adminAuditLog.findMany({
    where: { action: QA_RELEASE_TRAIN_REPORTED_ACTION, targetType: TARGET_TYPE, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { targetId: true, metadata: true },
  });
  return qaReleaseTrainFoundOnMain(
    rows.flatMap((row) => {
      const metadata = row.metadata as { pullRequestNumber?: unknown; picks?: unknown } | null;
      return metadata && typeof row.targetId === "string" ? [{ slot: row.targetId, report: metadata }] : [];
    }),
  );
}

/** The reports of these trains, newest first. Rows that do not parse are left out. */
export async function readQaReleaseTrainReportsFor(slots: readonly string[]): Promise<QaReleaseTrainRecord[]> {
  if (slots.length === 0) return [];
  const rows = await prisma.adminAuditLog.findMany({
    where: { action: QA_RELEASE_TRAIN_REPORTED_ACTION, targetType: TARGET_TYPE, targetId: { in: [...slots] } },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, createdAt: true, metadata: true },
  });
  return rows.flatMap((row) => {
    const metadata = row.metadata as Partial<QaReleaseTrainReport> | null;
    if (!metadata || typeof metadata.outcome !== "string" || !Array.isArray(metadata.picks) || typeof row.targetId !== "string") return [];
    return [{ slot: row.targetId, at: row.createdAt, report: metadata as QaReleaseTrainReport }];
  });
}

/**
 * The departure hours the train service last said it runs on, and when (it
 * says so every round, every 10 minutes). Display only, for Admin's next
 * train: one AppSetting row it overwrites, never an audit event, never read
 * by the train.
 */
export const QA_RELEASE_TRAIN_SCHEDULE_SETTING_KEY = "qa_release.train.schedule";

export type QaReleaseTrainSchedule = { hours: number[]; reportedAt: string };

export async function recordQaReleaseTrainSchedule(hours: readonly number[]): Promise<void> {
  const value = JSON.stringify({ hours: [...hours].sort((a, b) => a - b), reportedAt: new Date().toISOString() });
  await prisma.appSetting.upsert({
    where: { key: QA_RELEASE_TRAIN_SCHEDULE_SETTING_KEY },
    create: { key: QA_RELEASE_TRAIN_SCHEDULE_SETTING_KEY, value },
    update: { value },
  });
}

export async function readQaReleaseTrainSchedule(): Promise<QaReleaseTrainSchedule | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: QA_RELEASE_TRAIN_SCHEDULE_SETTING_KEY }, select: { value: true } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { hours?: unknown; reportedAt?: unknown };
    const hours = Array.isArray(parsed.hours) ? parsed.hours.filter((hour): hour is number => Number.isInteger(hour) && hour >= 0 && hour <= 23) : [];
    return hours.length > 0 && typeof parsed.reportedAt === "string" ? { hours, reportedAt: parsed.reportedAt } : null;
  } catch {
    return null;
  }
}

/**
 * The candidates an operator hid from Admin's next-train list
 * (lib/qaReleaseTrainCargoCore.ts): the newest hidden row's list. Display
 * only; the train never reads it.
 */
export const QA_RELEASE_TRAIN_HIDDEN_ACTION = "qa_release.train_cargo_hidden";
export const QA_RELEASE_TRAIN_HIDDEN_TARGET_ID = "hidden";

export async function readQaReleaseTrainHidden(db: Prisma.TransactionClient = prisma): Promise<number[]> {
  const row = await db.adminAuditLog.findFirst({
    where: { action: QA_RELEASE_TRAIN_HIDDEN_ACTION, targetType: QA_RELEASE_TRAIN_CARGO_TARGET_TYPE, targetId: QA_RELEASE_TRAIN_HIDDEN_TARGET_ID },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  return qaReleaseTrainHiddenFrom((row?.metadata as { numbers?: unknown } | null | undefined)?.numbers);
}
