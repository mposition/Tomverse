export const dynamic = "force-dynamic";

import { AdminMemoryImportPanel } from "@/components/admin/AdminMemoryImportPanel";
import { AdminMemoryRevocationPanel } from "@/components/admin/AdminMemoryRevocationPanel";
import { AdminPackageImportPanel } from "@/components/admin/AdminPackageImportPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProductAnalyticsPanel } from "@/components/admin/AdminProductAnalyticsPanel";
import { LaunchFunnelPanel } from "@/components/admin/AdminRiskPanels";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAssistantPackageImportMetrics } from "@/lib/assistantPackageImportMetrics";
import { getAdminUserStats } from "@/lib/adminUsers";
import { prisma } from "@/lib/prisma";
import { getProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";

const TABS = adminNavItemTabs("analytics");

/**
 * Product analytics and import/memory metrics, as two separate tabs.
 *
 * They answer different questions from different sources -- one is the consented
 * event ledger, the other is content-free import and memory telemetry -- and
 * stacking them on one page made a long scroll where the second half looked
 * like a footnote to the first. Splitting them also means opening the funnel
 * does not issue the two report fetches, and vice versa.
 *
 * The account-level launch funnel moved here too: it used to be rendered on the
 * promotions workspace, which is not where anyone looks for a conversion funnel.
 */
export default async function AdminAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analytics">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  const tabs = (
    <AdminPageTabs
      basePath="/admin/analytics"
      tabs={TABS}
      activeTabId={tab.id}
      label="Analytics sections"
      query={query}
    />
  );

  if (tab.id === "imports") {
    const packageImports = await getAssistantPackageImportMetrics();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminMemoryImportPanel />
        {/*
          Read here rather than fetched by the panel: this one is a single
          grouped query over the event ledger, and the tab is already a server
          component. The memory panel above fetches because its two reports are
          separate endpoints that can each be unavailable.
        */}
        <AdminPackageImportPanel metrics={packageImports} />
        {/*
          The §12.1 revocation control sits under the report it reacts to: the
          per-pair failure table above is where an operator sees one pair
          failing, and stopping that pair is the next action. It is the only
          write on this tab, and it only ever restricts.
        */}
        <AdminMemoryRevocationPanel />
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
      {tabs}
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
