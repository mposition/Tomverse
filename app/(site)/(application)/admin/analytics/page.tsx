export const dynamic = "force-dynamic";

import { AdminImportMetricsPanel } from "@/components/admin/AdminImportMetricsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProductAnalyticsPanel } from "@/components/admin/AdminProductAnalyticsPanel";
import { LaunchFunnelPanel } from "@/components/admin/AdminRiskPanels";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAdminUserStats } from "@/lib/adminUsers";
import { getExternalImportReport } from "@/lib/externalImportMetrics";
import { prisma } from "@/lib/prisma";
import { getProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

const TABS = adminNavItemTabs("analytics");

/**
 * Product analytics and import/memory metrics, as two separate tabs.
 *
 * They answer different questions from different sources -- one is the consented
 * event ledger, the other is content-free import telemetry -- and stacking them
 * on one page made a long scroll where the second half looked like a footnote
 * to the first. The account-level launch funnel moved here too: it used to be
 * rendered on the promotions workspace, which is not where anyone looks for a
 * conversion funnel.
 */
export default async function AdminAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analytics">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  if (tab.id === "imports") {
    const report = await getExternalImportReport();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <AdminPageTabs
          basePath="/admin/analytics"
          tabs={TABS}
          activeTabId={tab.id}
          label="Analytics sections"
          query={query}
        />
        <AdminImportMetricsPanel report={report} />
      </div>
    );
  }

  const [dashboard, userStats, usersWithConversations, checkoutStartedCount] =
    await Promise.all([
      getProductAnalyticsDashboard(),
      getAdminUserStats(),
      prisma.conversation.groupBy({ by: ["userId"], _count: { _all: true } }),
      prisma.stripeWebhookEventLog.count({
        where: { eventType: "checkout.session.completed" },
      }),
    ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/analytics"
        tabs={TABS}
        activeTabId={tab.id}
        label="Analytics sections"
        query={query}
      />
      <AdminProductAnalyticsPanel dashboard={dashboard} />
      <LaunchFunnelPanel
        funnel={{
          totalUsers: userStats.totalAccounts,
          usersWithConversations: usersWithConversations.length,
          usersWithPaidPlan: userStats.activePaidSubscriptions,
          checkoutStarted: checkoutStartedCount,
          paidUsers: userStats.activePaidSubscriptions,
        }}
      />
    </div>
  );
}
