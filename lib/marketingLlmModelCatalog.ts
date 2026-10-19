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
import { MODEL_PRICING, type ModelPricingProfile } from "@/lib/modelPricing";
import { AVAILABLE_MODELS } from "@/lib/models";

/**
 * The models the marketing generator may use, and their price pins, derived
 * from the chat price catalog (operator decision 2026-10-19: the model is
 * chosen in the Admin Console, not pinned by hand in code).
 *
 * The catalog already carries the prices the app bills users by, reviewed and
 * gated by `npm run check:model-pricing`; a pin is that price at its worst --
 * the most expensive tier and every scheduled revision -- with the window the
 * model list records, the generator's own output cap and search count, and
 * OpenAI's web search price. Only OpenAI models are offered: the adapter calls
 * OpenAI and nothing else.
 */

const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
const FAR_FUTURE = "9999-12-31T00:00:00.000Z";

const microPerMillion = (usdPerMillion: number) => Math.ceil(usdPerMillion * 1_000_000);

const worstRates = (profile: ModelPricingProfile) => {
  const tiers = [profile.tiers, ...(profile.priceSchedule ?? []).map((revision) => revision.tiers)].flat();
  return {
    input: Math.max(...tiers.map((tier) => tier.inputUsdPerMillionTokens)),
    output: Math.max(...tiers.map((tier) => tier.outputUsdPerMillionTokens)),
  };
};

export type MarketingLlmModelOption = {
  /** The id the generator sends and the Admin setting stores. */
  readonly model: string;
  readonly name: string;
  readonly pin: MarketingLlmPricePin;
  /** The most one A3 web-search call can cost, in micro-USD. */
  readonly worstCallMicroUsd: number;
  /** Why it cannot be selected, or null: a pin the ledger would refuse is not offered. */
  readonly unavailable: string | null;
};

export function marketingLlmModelOptions(): MarketingLlmModelOption[] {
  const options: MarketingLlmModelOption[] = [];
  const seen = new Set<string>();
  for (const model of AVAILABLE_MODELS) {
    if (model.provider !== "openai" || !model.enabled || seen.has(model.apiModel)) continue;
    const profile = MODEL_PRICING.find((entry) => entry.modelId === model.id);
    if (!profile || profile.apiModelId !== model.apiModel) continue;
    const contextWindowTokens = (model as { contextWindowTokens?: number }).contextWindowTokens;
    if (!contextWindowTokens) continue;
    seen.add(model.apiModel);
    const rates = worstRates(profile);
    const pin: MarketingLlmPricePin = {
      model: model.apiModel,
      tokenizerFamily: "openai",
      projectId: MARKETING_LLM_KEY_SCOPED_PROJECT,
      region: "global",
      tiers: [MARKETING_LLM_SERVICE_TIER],
      contextWindowTokens,
      worstInputMicroUsdPerMillion: microPerMillion(rates.input),
      worstOutputMicroUsdPerMillion: microPerMillion(rates.output),
      maxOutputTokens: MARKETING_LLM_MAX_OUTPUT_TOKENS,
      priceVersion: profile.pricingVersion,
      verifiedAt: `${profile.effectiveDate}T00:00:00.000Z`,
      expiresAt: FAR_FUTURE,
      source: PRICING_SOURCE,
      webSearchMicroUsdPerCall: Math.max(
        profile.nativeSearchCostMicroUsdPerQuery ?? 0,
        MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL,
      ),
      maxWebSearchCalls: MARKETING_LLM_WEB_SEARCH_CALLS,
    };
    const problems = marketingLlmPinProblems(pin);
    options.push({
      model: model.apiModel,
      name: model.name,
      pin,
      worstCallMicroUsd: marketingLlmReservation(pin, MARKETING_LLM_WEB_SEARCH_PROFILE).reservedMicroUsd,
      unavailable: problems.length === 0 ? null : problems.join(", "),
    });
  }
  return options;
}

/** The pins the ledger may reserve against: every option it would accept. */
export const marketingLlmCatalogPins = (): MarketingLlmPricePin[] =>
  marketingLlmModelOptions()
    .filter((option) => option.unavailable === null)
    .map((option) => option.pin);
