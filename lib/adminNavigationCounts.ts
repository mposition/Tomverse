import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { abandonedLegalEmailCount } from "@/lib/adminEmailDeliveries";
import { countOpenWorkItems } from "@/lib/modelLifecycleWorkItems";
import { overdueCampaignWaveCount } from "@/lib/adminEmailCampaigns";
import type { AdminNavigationCounts } from "@/lib/adminNavigationBadges";
import { FEEDBACK_AWAITING_OPERATOR_STATUSES } from "@/lib/feedbackLifecycleCore";
import { AMUX_ESCALATION_AWAITING_STATUSES } from "@/lib/amux/humanReviewCore";
import { countOpenAmuxOrchestratorHalts } from "@/lib/amux/orchestratorHaltStore";
import { countDecisionMakerAttention } from "@/lib/amux/decisionMakerAttention";
import { countAmuxOwnerQueue } from "@/lib/amux/adminOwnerQueueRead";

export {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  adminNavigationBadge,
  type AdminNavigationCounts,
} from "@/lib/adminNavigationBadges";

/**
 * The only data the Admin Console layout loads on every navigation.
 *
 * A few counts, one of them a job-health read. Everything else a page needs is
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
 * page puts the same number on its Assignment tab. An escalation on an
 * archived card is left out, as Waiting on me leaves the card out (owner
 * decision 2026-11-09): the agent office links this count to that tab.
 */
export const countAwaitingAmuxEscalations = () =>
  prisma.amuxHumanEscalation.count({
    where: { status: { in: [...AMUX_ESCALATION_AWAITING_STATUSES] }, task: { archivedAt: null } },
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
    openProductResearchSuggestions,
    openAmuxEscalations,
    awaitingAmuxOwnerQueue,
    openAmuxOrchestratorHalts,
    awaitingAmuxDecisionMaker,
  ] = await Promise.allSettled([
    prisma.feedback.count({
      where: { status: { in: [...FEEDBACK_AWAITING_OPERATOR_STATUSES] } },
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
    countPendingMarketingApprovals(),
    prisma.productResearchSuggestion.count({ where: { status: "open" } }),
    countAwaitingAmuxEscalations(),
    // The Execution entry, its "Waiting on me" tab and the board column show this one count.
    countAmuxOwnerQueue(),
    // Orchestration policy version 20: halts no person has cleared.
    countOpenAmuxOrchestratorHalts(),
    countDecisionMakerAttention(),
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
    abandonedLegalEmail: settled(abandonedLegalEmail),
    openModelLifecycle: settled(openModelLifecycle),
    overdueCampaignWaves: settled(overdueCampaignWaves),
    pendingMarketingApprovals: settled(pendingMarketingApprovals),
    openProductResearchSuggestions: settled(openProductResearchSuggestions),
    openAmuxEscalations: settled(openAmuxEscalations),
    awaitingAmuxOwnerQueue: settled(awaitingAmuxOwnerQueue),
    openAmuxOrchestratorHalts: settled(openAmuxOrchestratorHalts),
    awaitingAmuxDecisionMaker: settled(awaitingAmuxDecisionMaker),
  };

  return {
    counts,
    healthy: Object.values(counts).every((value) => value !== null),
  };
}
