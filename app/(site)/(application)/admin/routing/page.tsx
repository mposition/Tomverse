export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminRoutingShadowPanel } from "@/components/admin/AdminRoutingShadowPanel";
import { AdminAdaptiveStatisticsPanel } from "@/components/admin/AdminAdaptiveStatisticsPanel";
import { AutoRouterTab } from "@/components/admin/routing/AutoRouterOverview";
import { AdminAutoRouterOptimizerPanel } from "@/components/admin/AdminAutoRouterOptimizerPanel";
import { AdminAutoRewriteOptimizerPanel } from "@/components/admin/AdminAutoRewriteOptimizerPanel";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAdminRole } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import {
  ADMIN_NAVIGATION,
  adminItemIsWritable,
  adminNavItemTabs,
  resolveAdminTabFor,
} from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("routing");
// Fail closed: if the entry is ever renamed, nothing on the page draws as writable.
const ROUTING_ITEM = ADMIN_NAVIGATION.find((item) => item.id === "routing");

/**
 * Routing, in its own workspace rather than as a tab on Models.
 *
 * Models is the registry -- what exists and how it is configured. This is the
 * Auto router, the optimizers that tune it, and a measurement of a decision
 * the server would make, which is a different question with a different
 * audience; folding it into the registry page would put an experiment's
 * numbers beside an editable table.
 *
 * The Auto router tab opens on an overview (the flow, four numbers and the
 * shadow comparison as one bar) above the settings that change the router.
 *
 * The four panels that used to stack on this page are one tab each
 * (2026-11-07): the Auto router, the optimizers, the shadow comparison, and
 * the owner's adaptive statistics. Every change the router panels offer takes
 * `ops:write` in its route, which the route table now says too. The statistics
 * tab is the owner's alone: another role is told 404 rather than shown a
 * different tab.
 *
 * AMUX assignment evidence used to sit above it. It moved to the Execution
 * board's review queue, and the line below says so, because runbooks written
 * before the move send operators here to find it.
 */
export default async function AdminRoutingPage({ searchParams }: PageProps<"/admin/routing">) {
  const query = await searchParams;
  const session = await getServerSession(authOptions);
  const role = getAdminRole(session);
  const resolved = resolveAdminTabFor(TABS, role, query.tab);
  if (!resolved) notFound();
  const { tab } = resolved;
  // Only draws the controls locked; every route refuses a write from another role itself.
  const canWrite = role !== null && ROUTING_ITEM !== undefined && adminItemIsWritable(role, ROUTING_ITEM);
  const m = await getAdminMessages(adminAmuxWorkspaceMessages);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/routing"
        tabs={TABS}
        activeTabId={tab.id}
        label="Routing sections"
        query={query}
        role={role}
      />
      <p className="rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-300">
        {m.routingMoved.before}
        <Link
          href="/admin/amux-execution?tab=diagnostics"
          className="font-bold text-blue-300 underline underline-offset-4 hover:text-blue-200"
        >
          {m.routingMoved.link}
        </Link>
        {m.routingMoved.after}
      </p>
      {tab.id === "optimizer" ? (
        <>
          <AdminAutoRouterOptimizerPanel canSendToAmux={role === "owner"} canWrite={canWrite} />
          <AdminAutoRewriteOptimizerPanel canWrite={canWrite} />
        </>
      ) : tab.id === "shadow" ? (
        <AdminRoutingShadowPanel />
      ) : tab.id === "stats" ? (
        // The tab's `viewRoles` only hides it; this is what refuses another role.
        role === "owner" ? <AdminAdaptiveStatisticsPanel /> : notFound()
      ) : (
        <AutoRouterTab canWrite={canWrite} />
      )}
    </div>
  );
}
