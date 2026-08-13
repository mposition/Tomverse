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
// `CRON_TRIGGERS` below is the single place a job's schedule is written down,
// and tests/scheduledJobsCore.test.mjs asserts every entry against the Railway
// config file it names, so the two cannot drift apart again without a red test.
//
// SCHED-DRIFT-002, found while widening that assertion: the fix above covered
// the two every-N-minutes crons and left the three daily ones exactly as they
// were. Each of those wrote its time out three times -- in the prose an
// operator reads, in the next-run estimate, and in the cron file that actually
// runs it -- with nothing comparing them. `railway.maintenance.json` moving off
// 03:00 would have shown the old hour on the admin Jobs screen and estimated
// the next run against it, silently and indefinitely, which is the same defect
// SCHED-DRIFT-001 was. Nothing had drifted yet; the gap that let it was still
// open.

/** What a cron expression means, once parsed. */
export type CronTrigger =
  | { readonly kind: "everyMinutes"; readonly minutes: number }
  | { readonly kind: "dailyUtc"; readonly hour: number; readonly minute: number };

/**
 * Every Railway cron service that drives a job here, with the schedule it is
 * deployed with. `configFile` is what makes the claim checkable: the test reads
 * that file and parses its `cronSchedule` rather than trusting this table.
 */
export const CRON_TRIGGERS = {
  creditReconciliation: {
    configFile: "railway.credit-reconciliation.json",
    trigger: { kind: "everyMinutes", minutes: 15 },
  },
  providerProbe: {
    configFile: "railway.provider-probe.json",
    trigger: { kind: "everyMinutes", minutes: 10 },
  },
  maintenance: {
    configFile: "railway.maintenance.json",
    trigger: { kind: "dailyUtc", hour: 3, minute: 0 },
  },
  providerModelCatalog: {
    configFile: "railway.provider-model-catalog.json",
    trigger: { kind: "dailyUtc", hour: 0, minute: 0 },
  },
  providerUsageSync: {
    configFile: "railway.provider-usage-sync.json",
    trigger: { kind: "dailyUtc", hour: 0, minute: 30 },
  },
} as const satisfies Record<
  string,
  { configFile: string; trigger: CronTrigger }
>;

export type CronTriggerKey = keyof typeof CRON_TRIGGERS;

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The cron expression an operator would read, in the words the admin Jobs
 * screen uses. Derived rather than typed out beside the numbers, because a
 * schedule written twice is a schedule that can disagree with itself.
 */
export const describeCronTrigger = (trigger: CronTrigger) =>
  trigger.kind === "everyMinutes"
    ? `Every ${trigger.minutes} minutes`
    : `Daily at ${pad(trigger.hour)}:${pad(trigger.minute)} UTC`;

/** How long one full cycle of this trigger is. */
export const cronTriggerIntervalMs = (trigger: CronTrigger) =>
  trigger.kind === "everyMinutes"
    ? trigger.minutes * 60 * 1_000
    : 24 * 60 * 60 * 1_000;

/**
 * The two cron shapes this repository deploys, and nothing else. An expression
 * it cannot read returns `null` rather than a guess: the test that calls this
 * treats that as a failure, so a new shape has to be taught here instead of
 * quietly falling out of the comparison.
 */
export const parseCronSchedule = (expression: string): CronTrigger | null => {
  const cron = expression.trim();
  const everyMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (everyMinutes) {
    return { kind: "everyMinutes", minutes: Number(everyMinutes[1]) };
  }
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (daily) {
    return {
      kind: "dailyUtc",
      hour: Number(daily[2]),
      minute: Number(daily[1]),
    };
  }
  return null;
};

/**
 * Cadence in minutes of an every-N-minutes cron, for the silence budgets below.
 * Throws on a daily trigger rather than inventing a number for it: a budget
 * derived from the wrong shape of schedule is the failure this file exists for.
 */
const everyMinutesCadence = (cron: CronTriggerKey) => {
  const { trigger } = CRON_TRIGGERS[cron];
  if (trigger.kind !== "everyMinutes") {
    throw new Error(`${cron} is not an every-N-minutes cron`);
  }
  return trigger.minutes;
};

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

/**
 * The schedule sentence shown beside a job, built from the trigger it actually
 * runs on plus whatever the operator additionally needs to know. The note is
 * the only part written by hand, and it never states a time.
 */
const scheduleSentence = (cron: CronTriggerKey, note?: string) => {
  const described = describeCronTrigger(CRON_TRIGGERS[cron].trigger);
  return note ? `${described} ${note}` : described;
};

