/**
 * Support triage on the fifteen-minute maintenance cron
 * (docs/policy/support-triage.md §3, §7).
 *
 * There is no service of its own: `runSupportTriageCycleQuietly` rides the
 * credit-reservation cron, so turning triage on in the Admin console is all it
 * takes. Each kind runs on every second tick (under the daily cap of 52):
 *
 *   * worker: while triage is on (the Admin console switch, or with none saved,
 *     SUPPORT_TRIAGE_ENABLED exactly "true"). Off, nothing is written.
 *   * retention: while triage is on or anything is left to delete, whatever the
 *     switch says. A deployment that never used triage writes nothing.
 *
 * Never throws, so it cannot disturb the cron it rides on. What goes wrong is
 * an operational incident, carrying an error name and never a report or an id;
 * `readSupportTriageHealth` is what the Admin panel shows.
 */
import "server-only";

import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import {
  SUPPORT_TRIAGE_RUN_RETENTION_DAYS,
  supportTriageHeartbeatStale,
  type SupportTriageRunKind,
} from "@/lib/supportTriageCore";
import { resolveSupportTriageEnabled } from "@/lib/supportTriageLlmSetting";
import { runSupportTriageRetention } from "@/lib/supportTriageRetention";
import { SupportTriageTransactionRefused } from "@/lib/supportTriageTransaction";
import { runSupportTriageWorker, type WorkerPassResult } from "@/lib/supportTriageWorker";
import type { TriageLlm } from "@/lib/supportTriageLlm";

type Env = Readonly<Record<string, string | undefined>>;

/** Under the 30-minute cadence by one tick's jitter, so a late cron does not skip a turn. */
export const SUPPORT_TRIAGE_CYCLE_CADENCE_MS = 25 * 60_000;
const INCIDENT_COOLDOWN_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type StepOutcome = "off" | "not_due" | "ran" | "daily_cap" | "refused" | "failed";

export type SupportTriageCycleResult = {
  readonly worker: { readonly outcome: StepOutcome; readonly pass?: WorkerPassResult };
  readonly retention: { readonly outcome: StepOutcome; readonly notProgressing?: boolean };
};

/** The run-row trigger refused a run past the UTC day's cap. */
const isDailyCapExceeded = (error: unknown) =>
  error instanceof Error && error.message.includes("support_triage_run_daily_cap_exceeded");

