import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { abandonedLegalEmailCount } from "@/lib/adminEmailDeliveries";
import { countOpenWorkItems } from "@/lib/modelLifecycleWorkItems";
import { overdueCampaignWaveCount } from "@/lib/adminEmailCampaigns";
import type { AdminNavigationCounts } from "@/lib/adminNavigationBadges";
import { AUTOFIX_OPERATOR_ACTION_STATES } from "@/lib/feedbackAutoFixCore";
import { FEEDBACK_AWAITING_OPERATOR_STATUSES } from "@/lib/feedbackLifecycleCore";
import { AMUX_ESCALATION_AWAITING_STATUSES } from "@/lib/amux/humanReviewCore";
import { countOpenAmuxOrchestratorHalts } from "@/lib/amux/orchestratorHaltStore";

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

/**
 * AMUX escalations waiting on a person, with the same `where` the routing
 * report lists them by (`lib/amux/explainability.ts`), so the Execution badge
 * and the Assignment section count one set. Exported because the Execution
 * page puts the same number on its Assignment tab.
 */
export const countAwaitingAmuxEscalations = () =>
  prisma.amuxHumanEscalation.count({
    where: { status: { in: [...AMUX_ESCALATION_AWAITING_STATUSES] } },
  });

/**
 * Auto-fix cases waiting on an operator. Exported, like the two AMUX counts,
 * because the Agent office's operator to-do counts the same set.
 */
export const countAutoFixActionCases = () =>
  prisma.feedbackAutoFixCase.count({
    where: { state: { in: [...AUTOFIX_OPERATOR_ACTION_STATES] } },
  });

/** Marketing drafts waiting on a person's approval (docs/policy/marketing-automation.md §6). */
export const countPendingMarketingApprovals = () =>
  prisma.marketingPost.count({ where: { status: "pending_approval" } });

export async function getAdminNavigationCounts(): Promise<{
  counts: AdminNavigationCounts;
  /** Whether every read succeeded, which the footer reports as API/DB health. */
  healthy: boolean;
}> {
  const now = new Date();
  const [
    openFeedback,
    supportFeedback,
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
    openAmuxEscalations,
    openAmuxOrchestratorHalts,
  ] = await Promise.allSettled([
    prisma.feedback.count({
      where: { status: { in: [...FEEDBACK_AWAITING_OPERATOR_STATUSES] } },
    }),
    // The same reports, less those whose case is counted in the next read: for
    // Support the case stands in for the report (lib/adminNavigationBadges.ts).
    // `NOT is` keeps a report with no case at all.
    prisma.feedback.count({
      where: {
        status: { in: [...FEEDBACK_AWAITING_OPERATOR_STATUSES] },
        NOT: {
          autoFixCase: { is: { state: { in: [...AUTOFIX_OPERATOR_ACTION_STATES] } } },
        },
      },
    }),
    countAutoFixActionCases(),
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
    countPendingMarketingApprovals(),
    countAwaitingAmuxEscalations(),
    // Orchestration policy version 20: halts no person has cleared.
    countOpenAmuxOrchestratorHalts(),
  ]);

  const jobsValue = settled(jobs);
  const counts: AdminNavigationCounts = {
    openFeedback: settled(openFeedback),
    supportFeedback: settled(supportFeedback),
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
    openAmuxEscalations: settled(openAmuxEscalations),
    openAmuxOrchestratorHalts: settled(openAmuxOrchestratorHalts),
  };

  return {
    counts,
    healthy: Object.values(counts).every((value) => value !== null),
  };
}