export const SCHEDULED_JOB_DEFINITIONS = [
  {
    key: "credit_reservation_reconciliation",
    name: "Credit reservation reconciliation",
    cron: "creditReconciliation",
    schedule: scheduleSentence("creditReconciliation"),
    maximumSilenceMs: silenceBudgetMsFor(everyMinutesCadence("creditReconciliation")),
  },
  {
    key: "retention_cleanup",
    name: "Retention cleanup",
    cron: "maintenance",
    schedule: scheduleSentence("maintenance"),
    maximumSilenceMs: minutes(26 * 60),
  },
  {
    key: "provider_model_catalog_monitor",
    name: "Provider model lifecycle and discovery monitor",
    cron: "providerModelCatalog",
    // The local time is what the operator who reads this actually works in;
    // it is a restatement of the UTC time beside it, not a second schedule.
    schedule: scheduleSentence("providerModelCatalog", "(10:00 Australia/Brisbane)"),
    maximumSilenceMs: minutes(26 * 60),
  },
  {
    key: "provider_usage_sync",
    name: "Provider usage and infrastructure report",
    cron: "providerUsageSync",
    schedule: scheduleSentence("providerUsageSync"),
    maximumSilenceMs: minutes(26 * 60),
  },
  {
    key: "notification_delivery_retry",
    name: "Operator notification delivery retry",
    // Drained from the credit reconciliation cron as well as its own endpoint,
    // so the queue keeps moving without a second schedule having to exist --
    // which also means it inherits that cron's cadence, not one of its own.
    cron: "creditReconciliation",
    schedule: scheduleSentence("creditReconciliation", "via credit reconciliation cron"),
    maximumSilenceMs: silenceBudgetMsFor(everyMinutesCadence("creditReconciliation")),
  },
  {
    key: "infrastructure_threshold_monitor",
    name: "Infrastructure threshold monitor",
    cron: "creditReconciliation",
    schedule: scheduleSentence("creditReconciliation", "via credit reconciliation cron"),
    maximumSilenceMs: silenceBudgetMsFor(everyMinutesCadence("creditReconciliation")),
  },
  {
    key: "provider_probe",
    name: "Synthetic provider health probe (AUD-R001)",
    cron: "providerProbe",
    schedule: scheduleSentence("providerProbe"),
    // Deliberately not `silenceBudgetMsFor` -- this is the one job with a
    // tighter constraint than the shared slack. Cadence is 10 minutes, but the
    // public status page's freshness window (see
    // PROVIDER_PUBLIC_STATUS_FRESHNESS_MINUTES) is 30 minutes, so the budget
    // must stay well under that or "monitoring delayed" and "provider stale"
    // would trip at nearly the same time and be indistinguishable. 10 + 20
    // would be 30 and collide exactly.
    maximumSilenceMs: minutes(25),
  },
] as const satisfies readonly {
  key: string;
  name: string;
  cron: CronTriggerKey;
  schedule: string;
  maximumSilenceMs: number;
}[];

export type ScheduledJobKey = (typeof SCHEDULED_JOB_DEFINITIONS)[number]["key"];

export const scheduledJobDefinition = (key: ScheduledJobKey) => {
  const definition = SCHEDULED_JOB_DEFINITIONS.find((job) => job.key === key);
  if (!definition) throw new Error(`Unknown scheduled job: ${key}`);
  return definition;
};

/** The trigger a job runs on, whether it owns that cron or rides another's. */
export const cronTriggerFor = (key: ScheduledJobKey) =>
  CRON_TRIGGERS[scheduledJobDefinition(key).cron].trigger;

/**
 * The first moment this trigger fires strictly after `now`. On a boundary the
 * answer is the next one: an estimate equal to `now` renders as "due now"
 * forever.
 */
export const nextRunAfter = (trigger: CronTrigger, now: Date) => {
  if (trigger.kind === "everyMinutes") {
    const result = new Date(now);
    result.setUTCSeconds(0, 0);
    result.setUTCMinutes(
      Math.floor(result.getUTCMinutes() / trigger.minutes) * trigger.minutes +
        trigger.minutes
    );
    return result;
  }
  const result = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      trigger.hour,
      trigger.minute
    )
  );
  if (result <= now) result.setUTCDate(result.getUTCDate() + 1);
  return result;
};

/**
 * When this job is next expected to run. Every entry derives its boundary from
 * the trigger it declares rather than from a literal, so a schedule change
 * moves the estimate, the displayed sentence and the silence budget together.
 */
export const nextScheduledAt = (key: ScheduledJobKey, now: Date) =>
  nextRunAfter(cronTriggerFor(key), now);

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
