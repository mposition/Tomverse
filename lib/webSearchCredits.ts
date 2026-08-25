// Single source of truth for how the Native Web Search credit surcharge is
// computed, shared by the input composer estimate, the guest daily-limit
// gate, comparison preflight, and the server-side reservation itself. Keeping
// this logic in one place is what guarantees the UI estimate, preflight
// total, and actual per-model reservation can never drift from each other.
import {
  getModelUsageCredits,
  getWeightedUsageCredits,
  MODEL_USAGE_CREDIT_WEIGHTS,
  type AiModel,
} from "@/lib/models";
import {
  getWebSearchCapability,
  nativeSearchIsDispatchable,
  type WebSearchCapability,
} from "@/lib/webSearchCapability";
import type { WebSearchMode } from "@/lib/appDefaults";

export const WEB_SEARCH_SURCHARGE_CREDITS =
  MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge;

/**
 * Which models carry the surcharge.
 *
 * Provider-native search tools only -- Perplexity's search models are priced
 * into their base weight already -- and among those, only the ones a request
 * can actually dispatch. A capability whose per-query cost the request cannot
 * bound is refused before dispatch, so charging for it would be charging for a
 * search that is never going to run; and the surcharge is also what
 * `resolveAttemptSearchPath` reads to decide the search was paid for, so a
 * surcharge on an undispatchable capability would report a search path that
 * does not exist.
 */
export const modelEligibleForWebSearchSurcharge = (
  capability: WebSearchSurchargeCapability
) => nativeSearchIsDispatchable(capability);

/** What the surcharge rules need to know about a capability. */
type WebSearchSurchargeCapability = Pick<
  WebSearchCapability,
  "support" | "hasAdditionalCost" | "maxBillableSearchQueriesPerRequest"
>;

/** Flat surcharge credits for one model, given the requested mode and its (server-verified) capability. Never scaled by input length. */
export const getWebSearchSurchargeCredits = (
  webSearchMode: WebSearchMode,
  capability: WebSearchSurchargeCapability
) =>
  webSearchMode === "always" && modelEligibleForWebSearchSurcharge(capability)
    ? WEB_SEARCH_SURCHARGE_CREDITS
    : 0;

export type ModelCreditEstimate = {
  modelId: string;
  /** Unweighted base credits for the model's usage class. */
  baseCredits: number;
  /** Base credits after the input-length multiplier (surcharge is never multiplied). */
  weightedBaseCredits: number;
  webSearchSurchargeCredits: number;
  /** weightedBaseCredits + webSearchSurchargeCredits. */
  totalCredits: number;
  nativeSearchEligible: boolean;
};

export type RequestCreditEstimate = {
  baseCredits: number;
  weightedBaseCredits: number;
  /** Sum of surcharge across every native-search-eligible selected model -- refunded per model that doesn't actually search. */
  webSearchReservationCredits: number;
  totalEstimatedCredits: number;
  models: ModelCreditEstimate[];
};

/**
 * Computes the same estimate the server will reserve for a set of models.
 * Excludes any model not present in `models` -- callers are responsible for
 * filtering out disabled panels/unavailable models before calling this.
 */
export const estimateRequestCredits = ({
  models,
  estimatedInputTokens,
  webSearchMode,
}: {
  models: ReadonlyArray<Pick<AiModel, "id" | "usageClass" | "creditWeight">>;
  estimatedInputTokens: number;
  webSearchMode: WebSearchMode;
}): RequestCreditEstimate => {
  const perModel = models.map((model): ModelCreditEstimate => {
    const capability = getWebSearchCapability(model.id);
    return {
      modelId: model.id,
      baseCredits: getModelUsageCredits(model),
      weightedBaseCredits: getWeightedUsageCredits(model, estimatedInputTokens),
      webSearchSurchargeCredits: getWebSearchSurchargeCredits(webSearchMode, capability),
      totalCredits:
        getWeightedUsageCredits(model, estimatedInputTokens) +
        getWebSearchSurchargeCredits(webSearchMode, capability),
      nativeSearchEligible: modelEligibleForWebSearchSurcharge(capability),
    };
  });

  return {
    baseCredits: perModel.reduce((sum, entry) => sum + entry.baseCredits, 0),
    weightedBaseCredits: perModel.reduce((sum, entry) => sum + entry.weightedBaseCredits, 0),
    webSearchReservationCredits: perModel.reduce(
      (sum, entry) => sum + entry.webSearchSurchargeCredits,
      0
    ),
    totalEstimatedCredits: perModel.reduce((sum, entry) => sum + entry.totalCredits, 0),
    models: perModel,
  };
};