const isDue = async (kind: SupportTriageRunKind, now: Date) => {
  const latest = await prisma.supportTriageRun.findFirst({
    where: { kind },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return !latest || now.getTime() - latest.createdAt.getTime() >= SUPPORT_TRIAGE_CYCLE_CADENCE_MS;
};

const retentionHasWork = async (now: Date) => {
  const [suggestion, oldRun] = await Promise.all([
    prisma.supportTriageSuggestion.findFirst({ select: { id: true } }),
    prisma.supportTriageRun.findFirst({
      where: { createdAt: { lte: new Date(now.getTime() - SUPPORT_TRIAGE_RUN_RETENTION_DAYS * DAY_MS) } },
      select: { id: true },
    }),
  ]);
  return suggestion !== null || oldRun !== null;
};

const stepFailure = async (kind: SupportTriageRunKind, error: unknown): Promise<StepOutcome> => {
  if (isDailyCapExceeded(error)) {
    console.warn(JSON.stringify({ event: "support_triage_daily_cap", kind }));
    return "daily_cap";
  }
  if (error instanceof SupportTriageTransactionRefused) {
    console.warn(JSON.stringify({ event: "support_triage_transaction_refused", kind, reason: error.reason }));
    return "refused";
  }
  await reportOperationalIncident({
    code: "SUPPORT_TRIAGE_CYCLE_FAILED",
    title: "A support triage run failed",
    // The name only: a database error can quote the row it failed on.
    error: error instanceof Error ? error.name : "unknown",
    cooldownMs: INCIDENT_COOLDOWN_MS,
    context: { component: "support-triage-cycle", kind },
  }).catch(() => undefined);
  return "failed";
};

export const runSupportTriageCycleQuietly = async ({
  env = process.env as Env,
  now = new Date(),
  llm,
}: {
  env?: Env;
  now?: Date;
  /** Replaces the configured model (tests). */
  llm?: TriageLlm | null;
} = {}): Promise<SupportTriageCycleResult> => {
  let enabled = false;
  try {
    enabled = (await resolveSupportTriageEnabled(env)).enabled;
  } catch (error) {
    const outcome = await stepFailure("worker", error);
    return { worker: { outcome }, retention: { outcome } };
  }

  let retention: SupportTriageCycleResult["retention"];
  try {
    if (!enabled && !(await retentionHasWork(now))) {
      retention = { outcome: "off" };
    } else if (!(await isDue("retention", now))) {
      retention = { outcome: "not_due" };
    } else {
      const { notProgressing } = await runSupportTriageRetention();
      if (notProgressing) {
        await reportOperationalIncident({
          code: "SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING",
          title: "Support triage rows past their retention are not being deleted",
          cooldownMs: INCIDENT_COOLDOWN_MS,
          context: { component: "support-triage-cycle" },
        }).catch(() => undefined);
      }
      retention = { outcome: "ran", notProgressing };
    }
  } catch (error) {
    retention = { outcome: await stepFailure("retention", error) };
  }

  let worker: SupportTriageCycleResult["worker"];
  try {
    if (!enabled) {
      worker = { outcome: "off" };
    } else if (!(await isDue("worker", now))) {
      worker = { outcome: "not_due" };
    } else {
      worker = { outcome: "ran", pass: await runSupportTriageWorker(llm === undefined ? {} : { llm }) };
    }
  } catch (error) {
    worker = { outcome: await stepFailure("worker", error) };
  }
  return { worker, retention };
};

export type SupportTriageHealth = {
  readonly worker: { readonly at: string; readonly outcome: string } | null;
  readonly retention: { readonly at: string; readonly outcome: string } | null;
  /** Reports the worker took up since the start of this UTC day. */
  readonly reportsToday: number;
  /** Runs of either kind since the start of this UTC day that did not succeed. */
  readonly failedRunsToday: number;
  /** A run is overdue or retention is stuck. Not judged while triage is off with nothing to delete. */
  readonly stale: boolean;
};

const lastFinished = async (kind: SupportTriageRunKind) => {
  const row = await prisma.supportTriageRun.findFirst({
    where: { kind, finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true, outcome: true },
  });
  return row?.finishedAt ? { at: row.finishedAt.toISOString(), outcome: row.outcome } : null;
};

const lastSuccessAt = async (kind: SupportTriageRunKind) => {
  const row = await prisma.supportTriageRun.findFirst({
    where: { kind, outcome: "success" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  return row?.finishedAt ?? null;
};

export const readSupportTriageHealth = async ({
  env = process.env as Env,
  now = new Date(),
}: {
  env?: Env;
  now?: Date;
} = {}): Promise<SupportTriageHealth> => {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [enabled, worker, retention, reportsToday, failedRunsToday, anySuggestion, retentionSuccess, workerSuccess, counted] =
    await Promise.all([
      resolveSupportTriageEnabled(env),
      lastFinished("worker"),
      lastFinished("retention"),
      prisma.supportTriageSuggestion.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.supportTriageRun.count({
        where: { createdAt: { gte: startOfDay }, outcome: { notIn: ["running", "success"] } },
      }),
      prisma.supportTriageSuggestion.findFirst({ select: { id: true } }),
      lastSuccessAt("retention"),
      lastSuccessAt("worker"),
      // A run that ended in an exception records no overdue counters; the
      // progress conditions read the newest run that did.
      prisma.supportTriageRun.findFirst({
        where: {
          kind: "retention",
          finishedAt: { not: null },
          batchesCompleted: { not: null },
          overdueRemaining: { not: null },
          oldestOverdueAgeSeconds: { not: null },
        },
        orderBy: { finishedAt: "desc" },
        select: { finishedAt: true, batchesCompleted: true, overdueRemaining: true, oldestOverdueAgeSeconds: true },
      }),
    ]);
  const judged = enabled.enabled || anySuggestion !== null;
  const stale =
    judged &&
    supportTriageHeartbeatStale({
      now,
      enabled: enabled.enabled,
      retention: {
        latestSuccessAt: retentionSuccess,
        latestFinished:
          counted?.finishedAt != null &&
          counted.batchesCompleted !== null &&
          counted.overdueRemaining !== null &&
          counted.oldestOverdueAgeSeconds !== null
            ? {
                finishedAt: counted.finishedAt,
                batchesCompleted: counted.batchesCompleted,
                overdueRemaining: counted.overdueRemaining,
                oldestOverdueAgeSeconds: counted.oldestOverdueAgeSeconds,
              }
            : null,
      },
      workerLatestSuccessAt: workerSuccess,
    });
  return { worker, retention, reportsToday, failedRunsToday, stale };
};
