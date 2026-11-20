import type { ChatImageTurnRequest } from "@/lib/chatImageTurnCore";
import type { ImagePreset } from "@/lib/imageGenerationPricing";
import { chatImageModelCandidates } from "@/lib/chatImageIntentCore";
import { imageModelOwner, type ImageModelProfile } from "@/lib/imageModelRegistry";

/** Each Review panel owns one image request; null is an unsupported provider. */
export type ReviewImageTurns = Record<string, ChatImageTurnRequest | null>;

export function reviewImageTurnPlan(input: {
  choices: readonly { provider: string; modelId: string | null }[];
  panels: readonly string[];
  models: readonly { id: string; provider: string }[];
  preset: ImagePreset;
  prompt?: string;
  comparisonId?: string;
}): { panelIds: string[]; turns: ReviewImageTurns } | null {
  const turns: ReviewImageTurns = {};
  const imageModels = input.choices.flatMap(choice => choice.modelId ? [choice.modelId] : []).sort();
  for (const choice of input.choices) {
    const panel = input.panels.map(id => input.models.find(model => model.id === id))
      .find(model => model?.provider === choice.provider) ??
      input.models.find(model => model.provider === choice.provider);
    if (!panel || Object.hasOwn(turns, panel.id)) return null;
    turns[panel.id] = choice.modelId ? {
      modelIds: [choice.modelId], preset: input.preset,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.comparisonId ? { comparison: { id: input.comparisonId, index: imageModels.indexOf(choice.modelId), modelIds: imageModels } } : {}),
    } : null;
  }
  return { panelIds: Object.keys(turns), turns };
}

/**
 * The active image models Review may route to, with the provider that answers
 * for each: the same filter the router's candidate list uses
 * (`reviewRoutingCandidates`), so a provider is marked as drawing exactly when
 * an image request for it can reach a model. Read from the catalogue the page
 * was served with (Admin model catalogue), never from a fixed list.
 */
const activeReviewImageModels = (imageModels: readonly ImageModelProfile[]) =>
  chatImageModelCandidates(imageModels).flatMap(candidate => {
    const model = imageModels.find(item => item.id === candidate.id);
    return model ? [{ id: model.id, provider: imageModelOwner(model) as string }] : [];
  });

/** Providers with at least one active image model, in catalogue order. */
export const reviewImageProviders = (imageModels: readonly ImageModelProfile[]): string[] =>
  [...new Set(activeReviewImageModels(imageModels).map(model => model.provider))];

/**
 * The image model a Review image draft starts on when nothing chose one: the
 * first active model of a provider already answering, else the first active
 * model. Null when no image model is active, so the caller does not arm an
 * image mode that could never send.
 */
export function reviewImageDraftModelId(
  imageModels: readonly ImageModelProfile[],
  providers: readonly string[]
): string | null {
  const active = activeReviewImageModels(imageModels);
  return (active.find(model => providers.includes(model.provider)) ?? active[0])?.id ?? null;
}
