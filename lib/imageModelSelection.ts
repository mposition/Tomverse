import { IMAGE_MODEL_REGISTRY } from "@/lib/imageModelRegistry";

/**
 * What the composer is allowed to do to its model selection, given the limit
 * the server is actually enforcing.
 *
 * Pure and client-safe. The limit itself is never resolved here -- it arrives
 * as a number the server read at request time (`lib/imageGroupLimits.ts`) and
 * handed down. A client that computed its own limit would be reading a
 * build-time constant and would drift the moment a deployment changed the
 * variable, which is the defect this module exists to prevent.
 *
 * **This never decides whether a request is allowed.** Admission in
 * `requestImageGeneration` is the boundary; this only stops the UI from
 * offering a request that boundary will refuse. A stale tab, a deployment
 * mid-flight, or a limit lowered between page load and submit all reach the
 * server with a selection this module approved, and the server still says no.
 */

/** Registry position, so a limited or restored set always comes back the same. */
const registryOrder = (modelId: string) => {
  const index = IMAGE_MODEL_REGISTRY.findIndex((model) => model.id === modelId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

export type ImageModelSelectionChange = {
  /** The selection after the change. Unchanged when the change was refused. */
  modelIds: string[];
  /**
   * True only when a model was refused *because the limit is reached*. The
   * other refusal -- deselecting the last remaining model -- is deliberately
   * not reported here: it is a different sentence to the user, and merging
   * them would make the composer explain a limit that is not the reason.
   */
  blockedByLimit: boolean;
};

/**
 * Add or remove one model.
 *
 * Three rules, in the order they are checked:
 *
 * 1. An already-selected model is always removable, **including at the
 *    limit**. Being at the ceiling must not trap the selection: the way out of
 *    "you have three" is to deselect one, so the deselect has to keep working.
 * 2. The last remaining model cannot be removed -- an empty composer looks
 *    ready and refuses on submit.
 * 3. A new model is refused once the selection has reached the limit. It is
 *    refused, not swapped: silently dropping the oldest choice would edit a
 *    decision the user made and did not revisit.
 */
export const toggleImageModelSelection = (input: {
  selected: readonly string[];
  modelId: string;
  maxModels: number;
}): ImageModelSelectionChange => {
  const current = [...input.selected];
  if (current.includes(input.modelId)) {
    if (current.length === 1) return { modelIds: current, blockedByLimit: false };
    return {
      modelIds: current.filter((id) => id !== input.modelId),
      blockedByLimit: false,
    };
  }
  if (current.length >= input.maxModels) {
    return { modelIds: current, blockedByLimit: true };
  }
  return { modelIds: [...current, input.modelId], blockedByLimit: false };
};

export type ImageModelSelectionLimitOutcome = {
  /** The models the composer may start with. Never empty when input was not. */
  modelIds: string[];
  /** Dropped for the limit alone, so the composer can name them. */
  excludedModelIds: string[];
};

/**
 * Cut an incoming selection down to the current limit.
 *
 * Applies to every path that can hand the composer more models than the server
 * would now accept: catalogue seed ids, a selection restored from an earlier
 * comparison, a tab left open across a deployment that lowered the limit.
 *
 * Registry order decides which survive, matching
 * `deriveImageComposerRestore`. Selection order is not recorded anywhere and
 * carries no product meaning, so ordering by it would be arbitrary and would
 * change with row order. The models that do not fit are returned rather than
 * dropped in silence, and **nothing stored is rewritten** -- the group that
 * used four models keeps saying it used four.
 */
export const limitImageModelSelection = (input: {
  modelIds: readonly string[];
  maxModels: number;
}): ImageModelSelectionLimitOutcome => {
  const ordered = [...new Set(input.modelIds)].sort(
    (a, b) => registryOrder(a) - registryOrder(b)
  );
  if (input.maxModels <= 0 || ordered.length <= input.maxModels) {
    return { modelIds: ordered, excludedModelIds: [] };
  }
  return {
    modelIds: ordered.slice(0, input.maxModels),
    excludedModelIds: ordered.slice(input.maxModels),
  };
};

/**
 * The limit to state in a message about a refused selection.
 *
 * The server sends `details.maxModels` with `IMAGE_MODEL_SELECTION_INVALID`,
 * and that number is the authoritative one -- it is what admission actually
 * applied, which a stale client's own copy may no longer match. But it arrives
 * as `unknown` from a JSON body, so a malformed or absent value falls back to
 * the limit the client was given rather than rendering "up to undefined
 * models".
 */
export const reportedImageModelLimit = (
  detailValue: unknown,
  runtimeMaxModels: number
): number =>
  typeof detailValue === "number" &&
  Number.isSafeInteger(detailValue) &&
  detailValue > 0
    ? detailValue
    : runtimeMaxModels;
