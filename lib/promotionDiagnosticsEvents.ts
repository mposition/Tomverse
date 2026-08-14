export const PROMOTION_DRAFT_STATE_EVENT = "tomverse:promotion-draft-state";

export type PromotionDraftState = {
  /** Ids of promotions edited in the catalogue editor but not yet saved. */
  dirtyPromotionIds: string[];
};

/**
 * How the diagnostics panel learns that the promotion above it has unsaved
 * edits.
 *
 * The two panels are separate on purpose -- the catalogue editor writes, the
 * diagnostics panel only reads -- but they disagree about one thing that
 * matters: diagnostics run against the *saved* row, and an operator who has
 * just typed a new end date into the editor will read the result as a verdict
 * on what they typed. So the editor publishes which drafts are dirty and the
 * diagnostics panel refuses to run for those, rather than answering a question
 * about a row the operator is no longer looking at.
 *
 * The last state is retained as well as dispatched: the diagnostics panel can
 * mount after the editor has already published, and a subscription that only
 * hears future events would treat a dirty draft as clean until the next
 * keystroke.
 */
let lastState: PromotionDraftState = { dirtyPromotionIds: [] };

export const publishPromotionDraftState = (state: PromotionDraftState) => {
  lastState = { dirtyPromotionIds: [...state.dirtyPromotionIds] };
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PromotionDraftState>(PROMOTION_DRAFT_STATE_EVENT, {
      detail: lastState,
    })
  );
};

/**
 * Snapshot getter. Returns the same object until a publish replaces it, which
 * is what `useSyncExternalStore` requires to avoid re-rendering forever.
 */
export const currentPromotionDraftState = (): PromotionDraftState => lastState;

const EMPTY_DRAFT_STATE: PromotionDraftState = { dirtyPromotionIds: [] };

/** Nothing is dirty on the server: there is no editor there to have typed in. */
export const serverPromotionDraftState = (): PromotionDraftState =>
  EMPTY_DRAFT_STATE;

export const subscribeToPromotionDraftState = (onChange: () => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PROMOTION_DRAFT_STATE_EVENT, onChange);
  return () =>
    window.removeEventListener(PROMOTION_DRAFT_STATE_EVENT, onChange);
};
