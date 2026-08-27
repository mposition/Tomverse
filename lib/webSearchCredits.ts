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
  appManagedSearchIsDispatchable,
  getWebSearchCapability,
  nativeSearchIsDispatchable,
  type DispatchableWebSearchCapability,
} from "@/lib/webSearchCapability";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
import type { WebSearchMode } from "@/lib/appDefaults";

export const WEB_SEARCH_SURCHARGE_CREDITS =
  MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge;

/**
 * Which models carry the surcharge.
 *
 * The two paid search routes, and only the ones a request can actually
 * dispatch. Perplexity's search models are priced into their base weight
 * already and never carry it.
 *
 * "Actually dispatch" does the work in both directions. A native capability
 * whose per-query cost the request cannot bound is refused before dispatch, so
 * charging for it would be charging for a search that is never going to run.
 * An application-managed capability whose backend this deployment holds no key
 * for is the same failure with a different cause -- and it is why `readiness`
 * is a required parameter rather than an optional one: a default of "assume the
 * key is there" charges eight credits for a search that cannot happen, and
 * refunds them only if something downstream notices.
 *
 * The surcharge is also what `resolveAttemptSearchPath` reads to decide the
 * search was paid for, so a surcharge on an undispatchable capability would
 * additionally report a search path that does not exist.
 */
export const modelEligibleForWebSearchSurcharge = (
  capability: WebSearchSurchargeCapability,
  readiness: WebSearchBackendReadiness
) =>
  nativeSearchIsDispatchable(capability) ||
  appManagedSearchIsDispatchable(capability, readiness);

/** What the surcharge rules need to know about a capability. */
type WebSearchSurchargeCapability = DispatchableWebSearchCapability;

/**
 * Flat surcharge credits for one model, given the requested mode, its
 * (server-verified) capability and this deployment's backend readiness.
 *
 * Flat, and the same eight credits whichever route runs the search. Charging
 * more because a model happens to search through a vendor this application
 * pays separately would make an entitlement out of an implementation detail;
 * the operational cost difference belongs in the operational budget, which is
 * where it is.
 *
 * Never scaled by input length, and never scaled by how many queries ran: one
 * search or five, the price is eight credits, and zero searches is a refund of
 * all eight.
 */
export const getWebSearchSurchargeCredits = (
  webSearchMode: WebSearchMode,
  capability: WebSearchSurchargeCapability,
  readiness: WebSearchBackendReadiness
) =>
  webSearchMode === "always" &&
  modelEligibleForWebSearchSurcharge(capability, readiness)
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
  /**
   * Whether this model would be charged the surcharge on a searching turn.
   *
   * Named for what it means rather than for the route that used to be the only
   * one: an application-managed search is eligible too, and a field called
   * `nativeSearchEligible` reading true for a Brave-backed Gemini is a name
   * that lies. The old name stays as a deprecated alias below, so a reader that
   * has not been updated gets the right value instead of `undefined`.
   */
  searchSurchargeEligible: boolean;
  /** @deprecated Read `searchSurchargeEligible`. */
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
  backendReadiness,
}: {
  models: ReadonlyArray<Pick<AiModel, "id" | "usageClass" | "creditWeight">>;
  estimatedInputTokens: number;
  webSearchMode: WebSearchMode;
  /**
   * Which application-managed search backends this deployment can reach.
   *
   * Required, so a caller that has not been handed the server's answer cannot
   * quietly produce an estimate that assumes one.
   */
  backendReadiness: WebSearchBackendReadiness;
}): RequestCreditEstimate => {
  const perModel = models.map((model): ModelCreditEstimate => {
    const capability = getWebSearchCapability(model.id);
    const surcharge = getWebSearchSurchargeCredits(
      webSearchMode,
      capability,
      backendReadiness
    );
    const eligible = modelEligibleForWebSearchSurcharge(
      capability,
      backendReadiness
    );
    return {
      modelId: model.id,
      baseCredits: getModelUsageCredits(model),
      weightedBaseCredits: getWeightedUsageCredits(model, estimatedInputTokens),
      webSearchSurchargeCredits: surcharge,
      totalCredits:
        getWeightedUsageCredits(model, estimatedInputTokens) + surcharge,
      searchSurchargeEligible: eligible,
      nativeSearchEligible: eligible,
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
