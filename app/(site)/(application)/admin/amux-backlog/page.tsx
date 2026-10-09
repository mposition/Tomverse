export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AmuxBacklogMetadataPanel } from "@/components/admin/AmuxBacklogMetadataPanel";
import { AmuxBoardImportPanel } from "@/components/admin/AmuxBoardImportPanel";
import { AmuxIntakePanel } from "@/components/admin/AmuxIntakePanel";
import { AmuxIdeaInputPanel } from "@/components/admin/AmuxIdeaInputPanel";
import { AmuxAnalysisClaimResolutionPanel } from
  "@/components/admin/AmuxAnalysisClaimResolutionPanel";
import { amuxAnalysisClaimRecoveryHoldId } from
  "@/lib/amux/ideaAnalysisClaimRecoveryCore";
import { AmuxTaskCostCatalogApprovalPanel } from
  "@/components/admin/AmuxTaskCostCatalogApprovalPanel";
import { AmuxPortfolioPanel } from "@/components/admin/AmuxPortfolioPanel";
import { AmuxLocalIntakePanel } from "@/components/admin/AmuxLocalIntakePanel";
import { AmuxReconciliationPanel } from "@/components/admin/AmuxReconciliationPanel";
import { amuxSwitchedTabStatuses, amuxTabChips } from "@/lib/adminAmuxTabStatus";
import {
  AMUX_V4_IDEA_READBACK_ENV,
  AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionReadBackPermitted,
  ideaSubmissionWritePermitted,
} from "@/lib/amux/ideaSubmissionCore";
import {
  AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV,
  sourceScopePreviewPermitted,
} from "@/lib/amux/ideaSourceScopePreviewCore";
import {
  AMUX_V4_INITIAL_PLAN_READBACK_ENV,
  AMUX_V4_INITIAL_PLAN_WRITE_ENV,
  initialPlanReadbackPermitted,
  initialPlanWritePermitted,
} from "@/lib/amux/ideaInitialSourcePlanCore";
import {
  AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  AMUX_V4_FRONTIER_CATALOG_WRITE_ENV,
  frontierCatalogReadPermitted,
  frontierCatalogWritePermitted,
} from "@/lib/amux/ideaFrontierCatalogWriteCore";
import {
  AMUX_V4_TRANSFER_PREVIEW_READ_ENV,
  AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV,
  transferPreviewReadPermitted,
  transferPreviewWritePermitted,
} from "@/lib/amux/ideaTransferPreviewInputCore";
import {
  AMUX_V4_TRANSFER_CONFIRM_READ_ENV,
  AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV,
  transferConfirmReadPermitted,
  transferConfirmWritePermitted,
} from "@/lib/amux/ideaTransferConfirmationCore";
import {
  AMUX_V4_ANALYSIS_RESULT_READ_ENV,
  amuxV4AnalysisResultReadEnabled,
} from "@/lib/amux/ideaAnalysisResultReadCore";
import { getAdminRole } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_TASK_CATALOG_WRITE_ENV,
  amuxV4TaskCatalogWriteEnabled } from
  "@/lib/amux/v4TaskCostCatalogApprovalService";
import { AMUX_V4_PORTFOLIO_WRITE_ENV,
  amuxV4PortfolioWriteEnabled } from
  "@/lib/amux/portfolioAssessmentService";

const TABS = adminNavItemTabs("amux-backlog");

