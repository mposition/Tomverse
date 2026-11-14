export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AmuxOwnerQueueScreen } from "@/components/admin/AmuxOwnerQueueScreen";
import { AmuxCliUsagePanel } from "@/components/admin/AmuxCliUsagePanel";
import { AmuxDiagnosticsPanel } from "@/components/admin/AmuxDiagnosticsPanel";
import { AmuxExecutionWorkspace } from "@/components/admin/AmuxExecutionWorkspace";
import { AmuxIncidentBand } from "@/components/admin/AmuxIncidentBand";
import { AmuxDecisionMakerRequestDrawer } from "@/components/admin/AmuxDecisionMakerRequestDrawer";
import type { DmAdminRequestDetailView } from "@/components/admin/AmuxDecisionMakerRequestDetailPanel";
import { amuxTabChips, type AmuxTabStatus } from "@/lib/adminAmuxTabStatus";
import { getAdminRole, hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { ADMIN_AMUX_EXECUTION_LEGACY_TABS, adminRedirectTarget, adminNavItemTabs, resolveAdminTabFor } from "@/lib/adminNavigation";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "@/lib/adminNavigationCounts";
import { readBoardWorkerChannels } from "@/lib/amux/adminBoardWorkerChannels";
import { readAmuxIncidentBandState } from "@/lib/amux/adminIncidentRead";
import { listAmuxCardsForExecutionList } from "@/lib/amux/adminExecutionCardList";
import { countAmuxOwnerQueue, readAmuxOwnerQueue } from "@/lib/amux/adminOwnerQueueRead";
import { amuxOwnerQueueGroupCounts } from "@/lib/amux/ownerQueueCore";
import { readAmuxCliUsageSummaryForAdmin } from "@/lib/amux/adminCliUsageSummary";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerRequestDetailForAdmin } from "@/lib/amux/decisionMakerAdminRead";
import { countDecisionMakerAttention, readDecisionMakerAttentionForAdmin } from "@/lib/amux/decisionMakerAttention";
import { isDmRequestId } from "@/lib/amux/decisionMakerRequestCore";
import { readAmuxIdeaLaneBoardForOwner } from "@/lib/amux/ideaLaneBoardRead";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("amux-execution");

