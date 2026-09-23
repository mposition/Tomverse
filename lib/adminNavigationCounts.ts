import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { abandonedLegalEmailCount } from "@/lib/adminEmailDeliveries";
import { countOpenWorkItems } from "@/lib/modelLifecycleWorkItems";
import { overdueCampaignWaveCount } from "@/lib/adminEmailCampaigns";
import type { AdminNavigationCounts } from "@/lib/adminNavigationBadges";
import { AUTOFIX_OPERATOR_ACTION_STATES } from "@/lib/feedbackAutoFixCore";

export {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  adminNavigationBadge,
  type AdminNavigationCounts,
} from "@/lib/adminNavigationBadges";

/**
 * The only data the Admin Console layout loads on every navigation.
 *
 * Ten counts, one of them a job-health read. Everything else a page needs is
 * loaded by that page's own server component, so moving between workspaces no
 * longer re-runs the whole console's query set -- which is what the single
 * `AdminWorkspace` did on every route, including the routes that used none of
 * it.
 *
 * Each read is wrapped individually: a badge is decoration, and a failing count
 * must not take the shell down with it. `null` renders as "no badge" rather
 * than as zero, because zero is a claim and an unknown count is not.
 */

const settled = <T>(result: PromiseSettledResult<T>): T | null =>
  result.status === "fulfilled" ? result.value : null;

export async function getAdminNavigationCounts(): Promise<{
  counts: AdminNavigationCounts;
  /** Whether every read succeeded, which the footer reports as API/DB health. */
  healthy: boolean;
}> {
  const now = new Date();
  const [
    openFeedback,
    autoFixActionCases,
    openPrivacyRequests,
    pendingRefunds,
    pendingApprovals,
    activeIncidents,
    failedWebhooks,
    jobs,
    failedAlerts,
    abandonedLegalEmail,
    openModelLifecycle,
    overdueCampaignWaves,
    pendingMarketingApprovals,
  ] = await Promise.allSettled([
    prisma.feedback.count({ where: { status: "open" } }),
    prisma.feedbackAutoFixCase.count({
      where: { state: { in: [...AUTOFIX_OPERATOR_ACTION_STATES] } },
    }),
    prisma.privacyRequest.count({ where: { status: "open" } }),
    prisma.refundRequest.count({ where: { status: "pending" } }),
    prisma.adminActionApproval.count({
      where: { status: "pending", expiresAt: { gt: now } },
    }),
    prisma.adminProviderIncident.count({ where: { status: { not: "resolved" } } }),
    prisma.stripeWebhookEventLog.count({ where: { status: "failed" } }),
    getScheduledJobsDashboard(),
    prisma.adminNotificationLog.count({
      where: { status: "failed", acknowledgedAt: null },
    }),
    abandonedLegalEmailCount(),
    countOpenWorkItems(),
    overdueCampaignWaveCount({ now }),
    prisma.marketingPost.count({ where: { status: "pending_approval" } }),
  ]);

  const jobsValue = settled(jobs);
  const counts: AdminNavigationCounts = {
    openFeedback: settled(openFeedback),
    autoFixActionCases: settled(autoFixActionCases),
    openPrivacyRequests: settled(openPrivacyRequests),
    pendingRefunds: settled(pendingRefunds),
    pendingApprovals: settled(pendingApprovals),
    activeIncidents: settled(activeIncidents),
    failedWebhooks: settled(failedWebhooks),
    delayedJobs: jobsValue
      ? jobsValue.filter((job) => job.delayed || job.status === "stuck").length
      : null,
    failedAlerts: settled(failedAlerts),
    abandonedLegalEmail: settled(abandonedLegalEmail),
    openModelLifecycle: settled(openModelLifecycle),
    overdueCampaignWaves: settled(overdueCampaignWaves),
    pendingMarketingApprovals: settled(pendingMarketingApprovals),
  };

  return {
    counts,
    healthy: Object.values(counts).every((value) => value !== null),
  };
}
