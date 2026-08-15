/**
 * The retention policies the Admin Console publishes, and the maintenance step
 * that enforces each one.
 *
 * The two were written separately and drifted. `/admin/retention` listed nine
 * policies in hand-typed prose with a count of rows past each cutoff;
 * `cleanupExpiredData()` implemented seven of them. Alert delivery logs
 * ("delete older than 90 days") and provider check records ("delete older than
 * 30 days") were deleted by nothing at all. An operator read a policy, watched
 * the count climb, typed RUN CLEANUP, and the number did not move -- and a
 * retention policy is the kind of statement that ends up in an answer to a
 * customer or a regulator, so a published one that nothing performs is worse
 * than an absent one.
 *
 * One list now. The screen renders from it and the sweep enforces it, and
 * tests/retentionPolicy.test.mjs refuses a policy whose `maintenanceStep` is
 * not a step `lib/maintenance.ts` actually runs.
 *
 * Pure on purpose (no Prisma, no "server-only"): the counting query, the
 * deleting query and the sentence describing both have to be able to quote the
 * same number.
 */

export type RetentionAction =
    /** Rows are removed. */
    | "delete"
    /** Rows survive; named columns are emptied. */
    | "clear"
    /** A separate settlement path acts on them; no row is removed here. */
    | "refund"
    /** Deliberately not removed. The window is a floor, not a deadline. */
    | "keep";

export type RetentionPolicy = {
    key: string;
    label: string;
    /** The sentence an operator reads. Written once, here. */
    policy: string;
    action: RetentionAction;
    /**
     * The window the *count* on the screen uses. `null` where a row's own
     * expiry decides, rather than an age.
     */
    windowDays: number | null;
    /**
     * The `step("...")` name in `lib/maintenance.ts` that performs it, or null
     * for a `keep` policy. Every other action must name one, and the name must
     * exist.
     */
    maintenanceStep: string | null;
};

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
    {
        key: "usageBuckets",
        label: "Usage buckets",
        // The sweep is per period, not a flat age: minute and lock buckets go
        // after a day, day buckets at the next day boundary, month buckets
        // after 120 days. The count below uses the longest of those, so it
        // reports what is genuinely overdue rather than rows the next sweep
        // was always going to take.
        policy:
            "Delete usage buckets once their period has closed; monthly buckets after 120 days.",
        action: "delete",
        windowDays: 120,
        maintenanceStep: "usage_buckets",
    },
    {
        key: "requestLeases",
        label: "Request leases",
        policy: "Delete request leases once they expire.",
        action: "delete",
        windowDays: null,
        maintenanceStep: "request_leases",
    },
    {
        key: "creditReservations",
        label: "Expired credit reservations",
        policy:
            "Refund expired reserved credits on the next fifteen-minute reconciliation sweep.",
        action: "refund",
        windowDays: null,
        maintenanceStep: "chat_credit_reservations",
    },
    {
        key: "shareSnapshots",
        label: "Share snapshots",
        policy: "Clear expired or revoked share snapshots.",
        action: "clear",
        windowDays: null,
        maintenanceStep: "share_snapshots",
    },
    {
        key: "auditLogs",
        label: "Audit logs",
        // A floor, and the only entry here that is. The hash chain is what
        // makes the log tamper-evident, so removing an entry from the middle
        // of it would break every later link.
        policy:
            "Keep admin audit logs for at least 365 days. Nothing deletes them; the count is how much history exists beyond the floor.",
        action: "keep",
        windowDays: 365,
        maintenanceStep: null,
    },
    {
        key: "notificationLogs",
        label: "Notification logs",
        policy:
            "Delete alert delivery logs older than 90 days, except failed deliveries nobody has acknowledged.",
        action: "delete",
        windowDays: 90,
        maintenanceStep: "notification_logs",
    },
    {
        key: "deepResearchJobs",
        label: "Deep research jobs",
        // Measured from `updatedAt`, which moves on every poll and on
        // finalization. That is one clock for two row shapes: a job that
        // finished, and a job nobody ever polled again because the user closed
        // the tab -- the second never reaches a terminal status, has no
        // `completedAt`, and is the one that actually accumulates.
        //
        // 30 days, matching the operational diagnostics beside it, because
        // that is what this row is. Its user-visible half is a *copy*: on
        // completion `resultText` is written into `Message.content` in the same
        // transaction, and the Message is what the product reads and what the
        // user deletes. What the row still buys after that is a poll from a
        // second tab and an operator answering "what happened to this
        // request", and a poll 30 days after the last one is not a poll.
        //
        // The copy is also why this is not measured in months: a duplicate of
        // personal data that nothing reads is the worst kind to keep.
        policy:
            "Delete deep research job records 30 days after their last update.",
        action: "delete",
        windowDays: 30,
        maintenanceStep: "deep_research_jobs",
    },
    {
        key: "emailLoginAttempts",
        label: "Email login attempts",
        // Measured from `expiresAt`, not `createdAt`. The two are ten minutes
        // apart at most (`EMAIL_LOGIN_CODE_TTL_MINUTES`, clamped to 1-10), so
        // the window is the same either way -- but `expiresAt` is the moment
        // the row stops being able to authenticate anyone, which is the fact
        // the policy is about, and it is the indexed column.
        //
        // Seven days, and the reason is not that seven is a round number: the
        // row's authentication value ends at `expiresAt`, and nothing in the
        // product reads the table for history -- every read is `findFirst` for
        // the current attempt. What the week buys is a live support or abuse
        // question ("did someone request a code for my address?"), and a
        // longer window would be keeping raw email addresses and credential
        // hashes for an investigation nobody performs. That is the same
        // forever-by-default this list exists to refuse, only shorter.
        //
        // Consumed and invalidated rows are covered too: a consumed row is
        // already spent and an invalidated one was superseded, so neither has
        // a life beyond the unconsumed row's.
        policy:
            "Delete email login attempts more than 7 days after they expired.",
        action: "delete",
        windowDays: 7,
        maintenanceStep: "email_login_attempts",
    },
    {
        key: "providerChecks",
        label: "Provider checks",
        policy: "Delete provider check records older than 30 days.",
        action: "delete",
        windowDays: 30,
        maintenanceStep: "provider_health_checks",
    },
    {
        key: "providerErrors",
        label: "Provider error events",
        policy: "Delete sanitized provider error diagnostics older than 30 days.",
        action: "delete",
        windowDays: 30,
        maintenanceStep: "provider_error_events",
    },
    {
        key: "productAnalytics",
        label: "Product analytics events",
        policy:
            "Delete consented, pseudonymous product events older than 400 days.",
        action: "delete",
        windowDays: 400,
        maintenanceStep: "product_analytics_events",
    },
    // The three below were not published and not swept. They are written by
    // cron on a fixed cadence and read newest-first or not at all, so nothing
    // about them was ever going to stop growing -- see
    // `npm run report:unswept-tables`, which is how they were found.
    {
        key: "providerProbeResults",
        label: "Provider probe results",
        // Every ten minutes, one row per probed model. Nothing reads the table:
        // the probe's own failure path logs and updates the provider's health
        // counters, and the comment at the write site says as much. Kept for
        // the same 30 days as the other provider diagnostics so a person can
        // still query it during an incident review.
        policy: "Delete synthetic probe results older than 30 days.",
        action: "delete",
        windowDays: 30,
        maintenanceStep: "provider_probe_results",
    },
    {
        key: "scheduledJobRuns",
        label: "Scheduled job runs",
        // The Jobs screen reads the newest 150 across every job, the auto-fix
        // queue reads unattended failures, and the threshold monitor reads the
        // last cycle. 30 days is far above all three, and an unattended failure
        // that old is not going to be auto-fixed.
        policy: "Delete scheduled job run records older than 30 days.",
        action: "delete",
        windowDays: 30,
        maintenanceStep: "scheduled_job_runs",
    },
    {
        key: "providerModelCatalogRuns",
        label: "Provider catalogue runs",
        // Daily, and read by nothing. Longer than the others because it is one
        // row a day: a year of it is cheaper than the question "when did the
        // catalogue monitor last see this model" being unanswerable.
        policy: "Delete provider catalogue monitor runs older than 365 days.",
        action: "delete",
        windowDays: 365,
        maintenanceStep: "provider_model_catalog_runs",
    },
];

