/**
 * Which conversation a panel's runtime status belongs to.
 *
 * Both shells used to hold `modelStatuses` keyed by `modelId` alone, and a
 * model id says nothing about *where* it was running. Starting an answer in
 * conversation A and then opening a new chat left `{ "gpt-5-4-mini":
 * "responding" }` in that record, and the new chat's composer read it as its
 * own: the textarea and the send button were disabled, and a stop button
 * appeared for a run the new conversation had never started. The same record
 * also kept models that were no longer selected, so a conversation whose
 * selection differed from the previous one inherited a `responding` entry it
 * had no panel for and no way to clear.
 *
 * The fix has two halves, both here so the two shells cannot drift:
 *
 *  * statuses are stored per (conversation, model), exactly like
 *    {@link import("./chatContentState").chatContentStateKey} does for content
 *    state, so a report can only ever describe the conversation it was made
 *    in; and
 *  * everything the composer reads is derived from *this* conversation's
 *    currently selected models, so a model dropped from the selection stops
 *    counting the moment it is dropped rather than when it next reports.
 *
 * Neither half fakes an idle state: the run in conversation A keeps running,
 * keeps its own status, and is shown again when the user returns to it (see
 * lib/chatStreamRuntime.ts). What changes is only which conversation the
 * status is allowed to speak for.
 */

/** Mirrors the per-panel runtime status ChatApp reports. */
export type ModelRuntimeStatus =
  | "idle"
  | "loading"
  | "responding"
  | "error"
  | "cancelled"
  | "paused";

/**
 * Per (conversation, model) identity for a reported runtime status. A chat
 * with no conversation id yet is a state of its own rather than a missing
 * value -- hence the explicit "new", matching `chatContentStateKey`.
 */
export function chatModelStatusKey(
  conversationId: string | null,
  modelId: string
): string {
  return `${conversationId || "new"}:${modelId}`;
}

export type ScopedModelStatusInput = {
  /** Every report received so far, keyed by {@link chatModelStatusKey}. */
  statuses: Readonly<Record<string, ModelRuntimeStatus | undefined>>;
  /** The conversation on screen right now. */
  conversationId: string | null;
  /** The models that conversation is currently comparing. */
  selectedModelIds: readonly string[];
};

/**
 * The `{ modelId: status }` record every existing consumer expects (the tab
 * strip, the mobile header counts, `deriveComparisonReadiness`), restricted to
 * the conversation on screen and to the models it actually has panels for.
 *
 * A model with no report for this conversation is simply absent, which is what
 * those consumers already treat as "nothing known yet" -- it must not inherit
 * the report the same model made in a different conversation.
 */
export function scopeModelStatusesToConversation({
  statuses,
  conversationId,
  selectedModelIds,
}: ScopedModelStatusInput): Record<string, ModelRuntimeStatus> {
  const scoped: Record<string, ModelRuntimeStatus> = {};
  for (const modelId of selectedModelIds) {
    const status = statuses[chatModelStatusKey(conversationId, modelId)];
    if (status) scoped[modelId] = status;
  }
  return scoped;
}

export type ComposerBusyInput = {
  /** Already scoped by {@link scopeModelStatusesToConversation}. */
  statuses: Readonly<Record<string, ModelRuntimeStatus | undefined>>;
  selectedModelIds: readonly string[];
  /** Panels the user paused; they run nothing, so they block nothing. */
  disabledModelIds: readonly string[];
};

/**
 * Whether *this* conversation's composer is busy.
 *
 * Only a run belonging to a model this conversation is showing, and has not
 * paused, may hold the composer. That is the whole claim the disabled
 * textarea, the disabled send button and the stop button make, and it was the
 * one thing the old `Object.values(modelStatuses).some(...)` could not check.
 */
export function isConversationResponding({
  statuses,
  selectedModelIds,
  disabledModelIds,
}: ComposerBusyInput): boolean {
  return selectedModelIds.some(
    (modelId) =>
      !disabledModelIds.includes(modelId) && statuses[modelId] === "responding"
  );
}
