// Single source of truth for "can these answers be compared yet, and against
// how many of them". Both shells (desktop and mobile) used to recompute the
// same three counts inline and then disagree about what to *say* about them:
// the button was gated on `readyForCompareCount >= 2` but the only explanation
// a user ever got was a `title` on a disabled button. Deriving it once means
// the rail's visibility, its status sentence, each action's accessible name
// and the disabled reason can never drift apart.

/** Mirrors the per-panel runtime status reported by ChatApp. */
export type ComparisonModelStatus =
  | "idle"
  | "loading"
  | "responding"
  | "error"
  | "cancelled"
  | "paused";

export type ComparisonReadinessState =
  /** Fewer than two comparable models, or no saved conversation: nothing to offer. */
  | "hidden"
  /** Nothing has finished yet but at least one model is still working. */
  | "generating"
  /** Everything settled, but fewer than two usable answers came out of it. */
  | "needsMore"
  /** Two or more completed answers: both actions can run. */
  | "ready";

export type ComparisonReadiness = {
  /** Selected models that are not paused -- the population a comparison draws from. */
  comparableCount: number;
  /** Comparable models with a finished, non-error, non-cancelled answer. */
  readyCount: number;
  /** Comparable models still loading or streaming. */
  generatingCount: number;
  /** Comparable models whose latest answer failed or was stopped. */
  excludedCount: number;
  state: ComparisonReadinessState;
  isVisible: boolean;
  /** True only when an action may actually be dispatched right now. */
  canRun: boolean;
  /**
   * Why `canRun` is false, as a stable token the copy layer maps to a
   * sentence. `null` when the actions are runnable.
   */
  blockedReason: "generating" | "needsMore" | "busy" | "insufficientCredits" | null;
};

export type ComparisonReadinessInput = {
  selectedModelIds: readonly string[];
  disabledModelIds: readonly string[];
  modelStatuses: Readonly<Record<string, ComparisonModelStatus | undefined>>;
  /**
   * The rail belongs to a real, saved conversation with content -- a brand new
   * or empty chat has nothing to compare regardless of model count.
   */
  hasComparableConversation: boolean;
  /** A comparison request is already in flight; prevents a duplicate run. */
  isBusy?: boolean;
  /** Known-insufficient credit balance, surfaced as its own blocked reason. */
  hasInsufficientCredits?: boolean;
};

const MINIMUM_COMPARABLE_ANSWERS = 2;

export function deriveComparisonReadiness({
  selectedModelIds,
  disabledModelIds,
  modelStatuses,
  hasComparableConversation,
  isBusy = false,
  hasInsufficientCredits = false,
}: ComparisonReadinessInput): ComparisonReadiness {
  const comparable = selectedModelIds.filter(
    (modelId) => !disabledModelIds.includes(modelId)
  );
  const comparableCount = comparable.length;

  let readyCount = 0;
  let generatingCount = 0;
  let excludedCount = 0;
  for (const modelId of comparable) {
    const status = modelStatuses[modelId];
    if (status === "idle") readyCount += 1;
    else if (status === "loading" || status === "responding") generatingCount += 1;
    else if (status === "error" || status === "cancelled") excludedCount += 1;
  }

  // "0 of 3, and nothing on its way" is not a disabled state worth showing --
  // it is a rail with nothing to act on, so it stays out of the layout budget
  // entirely (an empty chat, or a turn where every answer failed and the
  // panels themselves already carry the error + retry affordance).
  const isVisible =
    hasComparableConversation &&
    comparableCount >= MINIMUM_COMPARABLE_ANSWERS &&
    (readyCount > 0 || generatingCount > 0);

  const state: ComparisonReadinessState = !isVisible
    ? "hidden"
    : readyCount >= MINIMUM_COMPARABLE_ANSWERS
      ? "ready"
      : generatingCount > 0
        ? "generating"
        : "needsMore";

  const blockedReason: ComparisonReadiness["blockedReason"] =
    state !== "ready"
      ? state === "generating"
        ? "generating"
        : "needsMore"
      : isBusy
        ? "busy"
        : hasInsufficientCredits
          ? "insufficientCredits"
          : null;

  return {
    comparableCount,
    readyCount,
    generatingCount,
    excludedCount,
    state,
    isVisible,
    canRun: isVisible && blockedReason === null,
    blockedReason,
  };
}
