import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import type { AdminNavigationCounts } from "@/lib/adminNavigationBadges";

export {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  adminNavigationBadge,
  type AdminNavigationCounts,
} from "@/lib/adminNavigationBadges";

/**
 * The only data the Admin Console layout loads on every navigation.
 *
 * Eight counts, one of them a job-health read. Everything else a page needs is
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
    openPrivacyRequests,
    pendingRefunds,
    pendingApprovals,
    activeIncidents,
    failedWebhooks,
    jobs,
    failedAlerts,
  ] = await Promise.allSettled([
    prisma.feedback.count({ where: { status: "open" } }),
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
  ]);

  const jobsValue = settled(jobs);
  const counts: AdminNavigationCounts = {
    openFeedback: settled(openFeedback),
    openPrivacyRequests: settled(openPrivacyRequests),
    pendingRefunds: settled(pendingRefunds),
    pendingApprovals: settled(pendingApprovals),
    activeIncidents: settled(activeIncidents),
    failedWebhooks: settled(failedWebhooks),
    delayedJobs: jobsValue
      ? jobsValue.filter((job) => job.delayed || job.status === "stuck").length
      : null,
    failedAlerts: settled(failedAlerts),
  };

  return {
    counts,
    healthy: Object.values(counts).every((value) => value !== null),
  };
}
