import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  SCHEDULED_JOB_DEFINITIONS,
  evaluateScheduledJobTiming,
  nextScheduledAt,
  type ScheduledJobKey,
} from "@/lib/scheduledJobsCore";

// SCHED-DRIFT-001. The catalogue and every timing rule derived from it now live
// in lib/scheduledJobsCore.ts, which has no Prisma and no "server-only" import
// so a fixed-clock unit test can reach them. Re-exported here because every
// existing caller imports them from this module.
export {
  SCHEDULED_JOB_DEFINITIONS,
  silenceBudgetMsFor,
  nextScheduledAt,
} from "@/lib/scheduledJobsCore";
export type { ScheduledJobKey } from "@/lib/scheduledJobsCore";

const serializeError = (error: unknown) =>
  error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 4_000)
    : String(error).slice(0, 4_000);

export async function startScheduledJob(jobKey: ScheduledJobKey) {
  try {
    return await prisma.scheduledJobRun.create({
      data: { jobKey, status: "running" },
      select: { id: true },
    });
  } catch (error) {
    console.error(`Scheduled job start logging failed (${jobKey}):`, error);
    return null;
  }
}

export async function completeScheduledJob(input: {
  runId: string | null | undefined;
  processedCount?: number;
  result?: Prisma.InputJsonValue;
}) {
  if (!input.runId) return;
  try {
    await prisma.scheduledJobRun.update({
      where: { id: input.runId },
      data: {
        status: "succeeded",
        completedAt: new Date(),
        processedCount: input.processedCount,
        result: input.result,
        error: null,
      },
    });
  } catch (error) {
    console.error("Scheduled job success logging failed:", error);
  }
}

export async function failScheduledJob(input: {
  runId: string | null | undefined;
  error: unknown;
  /**
   * What the run managed to do before, or despite, failing.
   *
   * A job whose steps run in isolation fails with most of its work done, and
   * an operator reading only the error string cannot tell that from a job that
   * failed on its first line.
   */
  result?: Prisma.InputJsonValue;
  processedCount?: number;
}) {
  if (!input.runId) return;
  try {
    await prisma.scheduledJobRun.update({
      where: { id: input.runId },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: serializeError(input.error),
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.processedCount === undefined
          ? {}
          : { processedCount: input.processedCount }),
      },
    });
  } catch (error) {
    console.error("Scheduled job failure logging failed:", error);
  }
}

export const AUTO_FIX_ELIGIBLE_JOB_KEYS = [
  "provider_model_catalog_monitor",
  "provider_usage_sync",
] as const satisfies readonly ScheduledJobKey[];

export type AutoFixEligibleJobKey = (typeof AUTO_FIX_ELIGIBLE_JOB_KEYS)[number];

export type AutoFixOutcome = "fixed_and_merged" | "needs_human" | "no_action_needed";

/**
 * Claims failed runs of the auto-fix-eligible jobs by stamping autoFixAttemptedAt,
 * so a concurrent or retried poll never hands the same run to two workflow runs.
 */
export async function claimPendingAutoFixRuns(limit = 5) {
  const candidates = await prisma.scheduledJobRun.findMany({
    where: {
      jobKey: { in: [...AUTO_FIX_ELIGIBLE_JOB_KEYS] },
      status: "failed",
      autoFixAttemptedAt: null,
    },
    orderBy: { startedAt: "asc" },
    take: limit,
  });
  if (!candidates.length) return [];

  const claimedAt = new Date();
  await prisma.scheduledJobRun.updateMany({
    where: { id: { in: candidates.map((run) => run.id) }, autoFixAttemptedAt: null },
    data: { autoFixAttemptedAt: claimedAt },
  });

  return prisma.scheduledJobRun.findMany({
    where: { id: { in: candidates.map((run) => run.id) }, autoFixAttemptedAt: claimedAt },
    orderBy: { startedAt: "asc" },
  });
}

export async function recordAutoFixResult(input: {
  runId: string;
  outcome: AutoFixOutcome;
  detail?: string;
}) {
  await prisma.scheduledJobRun.update({
    where: { id: input.runId },
    data: {
      result: {
        autoFix: {
          outcome: input.outcome,
          detail: input.detail?.slice(0, 2_000) || null,
          at: new Date().toISOString(),
        },
      },
    },
  });
}

