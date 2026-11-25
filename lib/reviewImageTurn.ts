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
  if (new Set(imageModels).size !== imageModels.length) return null;
  const selected = input.panels.flatMap(id => input.models.filter(model => model.id === id));
  for (const choice of input.choices) {
    // A panel hosts one image answer: a selected panel of the image model's
    // provider, else any free selected panel (an image owner without a chat
    // model, or a second model of one owner), else the provider's catalogue model.
    const free = (model: { id: string }) => !Object.hasOwn(turns, model.id);
    const panel = selected.find(model => model.provider === choice.provider && free(model)) ??
      (choice.modelId ? selected.find(free) : undefined) ??
      input.models.find(model => model.provider === choice.provider && free(model));
    if (!panel) return null;
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

/**
 * The Review composer's image models after one is picked from the catalogue.
 *
 * Review compares like with like: picking the first image model turns every
 * answering panel into an image model -- the picked one, then an active model
 * of each other panel's provider, then other owners -- up to `slots`. Once in
 * image mode a pick toggles: a chosen model is removed (never the last one),
 * another is added, or replaces the last one when `max` is reached.
 */
export function reviewImageModelSelection(input: {
  imageModels: readonly ImageModelProfile[];
  current: readonly string[];
  picked: string;
  providers: readonly string[];
  slots: number;
  max: number;
}): string[] {
  const active = activeReviewImageModels(input.imageModels);
  const max = Math.max(1, input.max);
  if (!active.some(model => model.id === input.picked)) return [...input.current];
  if (input.current.length > 0) {
    if (input.current.includes(input.picked)) {
      return input.current.length > 1 ? input.current.filter(id => id !== input.picked) : [...input.current];
    }
    return input.current.length < max ? [...input.current, input.picked]
      : [...input.current.slice(0, max - 1), input.picked];
  }
  const chosen = [input.picked];
  const owner = (id: string) => active.find(model => model.id === id)?.provider;
  const target = Math.min(max, Math.max(1, input.slots));
  const add = (model: { id: string; provider: string } | undefined) => {
    if (model && chosen.length < target && !chosen.includes(model.id)) chosen.push(model.id);
  };
  for (const provider of input.providers) {
    if (!chosen.some(id => owner(id) === provider)) add(active.find(model => model.provider === provider));
  }
  for (const model of active) if (!chosen.some(id => owner(id) === model.provider)) add(model);
  for (const model of active) add(model);
  return chosen;
}
