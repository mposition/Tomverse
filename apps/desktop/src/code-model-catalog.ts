import { AVAILABLE_MODELS, type AiModel, type AiProvider } from "../../../lib/models";
import type { Model } from "./contract";
import { liveCliProviderForModel } from "./provider-cli-exec-contract";

export const SMART_ADAPTIVE_MODEL_ID = "smart-adaptive";

function tokenSize(tokens: number) {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Math.round(tokens / 1_000)}K`;
}

/**
 * A coding-catalogue entry in the shape the shared model picker lists. The
 * name, provider, credits and capabilities are the catalogue's. A model Chat
 * also lists keeps Chat's one-line description; any other shows its context
 * window (`contextCopy` carries a `{size}` placeholder).
 */
export function codePickerModel(model: Model, contextCopy: string): AiModel {
  const known = AVAILABLE_MODELS.find(({ id }) => id === model.id);
  return {
    id: model.id, name: model.name, apiModel: model.id, provider: model.provider as AiProvider, icon: "",
    bestFor: model.via ?? known?.bestFor ?? (model.contextWindowTokens ? contextCopy.replace("{size}", tokenSize(model.contextWindowTokens)) : ""),
    minimumPlan: "Guest", usageClass: "standard", creditWeight: model.credits, enabled: true, status: "enabled",
    reasoning: model.reasoning || model.efforts.length ? "medium" : "none", contextWindowTokens: model.contextWindowTokens,
    inputCapabilities: { image: model.vision === true, nativePdf: false }, webSearchOverride: "off",
  };
}

/**
 * The models that run on the person's own provider CLI subscription and spend no Tomverse credits. The picker shows no
 * usage meter or credit estimate for them.
 */
export function creditFreeModelIds(models: readonly Model[]) {
  return models.filter(({ id }) => liveCliProviderForModel(id) !== null).map(({ id }) => id);
}

/** The models the picker lists: every catalogue entry but Smart Adaptive, which is the picker's switch. */
export function codePickerModels(models: readonly Model[], contextCopy: string) {
  return models.filter(({ id }) => id !== SMART_ADAPTIVE_MODEL_ID).map((model) => codePickerModel(model, contextCopy));
}
