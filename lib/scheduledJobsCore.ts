// The scheduled-job catalogue and every timing rule derived from it.
//
// Dependency-free on purpose (no Prisma, no "server-only"), following
// lib/providerRecoveryCore.ts: the cadence a job is *declared* to run at, the
// silence budget that turns quiet into "delayed", and the next-run estimate are
// all decisions that must be unit-testable with a fixed clock. Leaving them
// inside the Prisma-backed dashboard is what let the credit-reconciliation
// entry drift out of step with its own cron without a single test noticing.
//
// SCHED-DRIFT-001. The drift itself: `railway.credit-reconciliation.json` moved
// from `*/5 * * * *` to `*/15 * * * *` (commit 906c743) and this catalogue was
// not moved with it. The job kept a 12-minute silence budget against a
// 15-minute cadence, so a perfectly healthy reconciliation was reported
// `delayed` for the last ~3 minutes of every cycle -- roughly 20% of the time,
// permanently -- on the admin Jobs screen, in the admin header's delayed count
// and in /api/admin/scheduled-jobs. Nothing was wrong with the job; the monitor
// was measuring it against a cadence it no longer ran at, which is the kind of
// standing false alarm that teaches an operator to ignore the real one.
//
// (The public /status page reads this dashboard too, but selects only
// `provider_probe`, so it never showed the false state.)
//
// `CRON_CADENCE_MINUTES` below is the single place a cron-driven job's cadence
// is written down, and tests/scheduledJobsCore.test.mjs asserts it against the
// Railway config files themselves, so the two cannot drift apart again without
// a red test.

/** Cadence, in minutes, of each Railway cron service that drives a job here. */
export const CRON_CADENCE_MINUTES = {
  /** railway.credit-reconciliation.json */
  creditReconciliation: 15,
  /** railway.provider-probe.json */
  providerProbe: 10,
} as const;

/**
 * How much longer than one full cadence a job may stay quiet before the
 * dashboard calls it delayed.
 *
 * A budget below the cadence reports every healthy cycle as late, which is the
 * SCHED-DRIFT-001 defect. A budget of exactly one cadence is still too tight:
 * a run that starts a few seconds late, or a sweep that takes a minute, would
 * trip it. One cadence plus this much slack is the smallest budget that only
 * fires when a run has genuinely been skipped.
 */
export const SILENCE_SLACK_MINUTES = 20;

const minutes = (value: number) => value * 60 * 1_000;

/**
 * The silence budget for a job driven by a cron of the given cadence: long
 * enough to survive one late run, short enough to notice a skipped one.
 */
export const silenceBudgetMsFor = (cadenceMinutes: number) =>
  minutes(cadenceMinutes + SILENCE_SLACK_MINUTES);

export const SCHEDULED_JOB_DEFINITIONS = [
  {
    key: "credit_reservation_reconciliation",
    name: "Credit reservation reconciliation",
    schedule: "Every 15 minutes",
    maximumSilenceMs: silenceBudgetMsFor(CRON_CADENCE_MINUTES.creditReconciliation),
  },
  {
    key: "retention_cleanup",
    name: "Retention cleanup",
    schedule: "Daily at 03:00 UTC",
    maximumSilenceMs: minutes(26 * 60),
  },
  {
    key: "provider_model_catalog_monitor",
    name: "Provider model lifecycle and discovery monitor",
    schedule: "Daily at 00:00 UTC (10:00 Australia/Brisbane)",
    maximumSilenceMs: minutes(26 * 60),
  },
  {
    key: "provider_usage_sync",
    name: "Provider usage and infrastructure report",
    schedule: "Daily at 00:30 UTC",
    maximumSilenceMs: minutes(26 * 60),
  },
  {
    key: "notification_delivery_retry",
    name: "Operator notification delivery retry",
    // Drained from the credit reconciliation cron as well as its own endpoint,
    // so the queue keeps moving without a second schedule having to exist --
    // which also means it inherits that cron's cadence, not one of its own.
    schedule: "Every 15 minutes via credit reconciliation cron",
    maximumSilenceMs: silenceBudgetMsFor(CRON_CADENCE_MINUTES.creditReconciliation),
  },
  {
    key: "infrastructure_threshold_monitor",
    name: "Infrastructure threshold monitor",
    schedule: "Every 15 minutes via credit reconciliation cron",
    maximumSilenceMs: silenceBudgetMsFor(CRON_CADENCE_MINUTES.creditReconciliation),
  },
  {
    key: "provider_probe",
    name: "Synthetic provider health probe (AUD-R001)",
    schedule: "Every 10 minutes",
    // Deliberately not `silenceBudgetMsFor` -- this is the one job with a
    // tighter constraint than the shared slack. Cadence is 10 minutes, but the
    // public status page's freshness window (see
    // PROVIDER_PUBLIC_STATUS_FRESHNESS_MINUTES) is 30 minutes, so the budget
    // must stay well under that or "monitoring delayed" and "provider stale"
    // would trip at nearly the same time and be indistinguishable. 10 + 20
    // would be 30 and collide exactly.
    maximumSilenceMs: minutes(25),
  },
] as const;

export type ScheduledJobKey = (typeof SCHEDULED_JOB_DEFINITIONS)[number]["key"];

const nextBoundary = (now: Date, everyMinutes: number) => {
  const result = new Date(now);
  result.setUTCSeconds(0, 0);
  result.setUTCMinutes(
    Math.floor(result.getUTCMinutes() / everyMinutes) * everyMinutes + everyMinutes
  );
  return result;
};

const nextDailyUtc = (now: Date, hour: number, minute: number) => {
  const result = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute)
  );
  if (result <= now) result.setUTCDate(result.getUTCDate() + 1);
  return result;
};

/**
 * When this job is next expected to run. Every cron-driven entry derives its
 * boundary from `CRON_CADENCE_MINUTES` rather than a literal, so a cadence
 * change moves the estimate and the silence budget together.
 */
export const nextScheduledAt = (key: ScheduledJobKey, now: Date) => {
  if (
    key === "credit_reservation_reconciliation" ||
    key === "notification_delivery_retry" ||
    key === "infrastructure_threshold_monitor"
  ) {
    return nextBoundary(now, CRON_CADENCE_MINUTES.creditReconciliation);
  }
  if (key === "provider_probe") {
    return nextBoundary(now, CRON_CADENCE_MINUTES.providerProbe);
  }
  return key === "retention_cleanup"
    ? nextDailyUtc(now, 3, 0)
    : key === "provider_model_catalog_monitor"
      ? nextDailyUtc(now, 0, 0)
      : nextDailyUtc(now, 0, 30);
};

export type ScheduledJobTimingInput = {
  now: Date;
  maximumSilenceMs: number;
  lastRunStartedAt: Date | null;
  lastRunStatus: string | null;
};

/**
 * Whether a job has been quiet longer than its budget, and whether the run it
 * is quiet in the middle of has hung. A job with no recorded run at all counts
 * as delayed -- "never ran" is not "on time".
 */
export const evaluateScheduledJobTiming = ({
  now,
  maximumSilenceMs,
  lastRunStartedAt,
  lastRunStatus,
}: ScheduledJobTimingInput) => {
  const silentMs = lastRunStartedAt
    ? now.getTime() - lastRunStartedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const delayed = silentMs > maximumSilenceMs;
  const stuck = lastRunStatus === "running" && silentMs > maximumSilenceMs;
  return { delayed, stuck, silentMs };
};
