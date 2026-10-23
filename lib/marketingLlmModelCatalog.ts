import "server-only";

import {
  MARKETING_LLM_KEY_SCOPED_PROJECT,
  MARKETING_LLM_MAX_OUTPUT_TOKENS,
  MARKETING_LLM_SERVICE_TIER,
  MARKETING_LLM_WEB_SEARCH_CALLS,
  MARKETING_LLM_WEB_SEARCH_PROFILE,
  MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL,
  marketingLlmPinProblems,
  marketingLlmReservation,
  type MarketingLlmPricePin,
} from "@/lib/marketingLlmBudgetCore";
import { MODEL_PRICING, resolveModelPricing, type PricingCostSource } from "@/lib/modelPricing";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { AiModel } from "@/lib/models";

/**
 * The models the marketing generator may use, and their price pins, read from
 * the Tomverse model catalog -- the runtime registry an operator manages in
 * Admin › Models (operator decisions 2026-10-19 and 2026-10-23: the model is
 * chosen in the Admin Console from the catalog, not pinned by hand in code).
 *
 * A pin is the catalog's own price at its worst: the long-context tier and
 * every scheduled revision, a registry override when an operator set one,
 * with the window the catalog records, the generator's output cap and search
 * count, and OpenAI's web search price. Every enabled catalog model is
 * listed; one the generator cannot use says why -- the adapter calls OpenAI
 * only, an unverified (fallback) price is no price, and the ledger refuses a
 * pin outside its row limits.
 */

const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const FAR_FUTURE = "9999-12-31T00:00:00.000Z";
const VERIFIED_SOURCES: readonly PricingCostSource[] = [
  "registry",
  "registry_long_context",
  "registry_env_override",
  "model_registry_override",
];

const microPerMillion = (usdPerMillion: number) => Math.ceil(usdPerMillion * 1_000_000);
const pinText = (value: string) => value.replace(/[^A-Za-z0-9._:/-]/gu, "-").slice(0, 128) || "unknown";

export type MarketingLlmModelOption = {
  /** The id the generator sends and the Admin setting stores. */
  readonly model: string;
  readonly name: string;
  readonly provider: string;
  /** Null when the model cannot be priced; then it is never selectable. */
  readonly pin: MarketingLlmPricePin | null;
  /** The most one A3 web-search call can cost, in micro-USD; 0 without a pin. */
  readonly worstCallMicroUsd: number;
  /** Why it cannot be selected, or null. */
  readonly unavailable: string | null;
};

/** The options for a list of catalog models, priced now. Pure apart from the price registry. */
export function marketingLlmModelOptionsFrom(
  models: readonly AiModel[],
  now: Date = new Date(),
): MarketingLlmModelOption[] {
  const options: MarketingLlmModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.enabled || seen.has(model.apiModel)) continue;
    seen.add(model.apiModel);
    const base = { model: model.apiModel, name: model.name, provider: model.provider };
    if (model.provider !== "openai") {
      options.push({ ...base, pin: null, worstCallMicroUsd: 0, unavailable: "provider_not_supported" });
      continue;
    }
    const window = model.contextWindowTokens;
    if (!window) {
      options.push({ ...base, pin: null, worstCallMicroUsd: 0, unavailable: "context_window_unknown" });
      continue;
    }
    // A verified price is the static profile for exactly this provider and
    // API model, or an operator's registry price for both input and output.
    // The price registry finds a profile by catalog id alone and fills any
    // rate an override leaves out from a fallback, so neither alone is proof:
    // a catalog row re-pointed at another API model, or a lone override,
    // would otherwise price the call at someone else's (or a guessed) rate.
    const profile = MODEL_PRICING.find((entry) => entry.modelId === model.id);
    const profileMatches = profile?.provider === model.provider && profile.apiModelId === model.apiModel;
    const explicit = model.inputUsdPerMillionTokens != null && model.outputUsdPerMillionTokens != null;
    // The worst rate: the top tier now, and at every revision still to come.
    const future = ((profileMatches && profile?.priceSchedule) || [])
      .map((revision) => Date.parse(revision.effectiveFrom))
      .filter((at) => Number.isFinite(at) && at > now.getTime());
    const priced = [now.getTime(), ...future].map((at) =>
      resolveModelPricing(model, { estimatedPromptTokens: window, at }),
    );
    const current = priced[0];
    if ((!profileMatches && !explicit) || !VERIFIED_SOURCES.includes(current.costSource)) {
      options.push({ ...base, pin: null, worstCallMicroUsd: 0, unavailable: "price_unverified" });
      continue;
    }
    const pin: MarketingLlmPricePin = {
      model: model.apiModel,
      tokenizerFamily: "openai",
      projectId: MARKETING_LLM_KEY_SCOPED_PROJECT,
      region: "global",
      tiers: [MARKETING_LLM_SERVICE_TIER],
      contextWindowTokens: window,
      worstInputMicroUsdPerMillion: microPerMillion(Math.max(...priced.map((p) => p.inputUsdPerMillionTokens))),
      worstOutputMicroUsdPerMillion: microPerMillion(Math.max(...priced.map((p) => p.outputUsdPerMillionTokens))),
      maxOutputTokens: MARKETING_LLM_MAX_OUTPUT_TOKENS,
      priceVersion: pinText(current.pricingVersion),
      verifiedAt: `${current.effectiveDate}T00:00:00.000Z`,
      expiresAt: FAR_FUTURE,
      source: PRICING_SOURCE,
      webSearchMicroUsdPerCall: Math.max(
        current.nativeSearchCostMicroUsdPerQuery ?? 0,
        MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL,
      ),
      maxWebSearchCalls: MARKETING_LLM_WEB_SEARCH_CALLS,
    };
    const problems = marketingLlmPinProblems(pin);
    options.push({
      ...base,
      pin,
      worstCallMicroUsd: marketingLlmReservation(pin, MARKETING_LLM_WEB_SEARCH_PROFILE).reservedMicroUsd,
      unavailable: problems.length === 0 ? null : problems.join(", "),
    });
  }
  return options;
}

/** The options for the catalog as it stands. */
export async function marketingLlmModelOptions(): Promise<MarketingLlmModelOption[]> {
  return marketingLlmModelOptionsFrom(await getRuntimeModels());
}

/** The pins the ledger may reserve against: every catalog option it accepts. */
export async function marketingLlmCatalogPins(): Promise<MarketingLlmPricePin[]> {
  return (await marketingLlmModelOptions()).flatMap((option) =>
    option.unavailable === null && option.pin ? [option.pin] : [],
  );
}