/**
 * What AMUX is running: the board of cards and why each was assigned where it
 * was.
 *
 * The board (`?tab=cards`) is the owner-only list that used to live at
 * `/admin/amux-cards`, drawn as a board, a list and a hierarchy. The review
 * queue (`?tab=review`, once Assignment) is the panel that used to sit on
 * `/admin/routing` beside Chat shadow routing; it opens to every admin role, as
 * it did there, and its decisions still take `ops:write` in every route they
 * call. Diagnostics holds what the review queue used to show beside it (incident
 * mode, the active queue, the planning limits, why work went to each worker, how
 * each worker did) and the worker usage coverage, which is the owner's. While
 * incident mode stops admission a red band runs across the top of all three.
 *
 * The owner opens on the board and everyone else on the review queue, because
 * each opens on the first section they may see. A non-owner who names
 * `?tab=cards` gets a 404 rather than the review queue in its place, which is
 * what the old address answered them.
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

  const [m, views, awaitingAmuxOwnerQueue, awaitingAmuxDecisionMaker, dmView, incident] = await Promise.all([
    getAdminMessages(adminAmuxWorkspaceMessages),
    getAdminMessages(adminAmuxBoardViewsMessages),
    // The tabs' badges. A failed count shows no badge rather than a zero.
    countAmuxOwnerQueue().catch(() => null),
    countDecisionMakerAttention().catch(() => null),
    dmRequested === null ? null : readDmRequest(dmRequested),
    // The incident band on every tab. null: the read failed, which the band says.
    readAmuxIncidentBandState(),
  ]);
  const drawer = dmView === null ? null :
    <AmuxDecisionMakerRequestDrawer view={dmView} closeHref={`/admin/amux-execution?tab=${tab.id}`} />;
  const isOwner = Boolean(session?.user?.id) && role === "owner";
  const statuses: Record<string, AmuxTabStatus | undefined> = {
    // The owner may move cards in the Kanban workspace. Every command checks
    // owner authorization again; other administrators only inspect it.
    cards: isOwner ? undefined : "read_only",
    // The same permission every escalation, proposal and review route checks.
    review: hasAdminPermission(session, "ops:write") ? undefined : "read_only",
  };

  // The incident band runs above the tab strip, so every tab shows it without each branch drawing it.
  const tabs = (
    <>
      <AmuxIncidentBand state={incident} />
      <AdminPageTabs
        basePath="/admin/amux-execution"
        tabs={TABS}
        activeTabId={tab.id}
        label="Execution board sections"
        query={query}
        role={role}
        counts={{ ...EMPTY_ADMIN_NAVIGATION_COUNTS, awaitingAmuxOwnerQueue, awaitingAmuxDecisionMaker }}
        chips={amuxTabChips(statuses, m.status)}
      />
    </>
  );

  if (tab.id === "cards") {
    // Authorization for the section, decided here and not by the route
    // table's `viewRoles`, exactly as the page it replaced decided it.
    if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
    const [cardList, decisionMaker, laneIdeas, workerChannels, ownerQueueRead] = await Promise.all([
      // The List view's rows. A failed read shows that view's error, never an empty table.
      listAmuxCardsForExecutionList().catch(() => null),
      readDecisionMakerAttentionForAdmin({ withBodies: canJudge }).catch(() => null),
      // Display rows beside the cards; a failed read shows none (the Ideas tab has them).
      readAmuxIdeaLaneBoardForOwner(session.user.id).catch(() => null),
      // The channel of each card's worker is the class it was registered with; unread: no badges.
      readBoardWorkerChannels(),
      // The "Waiting on me" column counts the tab's own queue; a failed read falls back to the loaded cards.
      readAmuxOwnerQueue().catch(() => null),
    ]);
    const ownerQueue = ownerQueueRead === null ? null : {
      total: ownerQueueRead.total,
      groups: amuxOwnerQueueGroupCounts(ownerQueueRead.items),
      partial: ownerQueueRead.items.length < ownerQueueRead.total,
    };
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
        <AmuxExecutionWorkspace canMoveCards={isOwner} canReviewCards={isOwner} decisionMaker={decisionMaker} laneIdeas={laneIdeas}
          workerChannels={workerChannels} cardList={cardList} ownerQueue={ownerQueue} initialTaskId={typeof query.taskId === "string" &&
          /^[A-Za-z0-9-]{1,128}$/.test(query.taskId) ? query.taskId : null} />
      </div>
    );
  }

  if (tab.id === "diagnostics") {
    // The usage coverage lists estimated API costs, which only the owner saw (it sat in the owner's board).
    const [usage, workerChannels] = await Promise.all([
      isOwner ? readAmuxCliUsageSummaryForAdmin().catch(() => null) : undefined,
      readBoardWorkerChannels(),
    ]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {drawer}
        {usage === undefined ?
          <AdminTile title={views.usage.ownerOnlyTitle} description={views.usage.ownerOnlyDetail}
            data-testid="amux-usage-owner-only" /> :
          <AmuxCliUsagePanel view={usage} workerChannels={workerChannels} />}
        <AmuxDiagnosticsPanel workerChannels={workerChannels} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {drawer}
      <AmuxOwnerQueueScreen canInspectCards={isOwner} focusEscalationId={
        typeof query.focusEscalation === "string" &&
        /^c[a-z0-9]{20,}$/i.test(query.focusEscalation) ?
          query.focusEscalation : null}
        canWriteEngineering={hasAdminPermission(session, "engineering-agent:write")}
        canAskDecisionMaker={canJudge} />
    </div>
  );
}
