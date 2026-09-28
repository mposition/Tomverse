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
  /**
   * Abandoned legal notices
   * (docs/policy/email-notifications.md §9.5).
   *
   * The only email count that earns a badge. An abandoned legal notice is work
   * -- that document's §9.4 asks for manual follow-up on an alternate channel
   * -- while an abandoned promotion is a promotion nobody missed.
   */
  abandonedLegalEmail: number | null;
  /**
   * Models discovery found that nobody has decided about yet.
   *
   * Earns a badge because it is the count whose absence was the finding: for a
   * month the daily report said "new candidates 0" while seven first-party
   * models sat unreviewed, because the report described the day rather than the
   * backlog.
   */
  openModelLifecycle: number | null;
  /**
   * Campaign waves the scheduler has passed over.
   *
   * A wave stays `pending` when it comes due and is refused, so the row itself
   * records neither the attempt nor the reason -- and nothing else in the
   * console reads `EmailCampaignWave` at all. Without this count an operator
   * learns that an approved send did not happen from the people who never
   * received it.
   */
  overdueCampaignWaves: number | null;
  /**
   * Marketing drafts the Guard sent to a person
   * (docs/policy/marketing-automation.md §6).
   *
   * The Guard's second verdict is "a person decides", and a draft that reaches
   * it waits until someone does. Without this count the queue is a page nobody
   * opens, and the automation's output stays invisible until an approval
   * expires.
   */
  pendingMarketingApprovals: number | null;
  /**
   * Reports that have not closed -- `open` and `reviewing` both, as named by
   * FEEDBACK_AWAITING_OPERATOR_STATUSES. Not `status: "open"`: a
   * verified-trace report arrives as `reviewing`, and counting only `open`
   * made the reports the server had confirmed the ones that never lit this.
   */
  openFeedback: number | null;
  /**
   * The same unclosed reports, minus those whose auto-fix case is itself
   * waiting on an operator (`autoFixActionCases`). For Support, where both are
   * summed, that case *is* the report's work -- approve the fix, reply, close
   * -- and counting the report as well would show one piece of work as two.
   * The work queue lists every unclosed report and no cases, so it keeps
   * `openFeedback`.
   */
  supportFeedback: number | null;
  /** Auto-fix cases waiting on an operator: a PR to approve, a verified fix
   * to reply about, or a stopped promotion (AUTOFIX_OPERATOR_ACTION_STATES). */
  autoFixActionCases: number | null;
  openPrivacyRequests: number | null;
  pendingRefunds: number | null;
  pendingApprovals: number | null;
  activeIncidents: number | null;
  failedWebhooks: number | null;
  delayedJobs: number | null;
  failedAlerts: number | null;
};

export const EMPTY_ADMIN_NAVIGATION_COUNTS: AdminNavigationCounts = {
  abandonedLegalEmail: null,
  openModelLifecycle: null,
  overdueCampaignWaves: null,
  pendingMarketingApprovals: null,
  openFeedback: null,
  supportFeedback: null,
  autoFixActionCases: null,
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
        counts.pendingRefunds,
        counts.openFeedback,
        counts.openPrivacyRequests
      );
    case "support":
      // Distinct work items, made distinct by the count itself: a report whose
      // auto-fix case is waiting on an operator is left out of
      // `supportFeedback`, so the pair counts once. This used to rely on
      // status instead -- "an auto-reviewed report is `reviewing`, not `open`"
      // -- which kept the pair from counting twice by keeping every
      // auto-reviewed report from counting at all, including the ones with no
      // case to stand in for them.
      return sum(
        counts.supportFeedback,
        counts.autoFixActionCases,
        counts.openPrivacyRequests
      );
    case "refunds":
      return counts.pendingRefunds;
    case "providers":
      return counts.activeIncidents;
    case "automation":
      return sum(counts.delayedJobs, counts.failedWebhooks);
    case "alerts":
      return counts.failedAlerts;
    case "abandonedLegalEmail":
      return counts.abandonedLegalEmail;
    case "modelLifecycle":
      return counts.openModelLifecycle;
    case "emailCampaigns":
      return counts.overdueCampaignWaves;
    case "marketing":
      return counts.pendingMarketingApprovals;
    default:
      return null;
  }
};
