import { autoLlmRouterCandidates } from "@/lib/autoLlmRouterCore";
import { chatImageModelCandidates } from "@/lib/chatImageIntentCore";
import { IMAGE_QUALITY_BY_PRESET, type ImagePreset } from "@/lib/imageGenerationPricing";
import { imageModelOwner, type ImageModelProfile } from "@/lib/imageModelRegistry";
import { canUseModelWithPlan, getModelUsageProfile, modelSupportsImageInput, type AiModel, type ModelTier } from "@/lib/models";

export type ReviewMode = "easy" | "professional";
export const REVIEW_MAX_PROVIDERS = 3;
/**
 * The Review router prompt carries image and research criteria plus a
 * candidate list per provider and returns structured output, so Chat's 5 s
 * deadline cut off every production call (2026-10-31: 503 at 5.1-5.3 s).
 */
export const REVIEW_ROUTER_TIMEOUT_MS = 12_000;
/** Above the server deadline, so the client never abandons a routed answer. */
export const REVIEW_ROUTER_CLIENT_TIMEOUT_MS = REVIEW_ROUTER_TIMEOUT_MS + 3_000;
export type ReviewRouteChoice = { provider: string; modelId: string | null };
export type ReviewRouteDecision = {
  kind: "text" | "image";
  preset: ImagePreset;
  choices: ReviewRouteChoice[];
};

export function reviewRoutingCandidates(input: {
  providers: readonly string[];
  models: readonly AiModel[];
  imageModels: readonly ImageModelProfile[];
  plan: ModelTier | "Guest";
  hasImages: boolean;
}) {
  const models = input.models.filter(model =>
    input.providers.includes(model.provider) && model.enabled && !model.catalogDeleted &&
    model.publiclyListed !== false && canUseModelWithPlan(input.plan, model) &&
    (!input.hasImages || modelSupportsImageInput(model)));
  const text = autoLlmRouterCandidates(models.map(m => m.id), models,
    Object.fromEntries(models.map(m => [m.id, getModelUsageProfile(m).credits])));
  const images = chatImageModelCandidates(input.imageModels).flatMap(candidate => {
    const model = input.imageModels.find(m => m.id === candidate.id)!;
    const provider = imageModelOwner(model);
    return input.providers.includes(provider) ? [{ ...candidate, provider }] : [];
  });
  return { text, images };
}

export type ReviewRoutingCandidates = ReturnType<typeof reviewRoutingCandidates>;

export const reviewRouteOutputSchema = (providers: readonly string[]) => ({
  type: "object" as const,
  properties: {
    kind: { type: "string" as const, enum: ["text", "image"] },
    preset: { type: "string" as const, enum: ["draft", "standard", "final"] },
    choices: {
      type: "array" as const, minItems: providers.length, maxItems: providers.length,
      items: {
        type: "object" as const,
        properties: {
          provider: { type: "string" as const, enum: [...providers] },
          modelId: { type: ["string", "null"] as const },
        },
        required: ["provider", "modelId"], additionalProperties: false as const,
      },
    },
  },
  required: ["kind", "preset", "choices"], additionalProperties: false as const,
});

/** A model may select from a provider's eligible set; it cannot widen that set. */
export function parseReviewRoute(output: unknown, providers: readonly string[], candidates: ReviewRoutingCandidates): ReviewRouteDecision | null {
  if (!output || typeof output !== "object") return null;
  const value = output as Partial<ReviewRouteDecision>;
  if (value.kind !== "text" && value.kind !== "image") return null;
  if (!value.preset || !Object.hasOwn(IMAGE_QUALITY_BY_PRESET, value.preset)) return null;
  if (!Array.isArray(value.choices) || value.choices.length !== providers.length) return null;
  const choices: ReviewRouteChoice[] = [];
  for (const provider of providers) {
    const matches = value.choices.filter(c => c && c.provider === provider);
    if (matches.length !== 1) return null;
    const providerCandidates = value.kind === "text" ? candidates.text.filter(c => c.provider === provider)
      : candidates.images.filter(c => c.provider === provider);
    const available = value.kind === "text" ? providerCandidates
      : candidates.images.filter(c => c.provider === provider && c.credits[value.preset!] !== undefined);
    if (providerCandidates.length > 0 && available.length === 0) return null;
    const modelId = matches[0].modelId;
    if (available.length === 0) { choices.push({ provider, modelId: null }); continue; }
    if (typeof modelId !== "string" || !available.some(c => c.id === modelId)) return null;
    choices.push({ provider, modelId });
  }
  return { kind: value.kind, preset: value.preset, choices };
}
