import { reviewRoutingCandidates, REVIEW_MAX_PROVIDERS } from "@/lib/reviewRoutingCore";
import type { AiModel, ModelTier } from "@/lib/models";

export const REVIEW_DEFAULT_PROVIDERS_KEY = "review.easy.defaultProviders";
export const REVIEW_DEFAULT_PROVIDERS = ["openai"];
export const REVIEW_PROVIDER_PREFERENCES_UPDATED = "tomverse:review-provider-preferences";

export function parseReviewProviderDefaults(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > REVIEW_MAX_PROVIDERS) return null;
  if (!value.every((provider): provider is string => typeof provider === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(provider))) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

export function reviewProviderOptions(models: readonly AiModel[], plan: ModelTier | "Guest"): string[] {
  const providers = [...new Set(models.map(model => model.provider))];
  const candidates = reviewRoutingCandidates({ providers, models, imageModels: [], plan, hasImages: false });
  const ids = new Set(candidates.text.map(candidate => candidate.id));
  return [...new Set(models.filter(model => ids.has(model.id)).map(model => model.provider))];
}

/** Only a new Review reads defaults; explicit choices and stored conversations win. */
export function resolveReviewProviderDefaults(input: {
  personal: unknown; platform: unknown; available: readonly string[]; maxProviders: number;
}) {
  const defaults = parseReviewProviderDefaults(input.personal) ?? parseReviewProviderDefaults(input.platform) ?? REVIEW_DEFAULT_PROVIDERS;
  return defaults.filter(provider => input.available.includes(provider)).slice(0, Math.max(0, Math.min(REVIEW_MAX_PROVIDERS, input.maxProviders)));
}
