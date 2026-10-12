export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxDecisionMakerSwitchPanel } from "@/components/admin/AmuxDecisionMakerSwitchPanel";
import { AmuxOrchestratorHaltsPanel } from "@/components/admin/AmuxOrchestratorHaltsPanel";
import { AmuxV22PromotionControl } from "@/components/admin/AmuxV22PromotionControl";
import {
  amuxSwitchedTabStatus,
  amuxTabChips,
  type AmuxTabStatus,
} from "@/lib/adminAmuxTabStatus";
import { getAdminRole, hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { adminNavItemTabs, resolveAdminTabFor } from "@/lib/adminNavigation";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "@/lib/adminNavigationCounts";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import {
  AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
  AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
  countOpenAmuxOrchestratorHalts,
  readAmuxOrchestratorHaltsForAdmin,
} from "@/lib/amux/orchestratorHaltStore";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("amux-settings");

export default async function AdminAmuxSettingsPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) notFound();
  const role = getAdminRole(session);
  const query = await searchParams;
  const resolved = resolveAdminTabFor(TABS, role, query.tab);
  if (!resolved) notFound();
  const { tab } = resolved;
  const [m, openAmuxOrchestratorHalts] = await Promise.all([
    getAdminMessages(adminAmuxWorkspaceMessages),
    countOpenAmuxOrchestratorHalts().catch(() => null),
  ]);
  const isOwner = role === "owner";
  const canChange = hasAdminPermission(session, "ops:write");
  const statuses: Record<string, AmuxTabStatus | undefined> = {
    "automatic-admission": isOwner
      ? amuxSwitchedTabStatus("automatic-admission")
      : undefined,
    safety: isOwner ? undefined : "read_only",
    "decision-maker": canChange ? undefined : "read_only",
  };
  const tabs = <AdminPageTabs basePath="/admin/amux-settings" tabs={TABS}
    activeTabId={tab.id} label="AMUX operations settings sections" query={query} role={role}
    counts={{ ...EMPTY_ADMIN_NAVIGATION_COUNTS, openAmuxOrchestratorHalts }}
    chips={amuxTabChips(statuses, m.status)} />;
  if (tab.id === "automatic-admission") {
    return <div className="flex min-w-0 flex-col gap-5">{tabs}
      <AmuxV22PromotionControl /></div>;
  }
  if (tab.id === "decision-maker") {
    const state = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead,
      (tx) => readDecisionMakerSwitchesOrThrow(tx)).catch(() => null);
    return <div className="flex min-w-0 flex-col gap-5">{tabs}
      <AmuxDecisionMakerSwitchPanel state={state} canChange={canChange} /></div>;
  }
  const view = await readAmuxOrchestratorHaltsForAdmin().catch(() => null);
  return <div className="flex min-w-0 flex-col gap-5">{tabs}
    <AmuxOrchestratorHaltsPanel view={view} canClear={isOwner} limits={{
      open: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT, cleared: AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
      human: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
    }} /></div>;
}