export const retentionPolicy = (key: string) => {
    const policy = RETENTION_POLICIES.find((entry) => entry.key === key);
    if (!policy) throw new Error(`Unknown retention policy: ${key}`);
    return policy;
};

/**
 * The cutoff for a policy with a window. The screen counts rows older than
 * this and the sweep deletes rows older than this, from one definition, so a
 * count that does not fall after a cleanup means the sweep failed rather than
 * that the two disagree about the date.
 */
export const retentionCutoff = (key: string, now: Date = new Date()) => {
    const { windowDays } = retentionPolicy(key);
    if (windowDays === null) {
        throw new Error(`Retention policy ${key} has no age window.`);
    }
    return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
};

/**
 * How long a row may sit past its cutoff before it is late rather than normal.
 *
 * The sweep is a daily cron (`railway.maintenance.json`, 03:00 UTC), so a row
 * crosses its cutoff and then waits up to a day for the run that takes it.
 * That wait is the design working, not a fault, and an alarm that fires on it
 * is on almost all day: `databaseSnapshot()` warned whenever *any* provider
 * error event was past 30 days, which -- with the sweep clearing them at 03:00
 * every morning -- meant it warned about rows that had aged a few hours past
 * the line and would be gone at the next run. A warning that is always on is
 * read as decoration, and the operator stops seeing the day it means something.
 *
 * Two days, not one. One puts the boundary exactly where the sweep runs, so a
 * slow run or a little clock skew flips the alarm on and off around 03:00. Two
 * means two scheduled sweeps have had their chance, which is a fact about the
 * sweep rather than about the clock -- and a sweep that has genuinely stopped
 * still surfaces within a couple of days.
 *
 * This is a monitoring threshold, not a retention promise. `retentionCutoff()`
 * is still the age the policy states and the age the sweep deletes at; nothing
 * here lets a row live longer.
 */
export const RETENTION_SWEEP_GRACE_DAYS = 2;

/**
 * The age past which rows are overdue -- the sweep should already have taken
 * them and did not.
 *
 * Use this to decide whether something is *wrong*. Use `retentionCutoff()` to
 * count what the policy covers or to delete. The two are different questions
 * and the answer to the first is not "greater than zero" of the second.
 */
export const retentionOverdueCutoff = (key: string, now: Date = new Date()) =>
    retentionCutoff(
        key,
        new Date(now.getTime() - RETENTION_SWEEP_GRACE_DAYS * 24 * 60 * 60 * 1000)
    );
