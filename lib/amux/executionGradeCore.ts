/**
 * Orchestration policy v52: one execution grade for each newly registered v4 Task.
 * This module is pure so intake, the runner and the app's PR observer can apply
 * the same path judgement without reading a switch or calling a model.
 */

export const AMUX_EXECUTION_GRADE_CODE_LATCH = false;
export const AMUX_EXECUTION_GRADE_ENV = "TOMVERSE_AMUX_EXECUTION_GRADE";

export const amuxExecutionGradeRoutingOpen = (codeLatch: boolean,
  value: string | undefined) => codeLatch && value === "enabled";

export const amuxExecutionGradeRoutingEnabled = (value: string | undefined) =>
  amuxExecutionGradeRoutingOpen(AMUX_EXECUTION_GRADE_CODE_LATCH, value);

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

export const AMUX_EXECUTION_GRADE_WORKER_ROLE = {
  routine: "chore",
  advanced: "implementation",
  frontier: "contract",
} as const;

export const amuxWorkerRoleForExecutionGrade = (grade: unknown):
  (typeof AMUX_EXECUTION_GRADE_WORKER_ROLE)[AmuxExecutionGrade] | null =>
  typeof grade === "string" &&
  Object.hasOwn(AMUX_EXECUTION_GRADE_WORKER_ROLE, grade) ?
    AMUX_EXECUTION_GRADE_WORKER_ROLE[grade as AmuxExecutionGrade] : null;

export const amuxWorkerMatchesExecutionGrade = (grade: unknown,
  workerName: string,
  workerGrades: ReadonlyMap<string, string> | null): boolean => {
  const requiredRole = amuxWorkerRoleForExecutionGrade(grade);
  return requiredRole !== null &&
    workerGrades?.get(workerName) === requiredRole;
};

/** Only v20-or-later intake confirmations opt a Task into v52 routing. */
export const isAmuxV52TaskConfirmation = (value: unknown, grade: unknown):
  grade is AmuxExecutionGrade => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !amuxWorkerRoleForExecutionGrade(grade)) return false;
  const snapshot = value as Record<string, unknown>;
  const match = typeof snapshot.policyVersion === "string" ?
    /^amux-intake-v(\d+)$/.exec(snapshot.policyVersion) : null;
  if (!match || Number(match[1]) < 20) return false;
  const card = snapshot.card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return false;
  const task = (card as Record<string, unknown>).task;
  return !!task && typeof task === "object" && !Array.isArray(task) &&
    (task as Record<string, unknown>).grade === grade;
};

/** A path as stored in Git, allowing only the policy's single leading `./`. */
export const normalizeAmuxExecutionPath = (input: unknown): string | null => {
  if (typeof input !== "string" || input.length === 0 || /[\\\p{Cc}\p{Cf}]/u.test(input)) {
    return null;
  }
  const path = input.startsWith("./") ? input.slice(2) : input;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || /\/[A-Za-z]:(?:\/|$)/.test(path)) {
    return null;
  }
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

export type AmuxV52PathDecision = "pass" | "blocked" | "escalate";

/** A missing inventory is unknown, never an empty inventory. */
export const decideAmuxV52ChangedPaths = (grade: unknown,
  changedPaths: unknown): AmuxV52PathDecision => {
  if (!amuxWorkerRoleForExecutionGrade(grade) ||
      !Array.isArray(changedPaths)) return "blocked";
  let contract = false;
  for (const path of changedPaths) {
    const kind = classifyAmuxExecutionPath(path);
    if (kind === "invalid") return "blocked";
    if (kind === "contract") contract = true;
  }
  return contract && grade !== "frontier" ? "escalate" : "pass";
};

/** A publish candidate must be covered by the runner's complete path inventory. */
export const decideAmuxV52SettlementPaths = (grade: unknown,
  changedPaths: unknown, publishFiles: readonly { path: string }[] | null):
  AmuxV52PathDecision => {
  const reported = decideAmuxV52ChangedPaths(grade, changedPaths);
  if (reported === "blocked" || !publishFiles?.length) return reported;
  const names = changedPaths as string[];
  const missing = publishFiles.map((file) => file.path)
    .filter((path) => !names.includes(path));
  return missing.length === 0 ? reported : "blocked";
};

export type AmuxExecutionGradeInput = {
  taskRole: string | null | undefined;
  expectedPaths: readonly unknown[] | null | undefined;
  proposedGrade: string | null | undefined;
};

/** docs/policy/development-agent-orchestration.md v52 §4 order; the intake proposal is only a bounded signal. */
export const deriveAmuxExecutionGrade = (input: AmuxExecutionGradeInput): AmuxExecutionGrade => {
  const { taskRole, expectedPaths, proposedGrade } = input;
  if (taskRole === "design" || !Array.isArray(expectedPaths) ||
      expectedPaths.length === 0 || expectedPaths.length > 40) {
    return "frontier";
  }
  // Unlike Array#some, iteration also visits missing slots as undefined.
  for (const path of expectedPaths) {
    if (classifyAmuxExecutionPath(path) !== "ordinary") return "frontier";
  }
  if (proposedGrade === "frontier") return "frontier";
  if (["implement", "test", "investigate", "verify"].includes(taskRole ?? "") &&
      expectedPaths.length <= 2 && proposedGrade === "routine") {
    return "routine";
  }
  return "advanced";
};
