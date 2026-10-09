export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminAmuxRoutingPanel } from "@/components/admin/AdminAmuxRoutingPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxCardListPanel } from "@/components/admin/AmuxCardListPanel";
import { AmuxExecutionWorkspace } from "@/components/admin/AmuxExecutionWorkspace";
import { AmuxCliUsagePanel } from "@/components/admin/AmuxCliUsagePanel";
import { AmuxDecisionMakerSwitchPanel } from "@/components/admin/AmuxDecisionMakerSwitchPanel";
import { AmuxOrchestratorHaltsPanel } from "@/components/admin/AmuxOrchestratorHaltsPanel";
import { amuxTabChips, type AmuxTabStatus } from "@/lib/adminAmuxTabStatus";
import { getAdminRole, hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { adminNavItemTabs, resolveAdminTabFor } from "@/lib/adminNavigation";
import {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  countAwaitingAmuxEscalations,
} from "@/lib/adminNavigationCounts";
import { listAmuxCardsForAdmin } from "@/lib/amux/adminCardList";
import { readAmuxCliUsageSummaryForAdmin } from "@/lib/amux/adminCliUsageSummary";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import {
  AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
  AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
  countOpenAmuxOrchestratorHalts,
  readAmuxOrchestratorHaltsForAdmin,
} from "@/lib/amux/orchestratorHaltStore";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("amux-execution");

/**
 * What AMUX is running: the cards and why each was assigned where it was.
 *
 * Cards is the owner-only list that used to live at `/admin/amux-cards`.
 * Assignment is the panel that used to sit on `/admin/routing` beside Chat
 * shadow routing; it opens to every admin role, as it did there, and its
 * decisions still take `ops:write` in every route they call.
 *
 * The owner opens on Cards and everyone else on Assignment, because each opens
 * on the first section they may see. A non-owner who names `?tab=cards` gets
 * a 404 rather than Assignment in its place, which is what the old address
 * answered them.
 */
export default async function AdminAmuxExecutionPage({
  searchParams,
}: PageProps<"/admin/amux-execution">) {
  const session = await getServerSession(authOptions);
  const role = getAdminRole(session);
  const query = await searchParams;
  const resolved = resolveAdminTabFor(TABS, role, query.tab);
  if (!resolved) notFound();
  const { tab } = resolved;

  const [m, openAmuxEscalations, openAmuxOrchestratorHalts] = await Promise.all([
    getAdminMessages(adminAmuxWorkspaceMessages),
    // The tabs' badges. A failed count shows no badge rather than a zero.
    countAwaitingAmuxEscalations().catch(() => null),
    countOpenAmuxOrchestratorHalts().catch(() => null),
  ]);
  const isOwner = Boolean(session?.user?.id) && role === "owner";
  const canChangeDmSwitches = hasAdminPermission(session, "ops:write");
  const statuses: Record<string, AmuxTabStatus | undefined> = {
    // The card list issues no request and writes nothing
    // (tests/amuxAdminCardList.test.mjs pins both), so there is no switch for
    // this to read: it is read-only by construction, for the owner too.
    cards: "read_only",
    // The same permission every escalation, proposal and review route checks.
    assignment: hasAdminPermission(session, "ops:write") ? undefined : "read_only",
    // Clearing an orchestrator halt takes the owner role, and a recent
    // step-up that the clear route checks and the panel offers the way back
    // to (orchestration policy version 20, section 7).
    halts: isOwner ? undefined : "read_only",
    // A Decision Maker switch change takes the permission and the step-up its
    // route checks (docs/policy/amux-decision-maker.md §8).
    "decision-maker": canChangeDmSwitches ? undefined : "read_only",
  };

  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-execution"
      tabs={TABS}
      activeTabId={tab.id}
      label="Execution sections"
      query={query}
      role={role}
      counts={{ ...EMPTY_ADMIN_NAVIGATION_COUNTS, openAmuxEscalations, openAmuxOrchestratorHalts }}
      chips={amuxTabChips(statuses, m.status)}
    />
  );

  if (tab.id === "cards") {
    // Authorization for the section, decided here and not by the route
    // table's `viewRoles`, exactly as the page it replaced decided it.
    if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
    const [{ rows, total, limit }, usage] = await Promise.all([
      listAmuxCardsForAdmin(),
      readAmuxCliUsageSummaryForAdmin().catch(() => null),
    ]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AmuxExecutionWorkspace />
        <AmuxCardListPanel rows={rows} total={total} limit={limit} />
        <AmuxCliUsagePanel view={usage} />
      </div>
    );
  }

  if (tab.id === "halts") {
    // Every admin role reads the halts, as the Execution entry's badge counts
    // them for every role; only the owner is offered the clear, and the clear
    // route decides that again on its own.
    const view = await readAmuxOrchestratorHaltsForAdmin();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AmuxOrchestratorHaltsPanel
          view={view}
          canClear={isOwner}
          limits={{
            open: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
            cleared: AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
            human: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
          }}
        />
      </div>
    );
  }

  if (tab.id === "decision-maker") {
    // Every admin role reads the switches, as the switch route's GET answers
    // them: reading Decision Maker records stays open under the kill switch
    // (docs/policy/amux-decision-maker.md §6). A read that fails is shown as
    // such, never as a default state.
    const state = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead, (tx) =>
      readDecisionMakerSwitchesOrThrow(tx),
    ).catch(() => null);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AmuxDecisionMakerSwitchPanel state={state} canChange={canChangeDmSwitches} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      <AdminAmuxRoutingPanel focusEscalationId={
        typeof query.focusEscalation === "string" &&
        /^c[a-z0-9]{20,}$/i.test(query.focusEscalation) ?
          query.focusEscalation : null} />
    </div>
  );
}
