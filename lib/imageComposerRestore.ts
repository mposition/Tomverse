import {
  type ImagePreset,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  getImageModelPrice,
  IMAGE_MODEL_REGISTRY,
} from "@/lib/imageModelRegistry";
import { currentImageAttempt } from "@/lib/imageGenerationStateCore";

// What the composer starts as when an existing image conversation is opened.
//
// Pure, and derived from the group/target/current-attempt structure that
// already exists -- no new table, no stored composer state. Storing it would
// be a second copy of something the last comparison already says, and the two
// would drift.

export type ImageComposerRestoreAttempt = {
  id: string;
  attemptNumber: number;
  preset: string;
  quality: string;
  size: string;
};

export type ImageComposerRestoreTarget = {
  id: string;
  modelId: string;
  currentGenerationId: string | null;
  generations: readonly ImageComposerRestoreAttempt[];
};

export type ImageComposerRestore = {
  /** Which comparison this was read from, for logs and for the client's guard. */
  sourceGroupId: string;
  modelIds: string[];
  preset: ImagePreset | null;
  quality: ImageQuality | null;
  size: ImageSize | null;
  /**
   * Models the last comparison used that cannot be selected now -- disabled
   * since, or with no price at the restored option. Reported so the composer
   * can say why rather than silently starting from a different selection.
   */
  excludedModelIds: string[];
  /**
   * False when the group's current attempts disagree about preset, quality or
   * size. The options are then NOT restored: picking one target's values would
   * present a guess as the user's last choice.
   */
  optionsConsistent: boolean;
};

const registryOrder = (modelId: string) => {
  const index = IMAGE_MODEL_REGISTRY.findIndex((model) => model.id === modelId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const isPreset = (value: string): value is ImagePreset =>
  value === "draft" || value === "standard" || value === "final";
const isQuality = (value: string): value is ImageQuality =>
  value === "low" || value === "medium" || value === "high";
const isSize = (value: string): value is ImageSize =>
  value === "1024x1024" || value === "1536x1024" || value === "1024x1536";

/**
 * Derive the composer's starting state from one comparison group.
 *
 * The caller picks the group -- ordered by the GROUP's `createdAt`, never by
 * any generation's, because retrying an older group's failed target writes the
 * newest `ImageGeneration` row in the conversation and would otherwise drag
 * the composer back to a comparison the user has moved past.
 *
 * Options come back only when every current attempt agrees on them. They can
 * only disagree through a bug -- one request carries one quality and one size
 * for the whole group -- so the disagreement is reported rather than resolved:
 * choosing a target's values would turn corrupt data into a plausible-looking
 * default the user would have no reason to question.
 */
export const deriveImageComposerRestore = (input: {
  groupId: string;
  targets: readonly ImageComposerRestoreTarget[];
}): ImageComposerRestore => {
  const attempts = input.targets.map((target) => ({
    modelId: target.modelId,
    attempt: currentImageAttempt(target),
  }));

  const options = attempts
    .map((entry) => entry.attempt)
    .filter((attempt): attempt is ImageComposerRestoreAttempt => attempt !== null)
    .map((attempt) => ({
      preset: attempt.preset,
      quality: attempt.quality,
      size: attempt.size,
    }));

  const first = options[0] ?? null;
  const optionsConsistent =
    options.length > 0 &&
    options.every(
      (option) =>
        option.preset === first!.preset &&
        option.quality === first!.quality &&
        option.size === first!.size
    ) &&
    isPreset(first!.preset) &&
    isQuality(first!.quality) &&
    isSize(first!.size);

  const preset = optionsConsistent && isPreset(first!.preset) ? first!.preset : null;
  const quality =
    optionsConsistent && isQuality(first!.quality) ? first!.quality : null;
  const size = optionsConsistent && isSize(first!.size) ? first!.size : null;

  const selectable: string[] = [];
  const excludedModelIds: string[] = [];
  for (const { modelId } of attempts) {
    if (selectable.includes(modelId) || excludedModelIds.includes(modelId)) {
      continue;
    }
    const model = getImageModel(modelId);
    // A model held since the last comparison, and one that has no price at the
    // option being restored, are the same problem from the composer's side:
    // selecting it would block submission with no stated reason. Both are
    // reported instead.
    const priceable =
      quality && size ? getImageModelPrice(modelId, quality, size) !== null : true;
    if (!model || model.disabledReason !== null || !priceable) {
      excludedModelIds.push(modelId);
      continue;
    }
    selectable.push(modelId);
  }

  // Falling back to the default is the last resort, not the first: it is only
  // right when nothing the user actually chose can be offered back.
  const modelIds =
    selectable.length > 0 ? selectable : [DEFAULT_IMAGE_MODEL_ID];

  return {
    sourceGroupId: input.groupId,
    // Registry order, so the same set always comes back in the same order.
    // Selection order is not recorded anywhere and carries no product meaning,
    // so inventing one from row order would be arbitrary and unstable.
    modelIds: [...modelIds].sort((a, b) => registryOrder(a) - registryOrder(b)),
    preset,
    quality,
    size,
    excludedModelIds,
    optionsConsistent,
  };
};
