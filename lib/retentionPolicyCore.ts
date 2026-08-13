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
