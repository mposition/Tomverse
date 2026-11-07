export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminImageGenerationPanel } from "@/components/admin/AdminImageGenerationPanel";
import { AdminModelMetricsPanel } from "@/components/admin/AdminModelMetricsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProviderHealthPanel } from "@/components/admin/AdminProviderHealthPanel";
import { AdminProviderOpsPanel } from "@/components/admin/AdminProviderOpsPanel";
import { AdminProviderUsageSyncPanel } from "@/components/admin/AdminProviderUsageSyncPanel";
import { ProviderCostBoard } from "@/components/admin/providers/ProviderCostBoard";
import { ProviderSyncMoved } from "@/components/admin/providers/ProviderSyncMoved";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { getAdminRole } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminProviderBoardMessages } from "@/lib/adminMessages/providerBoard";
import {
  buildFallbackChains,
  latestCheckLatencyByProvider,
} from "@/lib/adminProviderBoardCore";
import { loadProviderCostSeries } from "@/lib/adminProviderCostSeries";
import {
  buildModelMetricRows,
  loadProviderHealthDashboard,
  loadProviderOpsData,
} from "@/lib/adminConsoleData";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("providers");

const settled = <T,>(result: PromiseSettledResult<T>, read: string): T | null => {
  if (result.status === "fulfilled") return result.value;
  // Reported, never absorbed: the screen says which read did not come back.
  console.warn({ event: "admin_providers_read_failed", read });
  return null;
};

/**
 * Providers, with usage/cost and incidents as its own sections.
 *
 * Each section reads what it draws with `allSettled`, so one read that fails
 * (provider health is the one most likely to, during an incident) leaves the
 * rest of the section usable and says which part is missing instead of
 * sending the whole workspace to the error boundary.
 *
 * Usage sync is on the Usage & cost section only. The Status section and a
 * provider's own page link there instead of carrying a second button.
 */
export default async function AdminProvidersPage({
  searchParams,
}: PageProps<"/admin/providers">) {
  const query = await searchParams;
  const bm = await getAdminMessages(adminProviderBoardMessages);
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const role = getAdminRole(session) || "readonly";
  const canManageCredits = role === "owner" || role === "billing";
  // ops:write, which is what the verification, incident and sync routes check.
  const canWrite = role === "owner" || role === "ops";

  const tabs = (
    <AdminPageTabs
      basePath="/admin/providers"
      tabs={TABS}
      activeTabId={tab.id}
      label="Provider sections"
      query={query}
    />
  );
  const unread = (what: string) => (
    <AdminStateBlock kind="error" title={bm.readFailed(what)} detail={bm.readFailedDetail} />
  );

  if (tab.id === "incidents") {
    const [opsResult, dashboardResult] = await Promise.allSettled([
      loadProviderOpsData(),
      loadProviderHealthDashboard(),
    ]);
    const ops = settled(opsResult, "ops");
    const dashboard = settled(dashboardResult, "health");
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {ops ? (
          <AdminProviderOpsPanel
            models={ops.models}
            incidents={ops.incidents}
            checks={ops.checks}
            chains={dashboard ? buildFallbackChains(dashboard.providers, ops.models) : null}
            canWrite={canWrite}
          />
        ) : (
          unread(bm.reads.ops)
        )}
      </div>
    );
  }

  if (tab.id === "usage-cost") {
    const [dashboardResult, seriesResult] = await Promise.allSettled([
      loadProviderHealthDashboard(),
      loadProviderCostSeries(),
    ]);
    const dashboard = settled(dashboardResult, "health");
    const series = settled(seriesResult, "cost-series");
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <ProviderCostBoard
          series={series}
          rows={
            dashboard
              ? dashboard.providers.map((row) => ({
                  provider: row.provider,
                  displayName: row.displayName,
                  apiKeyConfigured: row.apiKeyConfigured,
                  monthCostMicroUsd: row.monthCostMicroUsd,
                  providerReportedMonthCostMicroUsd: row.providerReportedMonthCostMicroUsd,
                  monthBudgetMicroUsd: row.monthBudgetMicroUsd,
                  projectedMonthEndMicroUsd: row.projectedMonthEndMicroUsd,
                  lastUsageSyncAt: row.lastUsageSyncAt,
                }))
              : null
          }
        />
        <AdminProviderUsageSyncPanel canWrite={canWrite} />
        <AdminImageGenerationPanel />
      </div>
    );
  }

  const [dashboardResult, opsResult] = await Promise.allSettled([
    loadProviderHealthDashboard(),
    loadProviderOpsData(),
  ]);
  const dashboard = settled(dashboardResult, "health");
  const ops = settled(opsResult, "ops");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {dashboard ? (
        <AdminProviderHealthPanel
          initialDashboard={dashboard}
          canManageCredits={canManageCredits}
          canRunVerification={canWrite}
          latencyByProvider={ops ? latestCheckLatencyByProvider(ops.checks) : {}}
        />
      ) : (
        unread(bm.reads.health)
      )}
      <ProviderSyncMoved />
      {dashboard && ops ? (
        <AdminModelMetricsPanel rows={buildModelMetricRows(dashboard, ops)} />
      ) : (
        unread(bm.reads.ops)
      )}
    </div>
  );
}
