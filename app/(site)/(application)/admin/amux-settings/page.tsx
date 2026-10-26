export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxDecisionMakerReportPanel } from "@/components/admin/AmuxDecisionMakerReportPanel";
import { AmuxDecisionMakerRequestsPanel } from "@/components/admin/AmuxDecisionMakerRequestsPanel";
import { AmuxDecisionMakerSwitchPanel } from "@/components/admin/AmuxDecisionMakerSwitchPanel";
import { AmuxDecisionMakerWorkPointer } from "@/components/admin/AmuxDecisionMakerWorkPointer";
import { AmuxOrchestratorHaltsPanel } from "@/components/admin/AmuxOrchestratorHaltsPanel";
import { AmuxAnalysisMonthlyBudgetPanel } from "@/components/admin/AmuxAnalysisMonthlyBudgetPanel";
import { AmuxFrontierModelRegistrationPanel } from "@/components/admin/AmuxFrontierModelRegistrationPanel";
import { AmuxOperatingScopePanel } from "@/components/admin/AmuxOperatingScopePanel";
import { AmuxMaxSubscriptionPricePanel } from "@/components/admin/AmuxMaxSubscriptionPricePanel";
import { AmuxSessionBudgetResolutionPanel } from "@/components/admin/AmuxSessionBudgetResolutionPanel";
import { AmuxV22PromotionControl } from "@/components/admin/AmuxV22PromotionControl";
import { AmuxWorkersOverviewPanel } from "@/components/admin/AmuxWorkersOverview";
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
  readDecisionMakerSwitchesForAdmin,
} from "@/lib/amux/decisionMakerAdminRead";
import { dmAdminAttentionKind } from "@/lib/amux/decisionMakerAdminCore";
import { dmAdminRequestDetailHref } from "@/lib/amux/decisionMakerAdminHrefs";
import {
  AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
  AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
  countOpenAmuxOrchestratorHalts,
  readAmuxOrchestratorHaltsForAdmin,
} from "@/lib/amux/orchestratorHaltStore";
import { readAgentOfficeAmuxWorkers } from "@/lib/agentOfficeLiveRead";
import { readAmuxWorkerCapabilitiesForAdmin } from "@/lib/amux/workerCapabilityAdminRead";
import { readAmuxWorkerRegistryForAdmin } from "@/lib/amux/workerRegistryAdminRead";
import { amuxWorkerRegistryWritesOpen } from "@/lib/amux/workerRegistryCore";
import { authOptions } from "@/lib/auth";
import {
  AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  AMUX_V4_FRONTIER_CATALOG_WRITE_ENV,
  frontierCatalogReadPermitted,
  frontierCatalogWritePermitted,
} from "@/lib/amux/ideaFrontierCatalogWriteCore";

const TABS = adminNavItemTabs("amux-settings");

/** The clock for the Workers ages, read after the data it is counted against. */
const currentTimeMs = () => Date.now();

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
    // A registry change takes the owner role, the stage's code latch and a
    // recent step-up (orchestration policy version 31, sections 3 and 8).
    workers: !isOwner ? "read_only" : amuxWorkerRegistryWritesOpen() ? undefined : "behind_server_switch",
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
  if (tab.id === "workers") {
    // Every admin role reads the list; only the owner is offered changes, and
    // the route decides that again. Each of the three reads that fails is
    // shown as such, never as an empty list or a guessed connection.
    const [registry, capabilities, live] = await Promise.all([
      readAmuxWorkerRegistryForAdmin().catch(() => null),
      readAmuxWorkerCapabilitiesForAdmin().catch(() => null),
      readAgentOfficeAmuxWorkers(),
    ]);
    return <div className="flex min-w-0 flex-col gap-5">{tabs}
      <AmuxWorkersOverviewPanel registry={registry} capabilities={capabilities} live={live}
        readAtMs={currentTimeMs()} isOwner={isOwner} /></div>;
  }
  // Owner only (the tab's viewRoles); resolveAdminTabFor has already refused other roles.
  // Approved backlog redesign, screen C: the monthly analysis budget, the
  // approved analysis models, each behind the same server switches as before.
  // Task costs need no approval: they come from the worker registry and
  // Admin › Models (owner decision 2026-10-25).
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
      <AmuxMaxSubscriptionPricePanel />
      <AmuxAnalysisMonthlyBudgetPanel available={budgetAvailable} operatorId={session.user.id} />
      <AmuxSessionBudgetResolutionPanel />
      <AmuxFrontierModelRegistrationPanel writeAvailable={modelWriteAvailable} operatorId={session.user.id} /></div>;
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
    // One request now opens as a side panel over AMUX › Execution, where the
    // work that waits on a person is; this address keeps working.
    if (typeof query.request === "string") redirect(dmAdminRequestDetailHref(query.request));
    const [switches, report, requests] = await Promise.all([
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead,
        (tx) => readDecisionMakerSwitchesForAdmin(tx)).catch(failed("decision_maker_switch_read_failed")),
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerReportRead,
        (tx) => readDecisionMakerDeclarationAccuracyReport(tx))
        .catch(failed("decision_maker_report_read_failed")),
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestListRead,
        (tx) => listDecisionMakerRequestsForAdmin(tx))
        .catch(failed("decision_maker_request_list_read_failed")),
    ]);
    const waiting = requests === null ? null
      : requests.rows.filter((row) => dmAdminAttentionKind(row, requests.dbNowMs) !== null);
    return <div className="flex min-w-0 flex-col gap-5">{tabs}
      <AmuxDecisionMakerWorkPointer waiting={waiting === null ? null : waiting.length}
        href={waiting !== null && waiting.length === 1 ? dmAdminRequestDetailHref(waiting[0]!.requestId)
          : role === "owner" ? "/admin/amux-execution?tab=cards" : null} />
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <AmuxDecisionMakerSwitchPanel state={switches?.state ?? null} latches={switches?.latches ?? null}
          canChange={canChange} />
        <AmuxDecisionMakerReportPanel report={report} />
      </div>
      <AmuxDecisionMakerRequestsPanel list={requests} /></div>;
  }
  const view = await readAmuxOrchestratorHaltsForAdmin().catch(() => null);
  return <div className="flex min-w-0 flex-col gap-5">{tabs}
    <AmuxOrchestratorHaltsPanel view={view} canClear={isOwner} limits={{
      open: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT, cleared: AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
      human: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
    }} /></div>;
}
