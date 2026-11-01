import "server-only";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Whether the comment monitor is switched on and has recently worked (policy
 * 12.1: no graduation without it, and the autonomous admission asks the same
 * question).
 *
 * **The switch is an environment variable and it is off.** Comment monitoring
 * reads what the public wrote under our posts, which needs a lawful basis, a
 * privacy assessment, the posting tool's data-processing terms and a revised
 * privacy notice first (policy 12.1). Until a person has done those and set
 * `MARKETING_COMMENTS_MONITOR_ENABLED=true` on the service that runs the
 * monitor, nothing here reads a comment and nothing calls the posting tool.
 *
 * The health is a timestamp the monitor writes when a whole run finished with
 * every read answered, kept as an app setting so the autonomous admission can
 * read it in the statement that reads its other settings.
 */
export const MARKETING_COMMENTS_MONITOR_ENV = "MARKETING_COMMENTS_MONITOR_ENABLED";
export const MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY = "marketing_comments_monitor_last_run";
/** Working while the latest finished run is younger than this (the monitor runs hourly). */
export const MARKETING_COMMENTS_MONITOR_HEALTHY_WINDOW_MS = 3 * 60 * 60 * 1000;

export const commentsMonitorEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  (env[MARKETING_COMMENTS_MONITOR_ENV] ?? "").trim().toLowerCase() === "true";

/** The pure judgement, shared by the console, the graduation and the admission. */
export const commentsMonitorHealthyFromValue = (
  lastRunValue: string | undefined,
  now: Date,
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  if (!commentsMonitorEnabled(env) || lastRunValue === undefined) return false;
  const lastRun = new Date(lastRunValue);
  const age = now.getTime() - lastRun.getTime();
  return Number.isFinite(age) && age >= 0 && age <= MARKETING_COMMENTS_MONITOR_HEALTHY_WINDOW_MS;
};

export async function readMarketingCommentsMonitorHealthy(
  client: Pick<PrismaClient, "appSetting"> = prisma,
  now: Date = new Date(),
): Promise<boolean> {
  if (!commentsMonitorEnabled(process.env)) return false;
  const row = await client.appSetting.findUnique({
    where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY },
    select: { value: true },
  });
  return commentsMonitorHealthyFromValue(row?.value, now, process.env);
}

/** The start of the latest run that read and classified everything, or null. */
export async function readMarketingCommentsMonitorLastRun(
  client: Pick<PrismaClient, "appSetting"> = prisma,
): Promise<Date | null> {
  const row = await client.appSetting.findUnique({
    where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY },
    select: { value: true },
  });
  const at = row ? new Date(row.value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/** A whole run finished with every read answered; `at` is when that run began. */
export async function recordMarketingCommentsMonitorRun(
  client: Pick<PrismaClient, "appSetting">,
  at: Date,
): Promise<void> {
  await client.appSetting.upsert({
    where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY },
    create: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY, value: at.toISOString() },
    update: { value: at.toISOString() },
  });
}
