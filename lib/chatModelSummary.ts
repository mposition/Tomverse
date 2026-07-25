// Single source of truth for "how many models is this conversation actually
// talking to, and which one is on screen right now". The mobile header and the
// composer used to answer that question with two different expressions
// (`activeModel.name` vs `selectedModels.length`), so a 3-model conversation
// with one paused panel could read as "GPT-5.4 mini" up top and "3 AIs" down
// below while only 2 models were really being billed (STG-F009).

export const MAX_MODEL_SUMMARY_AVATARS = 3;

export type ChatModelSummaryEntry<TModel> = {
  modelId: string;
  /** Undefined when the id is not in the catalog (removed / registry lag). */
  model: TModel | undefined;
  /** Falls back to the raw id so the UI never renders an empty label. */
  name: string;
  isPaused: boolean;
};

export type ChatModelSummary<TModel> = {
  /** Everything in the picker, paused panels included. */
  selectedCount: number;
  /** What the request is actually sent to, and what credits are charged for. */
  activeCount: number;
  pausedCount: number;
  /** The model whose panel is on screen; null when nothing is selected. */
  primary: ChatModelSummaryEntry<TModel> | null;
  /** The `+N` in "GPT-5.4 mini +2": active models other than the primary one. */
  extraActiveCount: number;
  isMultiModel: boolean;
  /** Selection order with the primary hoisted to the front. */
  entries: ChatModelSummaryEntry<TModel>[];
  /** Avatars to render, already trimmed to leave room for the overflow badge. */
  avatars: ChatModelSummaryEntry<TModel>[];
  /** 0 when every selected model got its own avatar. */
  avatarOverflowCount: number;
};

type BuildInput<TModel> = {
  selectedModels: readonly string[];
  disabledModelIds?: readonly string[];
  primaryModelId?: string | null;
  models: readonly TModel[];
  maxAvatars?: number;
};

export function buildChatModelSummary<TModel extends { id: string; name: string }>({
  selectedModels,
  disabledModelIds = [],
  primaryModelId = null,
  models,
  maxAvatars = MAX_MODEL_SUMMARY_AVATARS,
}: BuildInput<TModel>): ChatModelSummary<TModel> {
  const seen = new Set<string>();
  const uniqueSelected = selectedModels.filter((modelId) => {
    if (!modelId || seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
  const pausedIds = new Set(disabledModelIds);

  const toEntry = (modelId: string): ChatModelSummaryEntry<TModel> => {
    const model = models.find((item) => item.id === modelId);
    return {
      modelId,
      model,
      name: model?.name || modelId,
      isPaused: pausedIds.has(modelId),
    };
  };

  const selectionEntries = uniqueSelected.map(toEntry);
  const activeCount = selectionEntries.filter((entry) => !entry.isPaused).length;
  const pausedCount = selectionEntries.length - activeCount;

  // Prefer the panel the user is looking at; fall back to the first model that
  // is actually running, then to the first selected one at all.
  const primary =
    selectionEntries.find((entry) => entry.modelId === primaryModelId) ||
    selectionEntries.find((entry) => !entry.isPaused) ||
    selectionEntries[0] ||
    null;

  const entries = primary
    ? [primary, ...selectionEntries.filter((entry) => entry.modelId !== primary.modelId)]
    : [];

  const extraActiveCount = Math.max(
    0,
    activeCount - (primary && !primary.isPaused ? 1 : 0)
  );

  const avatarBudget = Math.max(0, maxAvatars);
  const needsOverflowBadge = entries.length > avatarBudget;
  const avatars = needsOverflowBadge
    ? entries.slice(0, Math.max(0, avatarBudget - 1))
    : entries;
  const avatarOverflowCount = entries.length - avatars.length;

  return {
    selectedCount: selectionEntries.length,
    activeCount,
    pausedCount,
    primary,
    extraActiveCount,
    isMultiModel: selectionEntries.length > 1,
    entries,
    avatars,
    avatarOverflowCount,
  };
}
