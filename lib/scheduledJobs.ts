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

export async function getScheduledJobsDashboard(now = new Date()) {
  const recentRuns = await prisma.scheduledJobRun.findMany({
    where: {
      jobKey: { in: SCHEDULED_JOB_DEFINITIONS.map((job) => job.key) },
    },
    orderBy: { startedAt: "desc" },
    take: 150,
  });

  return SCHEDULED_JOB_DEFINITIONS.map((definition) => {
    const runs = recentRuns.filter((run) => run.jobKey === definition.key);
    const lastRun = runs[0] || null;
    const lastSuccess = runs.find((run) => run.status === "succeeded") || null;
    const lastFailure = runs.find((run) => run.status === "failed") || null;
    let consecutiveFailures = 0;
    for (const run of runs) {
      if (run.status === "failed") consecutiveFailures += 1;
      else if (run.status === "succeeded") break;
    }
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
