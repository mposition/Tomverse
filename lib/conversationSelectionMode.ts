/**
 * A conversation's selection mode, and the state that belongs to each mode.
 *
 * Two fields on `Conversation` carry Auto's memory between turns -- the model
 * it settled on, and how many consecutive turns a challenger has cleared the
 * switch margin. Both belong to Auto, and the interesting part of this file is
 * what happens when a conversation stops being an Auto conversation.
 *
 * ## Why the streak is cleared on the way back to manual
 *
 * Hysteresis exists so Auto does not change model on a single turn's noise: a
 * challenger has to win several turns running. That streak is evidence about
 * turns Auto routed. If a user switches to manual, picks models by hand for a
 * week, and then switches back, a surviving streak would decide the very first
 * switch after Auto is turned back on -- using evidence from a period during
 * which Auto made no decisions at all.
 *
 * So the transition clears it, and the database enforces that a manual
 * conversation holds no sticky state at all
 * (`Conversation_manual_has_no_sticky_state_check`). Application code that
 * forgot would fail the write rather than leave a row that no later code path
 * has any reason to look at.
 */

import type { RouterStickyState } from "@/lib/routerSelection";

export const SELECTION_MODES = ["manual", "auto"] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export const DEFAULT_SELECTION_MODE: SelectionMode = "manual";

/**
 * A stored or requested mode, or `null` when it is neither.
 *
 * `null` rather than a fallback to `manual`, so callers decide what an
 * unrecognised value means. A request carrying an unknown mode is a client
 * error worth refusing; a row carrying one is a data problem worth reading as
 * manual. Collapsing the two here would silently accept the first.
 */
export const parseSelectionMode = (value: unknown): SelectionMode | null =>
  typeof value === "string" && SELECTION_MODES.includes(value as SelectionMode)
    ? (value as SelectionMode)
    : null;

/** A stored mode, defaulting to manual. Unknown values read as manual. */
export const storedSelectionMode = (value: unknown): SelectionMode =>
  parseSelectionMode(value) ?? DEFAULT_SELECTION_MODE;

export type ConversationRoutingState = {
  selectionMode: unknown;
  routerModelId: string | null;
  routerChallengerTurns: number;
  /** §8 recovery, when a hard fallback left some. Absent on older readers. */
  routerSwitchReason?: string | null;
  routerRecoveryModelId?: string | null;
};

/**
 * The sticky state to hand the Router, or `null` when there is none.
 *
 * Null for a manual conversation even if the columns somehow hold values: a
 * conversation that was not routed has no model Auto settled on, and reading
 * leftover state would make the first Auto turn behave as a continuation of a
 * conversation Auto never took part in.
 */
export const stickyStateFor = (
  conversation: ConversationRoutingState | null | undefined
): RouterStickyState | null => {
  if (!conversation) return null;
  if (storedSelectionMode(conversation.selectionMode) !== "auto") return null;
  if (!conversation.routerModelId) return null;
  return {
    modelId: conversation.routerModelId,
    turnsFavouringChallenger: Math.max(0, conversation.routerChallengerTurns ?? 0),
  };
};

export type SelectionModeTransition = {
  /** Columns to write. Empty when nothing changed. */
  patch: {
    selectionMode?: SelectionMode;
    routerModelId?: string | null;
    routerChallengerTurns?: number;
    routerSwitchReason?: string | null;
    routerRecoveryModelId?: string | null;
  };
  /** True when sticky state was discarded, so the caller can say so. */
  clearedStickyState: boolean;
};

/**
 * The write that moves a conversation between modes.
 *
 * Returns an empty patch when the mode is unchanged, so a caller can skip the
 * write rather than touching `updatedAt` on every request that merely restates
 * the current mode.
 */
export const selectionModeTransition = (
  current: ConversationRoutingState,
  requested: SelectionMode
): SelectionModeTransition => {
  const mode = storedSelectionMode(current.selectionMode);
  if (mode === requested) return { patch: {}, clearedStickyState: false };

  if (requested === "manual") {
    const hadState =
      current.routerModelId !== null ||
      (current.routerChallengerTurns ?? 0) > 0 ||
      Boolean(current.routerRecoveryModelId);
    // §8: "Manual intent always wins over fallback recovery." A pending
    // recovery is a plan to move the conversation back to a model the user has
    // just declined to be on; carrying it past a manual selection would undo
    // that choice on some later turn, for reasons the user never sees.
    return {
      patch: {
        selectionMode: "manual",
        routerModelId: null,
        routerChallengerTurns: 0,
        routerSwitchReason: null,
        routerRecoveryModelId: null,
      },
      clearedStickyState: hadState,
    };
  }

  // Into Auto with no history: the first routed turn decides from scratch,
  // which is what a conversation that has never been routed should do.
  return {
    patch: {
      selectionMode: "auto",
      routerModelId: null,
      routerChallengerTurns: 0,
      routerSwitchReason: null,
      routerRecoveryModelId: null,
    },
    clearedStickyState: false,
  };
};

/**
 * The sticky columns after a routed turn.
 *
 * Written only for a turn Auto actually routed. A turn that fell back to the
 * user's model -- because the cohort refused, or because nothing was eligible
 * -- must not advance the streak: hysteresis counts turns the Router judged,
 * and counting turns it did not would let a switch be decided by turns nobody
 * routed.
 */
export const stickyStateAfterRoutedTurn = (
  selectedModelId: string,
  turnsFavouringChallenger: number
): { routerModelId: string; routerChallengerTurns: number } => ({
  routerModelId: selectedModelId,
  routerChallengerTurns: Math.max(0, turnsFavouringChallenger),
});
