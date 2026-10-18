export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxDecisionMakerReportPanel } from "@/components/admin/AmuxDecisionMakerReportPanel";
import {
  AmuxDecisionMakerRequestDetailPanel,
  type DmAdminRequestDetailView,
} from "@/components/admin/AmuxDecisionMakerRequestDetailPanel";
import { AmuxDecisionMakerRequestsPanel } from "@/components/admin/AmuxDecisionMakerRequestsPanel";
import { AmuxDecisionMakerSwitchPanel } from "@/components/admin/AmuxDecisionMakerSwitchPanel";
import { AmuxOrchestratorHaltsPanel } from "@/components/admin/AmuxOrchestratorHaltsPanel";
import { AmuxTaskCostCatalogApprovalPanel } from "@/components/admin/AmuxTaskCostCatalogApprovalPanel";
import { AmuxAnalysisMonthlyBudgetPanel } from "@/components/admin/AmuxAnalysisMonthlyBudgetPanel";
import { AmuxFrontierModelRegistrationPanel } from "@/components/admin/AmuxFrontierModelRegistrationPanel";
import { AmuxOperatingScopePanel } from "@/components/admin/AmuxOperatingScopePanel";
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
import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerDeclarationAccuracyReport } from "@/lib/amux/decisionMakerJudgmentStore";
import {
  listDecisionMakerRequestsForAdmin,
  readDecisionMakerRequestDetailForAdmin,
  readDecisionMakerSwitchesForAdmin,
} from "@/lib/amux/decisionMakerAdminRead";
import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import {
  AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
  AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
  countOpenAmuxOrchestratorHalts,
  readAmuxOrchestratorHaltsForAdmin,
} from "@/lib/amux/orchestratorHaltStore";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_TASK_CATALOG_WRITE_ENV, amuxV4TaskCatalogWriteEnabled } from
  "@/lib/amux/v4TaskCostCatalogApprovalService";
import {
  AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  AMUX_V4_FRONTIER_CATALOG_WRITE_ENV,
  frontierCatalogReadPermitted,
  frontierCatalogWritePermitted,
} from "@/lib/amux/ideaFrontierCatalogWriteCore";

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
  // Owner only (the tab's viewRoles); resolveAdminTabFor has already refused other roles.
  // Approved backlog redesign, screen C: the monthly analysis budget, the
  // approved analysis models and the Task cost catalogue, each behind the same
  // server switches as before; the execution and plan approvals only read them.
  if (tab.id === "analysis") {
    const budgetAvailable = process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ === "enabled" &&
      process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE === "enabled";
    const modelWriteAvailable =
      frontierCatalogReadPermitted(process.env[AMUX_V4_FRONTIER_CATALOG_READ_ENV]) &&
      frontierCatalogWritePermitted(process.env[AMUX_V4_FRONTIER_CATALOG_WRITE_ENV]);
    // amux-intake v19 item 2: the operating scope is the one approval for
    // unattended intake, so it comes first on this owner-only tab.
    return <div className="flex min-w-0 flex-col gap-5">{tabs}
      <AmuxOperatingScopePanel operatorId={session.user.id} />
      <AmuxAnalysisMonthlyBudgetPanel available={budgetAvailable} operatorId={session.user.id} />
      <AmuxFrontierModelRegistrationPanel writeAvailable={modelWriteAvailable} operatorId={session.user.id} />
      <AmuxTaskCostCatalogApprovalPanel approvalAvailable={
        amuxV4TaskCatalogWriteEnabled(process.env[AMUX_V4_TASK_CATALOG_WRITE_ENV])} /></div>;
  }
  if (tab.id === "decision-maker") {
    // The switch, the declaration-accuracy report and the request list are
    // independent reads. A failure in any one stays visible instead of
    // becoming a default switch state, a zero-valued report or an empty list.
    const failed = (event: string) => (error: unknown) => {
      console.warn(JSON.stringify({
        subsystem: "amux",
        event,
        code: error instanceof AmuxDbBoundaryError ? error.code : null,
      }));
      return null;
    };
    // One request's bodies are for the person who may judge it (ops:write):
    // another administrator sees the list and is told why, and nothing of the
    // bodies is read for them.
    const requested = typeof query.request === "string" ? query.request : null;
    const readDetail = async (): Promise<DmAdminRequestDetailView | null> => {
      if (requested === null) return null;
      if (!canChange) return { kind: "restricted" };
      if (!isDmRequestId(requested)) return { kind: "not_found" };
      // A failed read is null from failed(); a missing request is a read that found nothing.
      const read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestDetailRead,
        (tx) => readDecisionMakerRequestDetailForAdmin(tx, requested))
        .then((detail) => ({ detail }), failed("decision_maker_request_detail_read_failed"));
      if (read === null) return { kind: "unavailable" };
      return read.detail === null ? { kind: "not_found" } : { kind: "detail", detail: read.detail };
    };
    const [switches, report, requests, detailView] = await Promise.all([
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead,
        (tx) => readDecisionMakerSwitchesForAdmin(tx)).catch(failed("decision_maker_switch_read_failed")),
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerReportRead,
        (tx) => readDecisionMakerDeclarationAccuracyReport(tx))
        .catch(failed("decision_maker_report_read_failed")),
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestListRead,
        (tx) => listDecisionMakerRequestsForAdmin(tx))
        .catch(failed("decision_maker_request_list_read_failed")),
      readDetail(),
    ]);
    return <div className="flex min-w-0 flex-col gap-5">{tabs}
      <AmuxDecisionMakerSwitchPanel state={switches?.state ?? null} latches={switches?.latches ?? null}
        canChange={canChange} />
      {detailView !== null ? <AmuxDecisionMakerRequestDetailPanel view={detailView} /> : null}
      <AmuxDecisionMakerRequestsPanel list={requests} />
      <AmuxDecisionMakerReportPanel report={report} /></div>;
  }
  const view = await readAmuxOrchestratorHaltsForAdmin().catch(() => null);
  return <div className="flex min-w-0 flex-col gap-5">{tabs}
    <AmuxOrchestratorHaltsPanel view={view} canClear={isOwner} limits={{
      open: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT, cleared: AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
      human: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
    }} /></div>;
}
