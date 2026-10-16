/**
 * Orchestration policy v52: one execution grade for each newly registered v4 Task.
 * This module is pure so intake, the runner and the app's PR observer can apply
 * the same path judgement without reading a switch or calling a model.
 */

export const AMUX_EXECUTION_GRADE_CODE_LATCH = false;

/** The sole contract-path list. Change it only with the approved policy. */
export const AMUX_CONTRACT_PATHS = [
  "lib/modelPricing.ts",
  "lib/credit",
  "lib/chatCostGuardrails.ts",
  "lib/models.ts",
  "lib/billingPriceCatalog.ts",
  "lib/planChange",
  "lib/billingPromotionAdminPolicy.ts",
  "app/api/billing/plan-change/",
  "app/api/billing/checkout/",
  "prisma/",
  "lib/conversationProduct.ts",
  "lib/email",
  "docs/policy/",
  "docs/ui-contracts/",
  "lib/amux/",
  "apps/tomverse-orchestrator/",
  ".github/",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/",
  ".codex/",
  "components/chat/ChatInput.tsx",
  "components/chat/MobileChatShell.tsx",
  "components/chat/ChatSidebar.tsx",
  "components/chat/useVisualViewport.ts",
  "components/chat/ComparisonActionRail.tsx",
  "lib/comparisonReadiness.ts",
  "lib/fonts.ts",
  "app/globals.css",
  "components/DocumentShell.tsx",
  "components/images/ImageGenerationWorkspace.tsx",
  "components/chat/NewConversationLauncher.tsx",
  "components/chat/ImageModelTabPanel.tsx",
  "components/chat/ModelPickerPanel.tsx",
  "app/(site)/(application)/chat/ChatPageClient.tsx",
  "lib/imageGroupLimits.ts",
  "components/auth/AuthButton.tsx",
  "lib/settingsNavigation.ts",
  "lib/accountSettingsEvents.ts",
  "components/settings/",
  "app/(site)/(application)/settings/imports/",
  "app/(site)/(application)/settings/memory/",
  "lib/adminNavigation.ts",
  "components/chat/AutoRoutingToggle.tsx",
  "components/chat/AutoRoutedByBadge.tsx",
  "lib/autoRoutingUi.ts",
  "lib/autoProductBoundary.ts",
  "lib/autoRoutingCopy.ts",
  "app/api/conversations/[conversationId]/route.ts",
  "lib/chatStarter",
  "components/chat/ChatStarterGallery.tsx",
  "components/chat/ChatWelcomeScreen.tsx",
  "components/chat/ReviewWorkspaceShell.tsx",
  "scripts/check-starter-catalog.mjs",
  "app/api/user/settings/route.ts",
  "lib/newConversationModels.ts",
] as const;

export type AmuxExecutionGrade = "routine" | "advanced" | "frontier";
export type AmuxExecutionPathClass = "invalid" | "contract" | "ordinary";

/** A path as stored in Git, allowing only the policy's single leading `./`. */
export const normalizeAmuxExecutionPath = (input: unknown): string | null => {
  if (typeof input !== "string" || input.length === 0 || /[\\\p{Cc}]/u.test(input)) {
    return null;
  }
  const path = input.startsWith("./") ? input.slice(2) : input;
  if (path.startsWith("/") || /(^|\/)[A-Za-z]:/.test(path)) return null;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return path;
};

/** Invalid names stay distinct from valid ordinary names for every caller. */
export const classifyAmuxExecutionPath = (input: unknown): AmuxExecutionPathClass => {
  const path = normalizeAmuxExecutionPath(input);
  if (path === null) return "invalid";
  const lowerPath = path.toLowerCase();
  return AMUX_CONTRACT_PATHS.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))
    ? "contract"
    : "ordinary";
};

export type AmuxExecutionGradeInput = {
  taskRole: string | null | undefined;
  expectedPaths: readonly unknown[] | null | undefined;
  proposedGrade: string | null | undefined;
};

/** Policy v52 §4 order; the intake proposal is only a bounded signal. */
export const deriveAmuxExecutionGrade = (input: AmuxExecutionGradeInput): AmuxExecutionGrade => {
  const { taskRole, expectedPaths, proposedGrade } = input;
  if (taskRole === "design" || !Array.isArray(expectedPaths) ||
      expectedPaths.length === 0 || expectedPaths.length > 40 ||
      expectedPaths.some((path) => classifyAmuxExecutionPath(path) !== "ordinary")) {
    return "frontier";
  }
  if (proposedGrade === "frontier") return "frontier";
  if (["implement", "test", "investigate", "verify"].includes(taskRole ?? "") &&
      expectedPaths.length <= 2 && proposedGrade === "routine") {
    return "routine";
  }
  return "advanced";
};
