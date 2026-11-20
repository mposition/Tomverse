export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxBacklogListPanel } from "@/components/admin/AmuxBacklogListPanel";
import { AmuxIdeaInputPanel } from "@/components/admin/AmuxIdeaInputPanel";
import { AmuxIdeaInbox, AmuxIdeaProgressPanel } from "@/components/admin/AmuxIdeaProgressPanel";
import { AmuxIdeaDetailSummary } from "@/components/admin/AmuxIdeaDetailSummary";
import { AmuxAnalysisClaimResolutionPanel } from
  "@/components/admin/AmuxAnalysisClaimResolutionPanel";
import { amuxAnalysisClaimRecoveryHoldId } from
  "@/lib/amux/ideaAnalysisClaimRecoveryCore";
import { AmuxPortfolioPanel } from "@/components/admin/AmuxPortfolioPanel";
import { AMUX_ANALYSIS_TRANSLATION_ENV, amuxAnalysisTranslationEnabled } from
  "@/lib/amux/ideaAnalysisTranslationCore";
import { amuxIdeaLaneEnabled } from "@/lib/amux/ideaLaneCore";
import { getAdminRole } from "@/lib/adminAuth";
import { hasRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { amuxBacklogPage, amuxBacklogSearch } from "@/lib/amux/adminBacklogListCore";
import { listAmuxCardsForAdmin } from "@/lib/amux/adminCardList";
import { readAmuxBacklogList } from "@/lib/amux/adminBacklogRead";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import {
  ADMIN_AMUX_BACKLOG_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
} from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { readAmuxIdeaProgressForOwner } from "@/lib/amux/ideaProgressRead";
import { amuxIdeaProgressFailureLog } from "@/lib/amux/ideaProgressCore";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaRequestIdCore";

const TABS = adminNavItemTabs("amux-backlog");

/**
 * The AMUX backlog: what enters it and what is recorded about each card.
 *
 * Ideas, the card list and the portfolio assessment. Import, reconciliation and
 * metadata moved to Safety & recovery › Legacy tools (2026-11-07), and the
 * retired JSON intake UI redirects to Ideas, which performs an input check and
 * has an independently gated submission path. Neither action collects GitHub
 * content or authorizes external transfer.
 * Only the open section is rendered.
 *
 * Owner-only exactly as each screen was: the route table's `viewRoles` keeps
 * the entry out of other roles' navigation, and this check -- not the table --
 * is what refuses them.
 */
export default async function AdminAmuxBacklogPage({
  searchParams,
}: PageProps<"/admin/amux-backlog">) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner") notFound();
  const role = getAdminRole(session);
  const query = await searchParams;
  const requestedTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  // Retired sections keep their addresses (Admin IA redirect rule): legacy
  // intake opens Ideas; import, reconciliation and metadata are Legacy tools,
  // and Cleanup and recovery -- whose one panel became the release button on
  // an idea's detail (operator decision 2026-11-06) -- opens Reservations &
  // claims, both in Safety & recovery.
  const legacy = requestedTab === undefined ? undefined : ADMIN_AMUX_BACKLOG_LEGACY_TABS[requestedTab];
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  // Expiration of a transfer preview must not hide recovery of its paid claim.
  // This mounts the existing exact-ID GET/owner decision panel; it does not
  // reconstruct a preview, reserve a budget or dispatch an analysis.
  const recoveryHoldId = amuxAnalysisClaimRecoveryHoldId(query.analysisHoldId);
  const tab = resolveAdminTab(TABS, query.tab);
  const search = amuxBacklogSearch(query.cardNumber);
  const backlogList = tab.id === "list" && search.valid && hasRecentAdminAuthentication(session)
    ? await readAmuxBacklogList(search.search, amuxBacklogPage(query.page)) : null;
  // The whole board's counts, and the kind, priority and state of the page's
  // own cards, only once the paged list itself was readable. A failed read is
  // drawn as unavailable, never as zero.
  const cardSummary = backlogList === null ? null : await listAmuxCardsForAdmin({ ids: backlogList.rows.map((row) => row.id) }).then((read) => ({
    total: read.total,
    statusCounts: read.statusCounts,
    cards: read.rows.map(({ id, status, kind, priority }) => ({ id, status, kind, priority })),
  })).catch((error: unknown) => {
    console.warn(JSON.stringify({ subsystem: "amux", event: "backlog_card_summary_read_failed",
      name: error instanceof Error ? error.name : null }));
    return null;
  });
  const ideaMessages = await getAdminMessages(adminAmuxIdeaProgressMessages);
  // Ideas: the decide-now inbox and the progress list read the same snapshot,
  // A failed read is shown as unavailable (null), never as an empty list.
  // Like the card list, it needs a recent owner sign-in (the idea read-back
  // route asks for the same).
  const requestedIdea = typeof query.idea === "string" ? query.idea.trim().toLowerCase() : "";
  const openRequestId = isAmuxIdeaRequestId(requestedIdea) ? requestedIdea : null;
  let ideaProgress: AmuxIdeaProgressRow[] | null | "reauthenticate" | undefined;
  if (tab.id === "ideas" && !hasRecentAdminAuthentication(session)) {
    ideaProgress = "reauthenticate";
  } else if (tab.id === "ideas") {
    ideaProgress = await readAmuxIdeaProgressForOwner(session.user.id, openRequestId).catch((error: unknown) => {
      // Codes and class names only (never a message or a row), so a failure can be told apart.
      console.warn(JSON.stringify(amuxIdeaProgressFailureLog(error)));
      return null;
    });
  }
  // An opened idea leads with its own detail (redesign B3); the list returns
  // below the flow, so the page shows one idea at a time.
  const openedIdea = Array.isArray(ideaProgress) && openRequestId
    ? ideaProgress.find((row) => row.requestId === openRequestId) ?? null : null;

  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-backlog"
      tabs={TABS}
      activeTabId={tab.id}
      label="Backlog sections"
      query={query}
      role={role}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {tab.id === "list" ? (
        <AmuxBacklogListPanel data={backlogList} search={search.search} valid={search.valid} summary={cardSummary} />
      ) : tab.id === "ideas" ? (
        <>
        {recoveryHoldId ? <AmuxAnalysisClaimResolutionPanel
          key={recoveryHoldId} holdId={recoveryHoldId} /> : null}
        {openedIdea ? <AmuxIdeaDetailSummary row={openedIdea} reservationReleaseAvailable={
          process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE === "enabled"} /> : null}
        {/* Ideas main (approved v49 mockup): "Decide now" on top at full width, then the
            input beside the list of ideas in progress. An opened idea leads with its
            detail and its flow; the inbox and the list follow it. */}
        {!openedIdea ? <p className="max-w-3xl text-sm text-zinc-300" data-testid="amux-ideas-lede">{ideaMessages.lede}</p> : null}
        {ideaProgress !== undefined && !openedIdea ? <AmuxIdeaInbox rows={ideaProgress} /> : null}
        <AmuxIdeaInputPanel key={openRequestId ?? "new"} openRequestId={openRequestId}
          openedStage={openedIdea?.stage ?? null}
          progressRows={openedIdea ? undefined : ideaProgress}
          analysisTranslationAvailable={amuxAnalysisTranslationEnabled(
            process.env[AMUX_ANALYSIS_TRANSLATION_ENV])}
          analysisBudgetAvailable={
            process.env.TOMVERSE_AMUX_V4_ANALYSIS_PRICE_WRITE === "enabled" &&
            process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE === "enabled"}
          laneAvailable={amuxIdeaLaneEnabled()}
          operatorId={session.user.id} />
        {openedIdea && ideaProgress !== undefined ? <AmuxIdeaProgressPanel rows={ideaProgress}
          activeRequestId={openRequestId} /> : null}
        </>
      ) : tab.id === "portfolio" ? (
        <AmuxPortfolioPanel />
      ) : null}
    </div>
  );
}
