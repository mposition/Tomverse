import type { ChatImageTurnRequest } from "@/lib/chatImageTurnCore";
import type { ImagePreset } from "@/lib/imageGenerationPricing";

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
