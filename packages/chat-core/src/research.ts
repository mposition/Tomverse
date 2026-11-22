/**
 * Deep Research (engine v2) client state, shared by Web and Native.
 *
 * Framework-neutral: no DOM, no fetch, no React. The server is the source of
 * truth; these rules only decide which server answer a client may show:
 *
 * - a response is accepted only for the run, conversation and account the
 *   view was opened for (an old account's or conversation's late response is
 *   dropped);
 * - a response older than what the view holds (lower eventSequence) is
 *   dropped, so a late poll cannot overwrite an action's result and two
 *   devices converge on the newest state;
 * - progress is counted from real work items, never a timer, and there is no
 *   ETA.
 */

export type ResearchRunStatus =
  | "draft" | "planning" | "awaiting_input" | "queued" | "running" | "paused" | "finalizing"
  | "completed" | "failed" | "cancelled" | "attention";

export type ResearchItemCounts = Record<"queued" | "running" | "completed" | "failed" | "attention" | "blocked" | "cancelled", number>;

export type ResearchRunView = {
  id: string;
  engineVersion: 2;
  conversationId: string;
  assistantMessageId: string;
  status: string;
  stopReason?: string;
  eventSequence: number;
  inputRevision: number;
  planRevision: number;
  approvedPlanRevision: number | null;
  qualityStatus: "complete" | "partial" | "insufficient_evidence" | null;
  currentReportRevision: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  plan?: { revision: number; author: string; plan: ResearchPlanView };
  progress: {
    items: ResearchItemCounts;
    questions: Array<{ key: string; question: string; state: "pending" | "active" | "done" | "attention"; findings: number }>;
    sourcesSeen: number; sourcesRead: number; privateSources: number; openQuestions: string[];
  };
  money: { approvedCredits: number; settledCredits: number; reservedCredits: number; unknownCredits: number;
    finalizationReserveCredits: number; settlement: "settled" | "pending" | "unknown" };
  actions: { canPause: boolean; canResume: boolean; canCancel: boolean; canExtendBudget: boolean;
    canApprovePlan: boolean; canEditPlan: boolean; canRevise: boolean; canDelete: boolean; canFinish: boolean };
  budgetReached: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ResearchPlanView = {
  objective: string;
  assumptions: string[];
  clarifications: Array<{ question: string; why: string; blocking: boolean }>;
  subquestions: Array<{ key: string; question: string; rationale: string; queries: string[]; searchLanguages: string[]; sourceStrategy: string }>;
  completionCriteria: string[];
  outline: Array<{ key: string; heading: string; purpose: string; subquestionKeys: string[]; table: boolean }>;
};

export type ResearchViewScope = { runId: string; conversationId: string; accountKey: string };

const TERMINAL = new Set(["completed", "failed", "cancelled", "attention"]);

export const isResearchRunView = (value: unknown): value is ResearchRunView => {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ResearchRunView>;
  return run.engineVersion === 2 && typeof run.id === "string" && typeof run.eventSequence === "number" &&
    typeof run.status === "string" && !!run.progress && !!run.money && !!run.actions;
};

/**
 * Returns the view to show after `incoming` arrives, or `current` when the
 * incoming value is for another scope or older than what is already shown.
 */
export function acceptResearchRunUpdate(current: ResearchRunView | null, incoming: unknown, scope: ResearchViewScope): ResearchRunView | null {
  if (!isResearchRunView(incoming)) return current;
  if (incoming.id !== scope.runId || incoming.conversationId !== scope.conversationId) return current;
  if (current && (current.id !== incoming.id || incoming.eventSequence < current.eventSequence)) return current;
  return incoming;
}

/** Only real work-item counts; no percentage when nothing is planned yet. */
export function researchProgress(view: ResearchRunView) {
  const items = view.progress.items;
  const done = items.completed + items.failed + items.attention + items.cancelled;
  const total = done + items.queued + items.running + items.blocked;
  return { done, total, hasCounts: total > 0 };
}

export const researchRunIsTerminal = (status: string) => TERMINAL.has(status);

/** Poll while the server may still change the run without the user acting. */
export const researchRunNeedsPolling = (view: Pick<ResearchRunView, "status" | "money">) =>
  !TERMINAL.has(view.status) && !["draft", "awaiting_input", "paused"].includes(view.status) || view.money.settlement === "pending";

export type ResearchStatusKey = "statusDraft" | "statusPlanning" | "statusAwaiting" | "statusQueued" | "statusRunning" | "statusPaused" |
  "statusFinalizing" | "statusCompleted" | "statusFailed" | "statusCancelled" | "statusAttention";

export function researchStatusKey(status: string): ResearchStatusKey {
  switch (status) {
    case "draft": return "statusDraft";
    case "planning": return "statusPlanning";
    case "awaiting_input": return "statusAwaiting";
    case "queued": return "statusQueued";
    case "running": return "statusRunning";
    case "paused": return "statusPaused";
    case "finalizing": return "statusFinalizing";
    case "completed": return "statusCompleted";
    case "cancelled": return "statusCancelled";
    case "attention": return "statusAttention";
    default: return "statusFailed";
  }
}

/** Fills `{name}` placeholders from a copy string. */
export const formatResearchCopy = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/gu, (match, key: string) => (key in values ? String(values[key]) : match));

/** A stable idempotency pair for one Deep Research start; reuse it when retrying a lost create. */
export const researchStartIds = (randomUuid: () => string) => ({ userMessageId: randomUuid(), assistantMessageId: randomUuid() });
