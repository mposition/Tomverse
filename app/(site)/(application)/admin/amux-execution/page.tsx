export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminAmuxRoutingPanel } from "@/components/admin/AdminAmuxRoutingPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxExecutionSupportingRecords } from "@/components/admin/AmuxExecutionSupportingRecords";
import { AmuxCardDisplayKeyBackfillPanel } from "@/components/admin/AmuxCardDisplayKeyBackfillPanel";
import { AmuxCardListPanel } from "@/components/admin/AmuxCardListPanel";
import { AmuxExecutionWorkspace } from "@/components/admin/AmuxExecutionWorkspace";
import { AmuxCliUsagePanel } from "@/components/admin/AmuxCliUsagePanel";
import { AmuxDecisionMakerRequestDrawer } from "@/components/admin/AmuxDecisionMakerRequestDrawer";
import type { DmAdminRequestDetailView } from "@/components/admin/AmuxDecisionMakerRequestDetailPanel";
import { AmuxWorkerCapabilityPanel } from "@/components/admin/AmuxWorkerCapabilityPanel";
import { AmuxWorkerRegistryPanel } from "@/components/admin/AmuxWorkerRegistryPanel";
import { amuxTabChips, type AmuxTabStatus } from "@/lib/adminAmuxTabStatus";
import { getAdminRole, hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { ADMIN_AMUX_EXECUTION_LEGACY_TABS, adminRedirectTarget, adminNavItemTabs, resolveAdminTabFor } from "@/lib/adminNavigation";
import {
  EMPTY_ADMIN_NAVIGATION_COUNTS,
  countAwaitingAmuxEscalations,
} from "@/lib/adminNavigationCounts";
import { listAmuxCardsForAdmin } from "@/lib/amux/adminCardList";
import { readAmuxCliUsageSummaryForAdmin } from "@/lib/amux/adminCliUsageSummary";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerRequestDetailForAdmin } from "@/lib/amux/decisionMakerAdminRead";
import { countDecisionMakerAttention, readDecisionMakerAttentionForAdmin } from "@/lib/amux/decisionMakerAttention";
import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import { readAmuxWorkerCapabilitiesForAdmin } from "@/lib/amux/workerCapabilityAdminRead";
import { readAmuxWorkerRegistryForAdmin } from "@/lib/amux/workerRegistryAdminRead";
import { amuxWorkerRegistryWritesOpen } from "@/lib/amux/workerRegistryCore";
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
  if (!session?.user?.id || !isAdminSession(session)) notFound();
  const role = getAdminRole(session);
  const query = await searchParams;
  const legacy = typeof query.tab === "string" ? ADMIN_AMUX_EXECUTION_LEGACY_TABS[query.tab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  const resolved = resolveAdminTabFor(TABS, role, query.tab);
  if (!resolved) notFound();
  const { tab } = resolved;

  // One Decision Maker request as a side panel (?dmRequest=), on any tab, so
  // an operator who may judge but not see the Cards board still reaches it.
  // Its bodies are for the person who may judge it (ops:write).
  const canJudge = hasAdminPermission(session, "ops:write");
  const dmRequested = typeof query.dmRequest === "string" ? query.dmRequest : null;
  const readDmRequest = async (requestId: string): Promise<DmAdminRequestDetailView> => {
    if (!canJudge) return { kind: "restricted" };
    if (!isDmRequestId(requestId)) return { kind: "not_found" };
    const read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestDetailRead,
      (tx) => readDecisionMakerRequestDetailForAdmin(tx, requestId))
      .then((detail) => ({ detail }), () => null);
    if (read === null) return { kind: "unavailable" };
    return read.detail === null ? { kind: "not_found" } : { kind: "detail", detail: read.detail };
  };

  const [m, openAmuxEscalations, awaitingAmuxDecisionMaker, dmView] = await Promise.all([
    getAdminMessages(adminAmuxWorkspaceMessages),
    // The tabs' badges. A failed count shows no badge rather than a zero.
    countAwaitingAmuxEscalations().catch(() => null),
    countDecisionMakerAttention().catch(() => null),
    dmRequested === null ? null : readDmRequest(dmRequested),
  ]);
  const drawer = dmView === null ? null :
    <AmuxDecisionMakerRequestDrawer view={dmView} closeHref={`/admin/amux-execution?tab=${tab.id}`} />;
  const isOwner = Boolean(session?.user?.id) && role === "owner";
  const statuses: Record<string, AmuxTabStatus | undefined> = {
    // The owner may move cards in the Kanban workspace. Every command checks
    // owner authorization again; other administrators only inspect it.
    cards: isOwner ? undefined : "read_only",
    // The same permission every escalation, proposal and review route checks.
    assignment: hasAdminPermission(session, "ops:write") ? undefined : "read_only",
    // A registry change takes the owner role, the stage's code latch and a
    // recent step-up (orchestration policy version 31, sections 3 and 8).
    workers: !isOwner ? "read_only" : amuxWorkerRegistryWritesOpen() ? undefined : "behind_server_switch",
  };

  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-execution"
      tabs={TABS}
      activeTabId={tab.id}
      label="Execution sections"
      query={query}
      role={role}
      counts={{ ...EMPTY_ADMIN_NAVIGATION_COUNTS, openAmuxEscalations, awaitingAmuxDecisionMaker }}
      chips={amuxTabChips(statuses, m.status)}
    />
  );

  if (tab.id === "cards") {
    // Authorization for the section, decided here and not by the route
    // table's `viewRoles`, exactly as the page it replaced decided it.
    if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
    const [{ rows, total, limit }, usage, decisionMaker] = await Promise.all([
      listAmuxCardsForAdmin(),
      readAmuxCliUsageSummaryForAdmin().catch(() => null),
      readDecisionMakerAttentionForAdmin({ withBodies: canJudge }).catch(() => null),
    ]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {drawer}
        {process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_CARD_INTAKE_UI === "enabled" ? (
          <Link href="/admin/amux-u21-test-card" prefetch={false}
            className="w-fit text-sm font-medium underline text-blue-300">
            {m.testCardIntake}
          </Link>
        ) : null}
        <AmuxExecutionWorkspace canMoveCards={isOwner} canReviewCards={isOwner} decisionMaker={decisionMaker} initialTaskId={typeof query.taskId === "string" &&
          /^[A-Za-z0-9-]{1,128}$/.test(query.taskId) ? query.taskId : null} />
        <AmuxExecutionSupportingRecords>
          <AmuxCardListPanel rows={rows} total={total} limit={limit} />
          <AmuxCardDisplayKeyBackfillPanel />
          <AmuxCliUsagePanel view={usage} />
        </AmuxExecutionSupportingRecords>
      </div>
    );
  }

  if (tab.id === "workers") {
    // Every admin role reads the registry; only the owner is offered
    // registration, and the route decides that again. A read that fails is
    // shown as such, never as an empty registry. Capabilities (version 35,
    // R2a) sit under the registry they extend.
    const [view, capabilities] = await Promise.all([
      readAmuxWorkerRegistryForAdmin().catch(() => null),
      readAmuxWorkerCapabilitiesForAdmin().catch(() => null),
    ]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {drawer}
        <AmuxWorkerRegistryPanel view={view} isOwner={isOwner} />
        <AmuxWorkerCapabilityPanel view={capabilities} isOwner={isOwner} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {drawer}
      <AdminAmuxRoutingPanel canInspectCards={isOwner} focusEscalationId={
        typeof query.focusEscalation === "string" &&
        /^c[a-z0-9]{20,}$/i.test(query.focusEscalation) ?
          query.focusEscalation : null} />
    </div>
  );
}
