/**
 * The shape of the sidebar's counters, and how each entry derives its badge.
 *
 * Deliberately free of `prisma` and of anything that reaches a database: the
 * sidebar is a client component, and importing the loader's module there pulled
 * `lib/prisma.ts` -- and with it the whole `pg` driver -- into the browser
 * bundle. The loader lives in `lib/adminNavigationCounts.ts`, which is
 * server-only and re-exports these declarations so a caller needs one import.
 */

export type AdminNavigationCounts = {
  openFeedback: number | null;
  openPrivacyRequests: number | null;
  pendingRefunds: number | null;
  pendingApprovals: number | null;
  activeIncidents: number | null;
  failedWebhooks: number | null;
  delayedJobs: number | null;
  failedAlerts: number | null;
};

export const EMPTY_ADMIN_NAVIGATION_COUNTS: AdminNavigationCounts = {
  openFeedback: null,
  openPrivacyRequests: null,
  pendingRefunds: null,
  pendingApprovals: null,
  activeIncidents: null,
  failedWebhooks: null,
  delayedJobs: null,
  failedAlerts: null,
};

/**
 * The number the sidebar shows beside an entry, or `null` for no badge.
 *
 * `null` is not zero: a count that failed to load renders nothing, because
 * "nothing is waiting" is a claim the console has no basis to make when the
 * read did not succeed.
 */
export const adminNavigationBadge = (
  key: string,
  counts: AdminNavigationCounts
): number | null => {
  const sum = (...values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length === 0
      ? null
      : known.reduce((total, value) => total + value, 0);
  };
  switch (key) {
    case "workQueue":
      return sum(
        counts.pendingApprovals,
        counts.pendingRefunds,
        counts.openFeedback,
        counts.openPrivacyRequests
      );
    case "support":
      return sum(counts.openFeedback, counts.openPrivacyRequests);
    case "refunds":
      return counts.pendingRefunds;
    case "providers":
      return counts.activeIncidents;
    case "automation":
      return sum(counts.delayedJobs, counts.failedWebhooks);
    case "alerts":
      return counts.failedAlerts;
    default:
      return null;
  }
};
