export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AlertTriangle, CheckCircle2, KeyRound, XCircle } from "lucide-react";
import { AdminImageGenerationPanel } from "@/components/admin/AdminImageGenerationPanel";
import { AdminModelMetricsPanel } from "@/components/admin/AdminModelMetricsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProviderHealthPanel } from "@/components/admin/AdminProviderHealthPanel";
import { AdminProviderOpsPanel } from "@/components/admin/AdminProviderOpsPanel";
import { AdminProviderUsageSyncPanel } from "@/components/admin/AdminProviderUsageSyncPanel";
import { getAdminRole } from "@/lib/adminAuth";
import {
  buildModelMetricRows,
  loadProviderHealthDashboard,
  loadProviderOpsData,
} from "@/lib/adminConsoleData";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("providers");

/**
 * Providers, with usage/cost and incidents as its own sections.
 *
 * Three separate workspaces used to render overlapping subsets of the same
 * three panels: `/admin/providers` had a client-side tab strip whose third tab
 * rendered the model registry -- a whole other page, mounted twice in the tree
 * -- while `/admin/usage-cost` re-rendered the health panel and metrics table,
 * and `/admin/incidents` and `/admin/fallback-policies` rendered the *identical*
 * ops panel as each other. The registry now lives only on `/admin/models`, and
 * the two incident routes redirect to one tab.
 */
export default async function AdminProvidersPage({
  searchParams,
}: PageProps<"/admin/providers">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const role = getAdminRole(session) || "readonly";
  const canManageCredits = role === "owner" || role === "billing";
  const canRunVerification = role === "owner" || role === "ops";

  const tabs = (
    <AdminPageTabs
      basePath="/admin/providers"
      tabs={TABS}
      activeTabId={tab.id}
      label="Provider sections"
      query={query}
    />
  );

  if (tab.id === "incidents") {
    const ops = await loadProviderOpsData();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminProviderOpsPanel
          models={ops.models}
          incidents={ops.incidents}
          checks={ops.checks}
        />
      </div>
    );
  }

  const [dashboard, ops] = await Promise.all([
    loadProviderHealthDashboard(),
    loadProviderOpsData(),
  ]);
  const modelMetricRows = buildModelMetricRows(dashboard, ops);

  if (tab.id === "usage-cost") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminProviderUsageSyncPanel />
        <AdminImageGenerationPanel />
        <AdminModelMetricsPanel rows={modelMetricRows} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-black text-white">Provider health</h2>
        <p className="text-sm text-zinc-400">
          Status, key configuration, spend, fallback notes, and per-model metrics.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Available
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Limited
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-300">
          <XCircle className="h-3.5 w-3.5" aria-hidden /> Outage
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-zinc-300">
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> Key
        </span>
      </div>
      <AdminProviderUsageSyncPanel />
      <AdminProviderHealthPanel
        initialDashboard={dashboard}
        canManageCredits={canManageCredits}
        canRunVerification={canRunVerification}
      />
      <AdminModelMetricsPanel rows={modelMetricRows} />
    </div>
  );
}