/**
 * The AMUX backlog: what enters it and what is recorded about each card.
 *
 * The original four owner-only sections used to be unlisted routes
 * (`/admin/amux-intake`, `/admin/amux-board-import`,
 * `/admin/amux-reconciliation`, `/admin/amux-backlog-metadata`), each now a
 * section. The separate Ideas section performs an input check and has an
 * independently gated submission path. Neither action collects GitHub
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
  // Expiration of a transfer preview must not hide recovery of its paid claim.
  // This mounts the existing exact-ID GET/owner decision panel; it does not
  // reconstruct a preview, reserve a budget or dispatch an analysis.
  const recoveryHoldId = amuxAnalysisClaimRecoveryHoldId(query.analysisHoldId,
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ);
  const tab = resolveAdminTab(TABS, query.tab);
  const m = await getAdminMessages(adminAmuxWorkspaceMessages);
  const ideaSubmissionAvailable =
    ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) &&
    ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV]);
  const sourceScopePreviewAvailable = sourceScopePreviewPermitted(
    process.env[AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV]);
  const initialPlanAvailable = initialPlanWritePermitted(process.env[AMUX_V4_INITIAL_PLAN_WRITE_ENV]) &&
    initialPlanReadbackPermitted(process.env[AMUX_V4_INITIAL_PLAN_READBACK_ENV]);
  const frontierModelsAvailable = frontierCatalogReadPermitted(
    process.env[AMUX_V4_FRONTIER_CATALOG_READ_ENV]);
  const frontierModelWriteAvailable = frontierModelsAvailable && frontierCatalogWritePermitted(
    process.env[AMUX_V4_FRONTIER_CATALOG_WRITE_ENV]);
  const transferPreviewAvailable = initialPlanAvailable && frontierModelsAvailable &&
    transferPreviewWritePermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV]) &&
    transferPreviewReadPermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_READ_ENV]);
  const transferConfirmAvailable = transferPreviewAvailable &&
    transferConfirmWritePermitted(process.env[AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV]) &&
    transferConfirmReadPermitted(process.env[AMUX_V4_TRANSFER_CONFIRM_READ_ENV]);
  const chips = amuxTabChips(
    { ...amuxSwitchedTabStatuses(["intake", "import", "reconciliation", "metadata"]),
      ideas: ideaSubmissionAvailable ? "server_switch_on" : "read_only" },
    m.status
  );

  const tabs = (
    <AdminPageTabs
      basePath="/admin/amux-backlog"
      tabs={TABS}
      activeTabId={tab.id}
      label="Backlog sections"
      query={query}
      role={role}
      chips={chips}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      {tab.id === "ideas" ? (
        <>
        {recoveryHoldId ? <AmuxAnalysisClaimResolutionPanel
          key={recoveryHoldId} holdId={recoveryHoldId} /> : null}
        <AmuxTaskCostCatalogApprovalPanel approvalAvailable={
          amuxV4TaskCatalogWriteEnabled(process.env[AMUX_V4_TASK_CATALOG_WRITE_ENV])} />
        <AmuxPortfolioPanel writeAvailable={amuxV4PortfolioWriteEnabled(
          process.env[AMUX_V4_PORTFOLIO_WRITE_ENV])} />
        <AmuxIdeaInputPanel submissionAvailable={ideaSubmissionAvailable}
          sourceScopePreviewAvailable={sourceScopePreviewAvailable}
          initialPlanAvailable={initialPlanAvailable}
          frontierModelsAvailable={frontierModelsAvailable}
          frontierModelWriteAvailable={frontierModelWriteAvailable}
          transferPreviewAvailable={transferPreviewAvailable}
          transferConfirmAvailable={transferConfirmAvailable}
          analysisResultAvailable={amuxV4AnalysisResultReadEnabled(
            process.env[AMUX_V4_ANALYSIS_RESULT_READ_ENV])}
          analysisBudgetAvailable={transferConfirmAvailable &&
            process.env.TOMVERSE_AMUX_V4_ANALYSIS_PRICE_READ === "enabled" &&
            process.env.TOMVERSE_AMUX_V4_ANALYSIS_PRICE_WRITE === "enabled" &&
            process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ === "enabled" &&
            process.env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE === "enabled"}
          operatorId={session.user.id} />
        </>
      ) : tab.id === "import" ? (
        <AmuxBoardImportPanel />
      ) : tab.id === "reconciliation" ? (
        <AmuxReconciliationPanel />
      ) : tab.id === "metadata" ? (
        <AmuxBacklogMetadataPanel />
      ) : (
        <>
          <AmuxIntakePanel />
          <AmuxLocalIntakePanel />
        </>
      )}
    </div>
  );
}