/** The columns the dashboard reads from a run, and nothing else. */
const DASHBOARD_RUN_SELECT = {
  status: true,
  startedAt: true,
  completedAt: true,
  processedCount: true,
  error: true,
} as const;

/**
 * One job's latest run, latest success, latest failure, and the failures since
 * that success -- each read for that job alone.
 *
 * This used to be one shared read of the newest 150 rows across every job,
 * with each job's rows picked out of it afterwards. The every-15-minute jobs
 * and the 10-minute probe write most of those rows, so the window held only a
 * few hours, and a daily job's run -- `retention_cleanup` at 03:00, the two
 * provider jobs around midnight -- fell out of it the same morning. The job
 * had run and recorded it; the dashboard simply no longer read that far back,
 * reported `lastRunAt: null`, took the silence as infinite and showed a
 * healthy daily job as `delayed` / "not run" on the Jobs screen, in the admin
 * header's delayed count and in the work queue. It was a display error, never
 * a missed execution.
 *
 * Every lookup here is bounded by `jobKey`, so no job's history can be pushed
 * out by another's, and each is served by an existing index
 * (`[jobKey, startedAt]`, `[jobKey, status, startedAt]`).
 *
 * Semantics are unchanged from the windowed version, only no longer truncated:
 * "latest" is by `startedAt`, a `running` row neither counts as a failure nor
 * ends the streak, and the streak is every failure newer than the latest
 * success (all of them, for a job that has never succeeded).
 */
async function readJobRunSummary(jobKey: ScheduledJobKey) {
  const newest = { startedAt: "desc" } as const;
  const [lastRun, lastSuccess, lastFailure] = await Promise.all([
    prisma.scheduledJobRun.findFirst({
      where: { jobKey },
      orderBy: newest,
      select: DASHBOARD_RUN_SELECT,
    }),
    prisma.scheduledJobRun.findFirst({
      where: { jobKey, status: "succeeded" },
      orderBy: newest,
      select: DASHBOARD_RUN_SELECT,
    }),
    prisma.scheduledJobRun.findFirst({
      where: { jobKey, status: "failed" },
      orderBy: newest,
      select: DASHBOARD_RUN_SELECT,
    }),
  ]);
  const consecutiveFailures =
    lastFailure &&
    (!lastSuccess || lastFailure.startedAt > lastSuccess.startedAt)
      ? await prisma.scheduledJobRun.count({
          where: {
            jobKey,
            status: "failed",
            ...(lastSuccess ? { startedAt: { gt: lastSuccess.startedAt } } : {}),
          },
        })
      : 0;
  return { lastRun, lastSuccess, lastFailure, consecutiveFailures };
}

export async function getScheduledJobsDashboard(now = new Date()) {
  const summaries = await Promise.all(
    SCHEDULED_JOB_DEFINITIONS.map((definition) => readJobRunSummary(definition.key))
  );

  return SCHEDULED_JOB_DEFINITIONS.map((definition, index) => {
    const { lastRun, lastSuccess, lastFailure, consecutiveFailures } = summaries[index];
    const { delayed, stuck } = evaluateScheduledJobTiming({
      now,
      maximumSilenceMs: definition.maximumSilenceMs,
      lastRunStartedAt: lastRun?.startedAt ?? null,
      lastRunStatus: lastRun?.status ?? null,
    });
    return {
      key: definition.key,
      name: definition.name,
      schedule: definition.schedule,
      status: stuck ? "stuck" : delayed ? "delayed" : lastRun?.status || "not_run",
      delayed,
      nextScheduledAt: nextScheduledAt(definition.key, now).toISOString(),
      lastRunAt: lastRun?.startedAt.toISOString() || null,
      lastSuccessAt: lastSuccess?.completedAt?.toISOString() || null,
      lastFailureAt: lastFailure?.completedAt?.toISOString() || null,
      lastError: lastFailure?.error || null,
      lastProcessedCount: lastRun?.processedCount ?? null,
      consecutiveFailures,
    };
  });
}
