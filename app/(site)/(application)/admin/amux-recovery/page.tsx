export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxAnalysisClaimResolutionPanel } from "@/components/admin/AmuxAnalysisClaimResolutionPanel";
import { AmuxBacklogMetadataPanel } from "@/components/admin/AmuxBacklogMetadataPanel";
import { AmuxBoardAutoPromotionPanel } from "@/components/admin/AmuxBoardAutoPromotionPanel";
import { AmuxBoardImportPanel } from "@/components/admin/AmuxBoardImportPanel";
import { AmuxBoardPromotionPanel } from "@/components/admin/AmuxBoardPromotionPanel";
import { AmuxBoardRecommendationPanel } from "@/components/admin/AmuxBoardRecommendationPanel";
import { AmuxLegacyToolSection } from "@/components/admin/AmuxLegacyToolSection";
import { AmuxOrchestratorHaltsPanel } from "@/components/admin/AmuxOrchestratorHaltsPanel";
import { AmuxReconciliationPanel } from "@/components/admin/AmuxReconciliationPanel";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { amuxSwitchedTabStatuses, amuxTabChips } from "@/lib/adminAmuxTabStatus";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { adminNavItemTabs, resolveAdminTabFor } from "@/lib/adminNavigation";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "@/lib/adminNavigationCounts";
import { amuxAnalysisClaimRecoveryHoldId } from "@/lib/amux/ideaAnalysisClaimRecoveryCore";
import {
  AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
  AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
  countOpenAmuxOrchestratorHalts,
  readAmuxOrchestratorHaltsForAdmin,
} from "@/lib/amux/orchestratorHaltStore";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("amux-recovery");

/** The retired tools, in the order their old pages listed them. */
const LEGACY_SECTIONS = [
  "import",
  "reconciliation",
  "metadata",
  "recommendation",
  "promotion",
  "auto-promotion",
] as const;

/**
 * Safety & recovery: execution halts, unused reservations and claims, and the
 * AMUX tools the idea flow retired.
 *
 * Execution safety was a section of Operations settings and keeps its panel,
 * its role rules and its step-up return exactly as they were: every admin role
 * reads it, the owner alone clears a halt. Legacy tools gathers the Catalog
 * import, Source reconciliation and Card metadata screens (once Backlog tabs)
 * and the three Promotion screens (once their own page); each is the panel it
 * was, behind the same switch and the same owner check, so retiring
 * them from the menu neither deletes data nor grants execution.
 *
 * Only the open tab is read. A section a role may not open is a 404, never a
 * different section.
 */
export default async function AdminAmuxRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) notFound();
  const role = getAdminRole(session);
  const query = await searchParams;
  const resolved = resolveAdminTabFor(TABS, role, query.tab);
  if (!resolved) notFound();
  const { tab } = resolved;
  const [m, screens, openAmuxOrchestratorHalts] = await Promise.all([
    getAdminMessages(adminAmuxWorkspaceMessages),
    getAdminMessages(adminAmuxScreensMessages),
    countOpenAmuxOrchestratorHalts().catch(() => null),
  ]);
  const isOwner = role === "owner";
  const legacyStatuses = amuxSwitchedTabStatuses(LEGACY_SECTIONS);
  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-recovery"
      tabs={TABS}
      activeTabId={tab.id}
      label="Safety and recovery sections"
      query={query}
      role={role}
      counts={{ ...EMPTY_ADMIN_NAVIGATION_COUNTS, openAmuxOrchestratorHalts }}
      chips={amuxTabChips({ safety: isOwner ? undefined : "read_only" }, m.status)}
    />
  );

  if (tab.id === "legacy") {
    // Owner only, as every one of these screens was.
    if (!isOwner) notFound();
    const chips = amuxTabChips(legacyStatuses, m.status);
    const panels = {
      import: <AmuxBoardImportPanel />,
      reconciliation: <AmuxReconciliationPanel />,
      metadata: <AmuxBacklogMetadataPanel />,
      recommendation: <AmuxBoardRecommendationPanel />,
      promotion: <AmuxBoardPromotionPanel />,
      "auto-promotion": <AmuxBoardAutoPromotionPanel />,
    } as const;
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminTile title={screens.safety.legacyTitle} description={m.legacy.intro} data-testid="amux-legacy-intro" />
        {LEGACY_SECTIONS.map((id) => (
          <AmuxLegacyToolSection
            key={id}
            id={`amux-legacy-${id}`}
            title={m.legacy.sections[id]}
            chip={chips[id]?.label}
            attention={chips[id]?.attention}
          >
            {panels[id]}
          </AmuxLegacyToolSection>
        ))}
      </div>
    );
  }

  if (tab.id === "reservations") {
    // Owner only (the tab's viewRoles); resolveAdminTabFor has already refused
    // other roles, and this refuses again before anything is read.
    if (!isOwner) notFound();
    // Expiration of a transfer preview must not hide recovery of its paid
    // claim: the exact-ID GET/owner decision panel mounts on its own link. It
    // does not reconstruct a preview, reserve a budget or dispatch an analysis.
    const holdId = amuxAnalysisClaimRecoveryHoldId(
      query.analysisHoldId,
      process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ
    );
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {holdId ? <AmuxAnalysisClaimResolutionPanel key={holdId} holdId={holdId} /> : null}
        <AdminStateBlock kind="empty" title={m.reservations.title} detail={m.reservations.detail} />
      </div>
    );
  }

  const view = await readAmuxOrchestratorHaltsForAdmin().catch(() => null);
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
