import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const SCHEDULED_JOB_DEFINITIONS = [
  {
    key: "credit_reservation_reconciliation",
    name: "Credit reservation reconciliation",
    schedule: "Every 5 minutes",
    maximumSilenceMs: 12 * 60 * 1_000,
  },
  {
    key: "retention_cleanup",
    name: "Retention cleanup",
    schedule: "Daily at 03:00 UTC",
    maximumSilenceMs: 26 * 60 * 60 * 1_000,
  },
  {
    key: "provider_model_catalog_monitor",
    name: "Provider model lifecycle and discovery monitor",
    schedule: "Daily at 00:00 UTC (10:00 Australia/Brisbane)",
    maximumSilenceMs: 26 * 60 * 60 * 1_000,
  },
  {
    key: "provider_usage_sync",
    name: "Provider usage and infrastructure report",
    schedule: "Daily at 00:30 UTC",
    maximumSilenceMs: 26 * 60 * 60 * 1_000,
  },
  {
    key: "infrastructure_threshold_monitor",
    name: "Infrastructure threshold monitor",
    schedule: "Every 15 minutes via credit reconciliation cron",
    maximumSilenceMs: 35 * 60 * 1_000,
  },
] as const;

export type ScheduledJobKey = (typeof SCHEDULED_JOB_DEFINITIONS)[number]["key"];

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
}) {
  if (!input.runId) return;
  try {
    await prisma.scheduledJobRun.update({
      where: { id: input.runId },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: serializeError(input.error),
      },
    });
  } catch (error) {
    console.error("Scheduled job failure logging failed:", error);
  }
}

const nextFiveMinuteBoundary = (now: Date) => {
  const result = new Date(now);
  result.setUTCSeconds(0, 0);
  result.setUTCMinutes(Math.floor(result.getUTCMinutes() / 5) * 5 + 5);
  return result;
};

const nextDailyUtc = (now: Date, hour: number, minute: number) => {
  const result = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute)
  );
  if (result <= now) result.setUTCDate(result.getUTCDate() + 1);
  return result;
};

const nextScheduledAt = (key: ScheduledJobKey, now: Date) => {
  if (key === "credit_reservation_reconciliation") {
    return nextFiveMinuteBoundary(now);
  }
  if (key === "infrastructure_threshold_monitor") {
    const result = new Date(now);
    result.setUTCSeconds(0, 0);
    result.setUTCMinutes(Math.floor(result.getUTCMinutes() / 15) * 15 + 15);
    return result;
  }
  return key === "retention_cleanup"
    ? nextDailyUtc(now, 3, 0)
    : key === "provider_model_catalog_monitor"
      ? nextDailyUtc(now, 0, 0)
      : nextDailyUtc(now, 0, 30);
};

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
    const delayed =
      !lastRun || now.getTime() - lastRun.startedAt.getTime() > definition.maximumSilenceMs;
    const stuck =
      lastRun?.status === "running" &&
      now.getTime() - lastRun.startedAt.getTime() > definition.maximumSilenceMs;
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
