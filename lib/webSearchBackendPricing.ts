/**
 * What one application-managed search request costs this application, and
 * where that number came from.
 *
 * A separate registry from `lib/modelPricing.ts` on purpose. That file prices
 * *models* -- tokens a provider bills for generating an answer -- and the two
 * are different products bought from different vendors on different invoices.
 * Folding a Brave request rate into a Google model's price profile would make
 * the search half of a turn's cost inseparable from its token half in every
 * report downstream, which is exactly the separation
 * docs/policy/credit-and-cost-limits.md asks for between a provider's spend and
 * a search provider's.
 *
 * It is emphatically *not* the same number as
 * `NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY`. That table holds what OpenAI,
 * Anthropic and Google charge for running their own search tool; Google's
 * 14,000 micro-USD there is the Gemini grounding list rate and has nothing to
 * do with what Brave charges for an HTTP request. Reusing it would price a
 * Brave-backed turn at 2.8x its real cost and would put the wrong figure in
 * the audit trail.
 *
 * ## Changing a price
 *
 * A price change is not retroactive. `pricingVersion` and the resolved rate are
 * frozen into the reservation before dispatch, and settlement prices the turn
 * at the frozen rate -- so editing a number here changes what *future* turns
 * are authorized at and never what a past turn is billed. Record the official
 * source and the date it was read in `priceSource`, and move `effectiveDate`
 * with the change.
 */

import {
    APP_MANAGED_SEARCH_LIMITS,
    type WebSearchBackend,
} from "@/lib/webSearchBackends";

export type SearchBackendPriceProfile = {
    backend: WebSearchBackend;
    /**
     * Cost of one backend request, in micro-USD.
     *
     * Per *request*, not per result and not per query the model wrote: the
     * vendor bills per HTTP call, the executor makes exactly one call per tool
     * invocation, and the counter counts calls. All three units are the same
     * unit, which is what lets the reservation and the settlement be compared
     * at all.
     */
    costMicroUsdPerRequest: number;
    /** The official price page, and the date it was read. Audit data. */
    priceSource: string;
    pricingVersion: string;
    /** ISO date this rate took effect for this application. */
    effectiveDate: string;
};

/**
 * Brave Search API, "Data for AI" plan: US$5.00 per 1,000 requests, which is
 * 5,000 micro-USD each.
 *
 * The free monthly allowance is deliberately ignored in this figure. An
 * internal cost estimate that spends the free tier first is an estimate that
 * understates every turn until the allowance runs out and then jumps -- and
 * the budget it feeds exists to bound the worst case, not the cheap one. The
 * same reasoning already applies to Google grounding's free quota in
 * `NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY`.
 */
export const SEARCH_BACKEND_PRICE_PROFILES: Readonly<
    Record<WebSearchBackend, SearchBackendPriceProfile>
> = {
    brave: {
        backend: "brave",
        costMicroUsdPerRequest: 5_000,
        priceSource:
            "https://brave.com/search/api/ -- Data for AI, US$5.00 per 1,000 requests; read 2026-08-27",
        pricingVersion: "search-backend-brave-2026-08-27",
        effectiveDate: "2026-08-27",
    },
};

export const getSearchBackendPriceProfile = (
    backend: WebSearchBackend | undefined
): SearchBackendPriceProfile | undefined =>
    backend ? SEARCH_BACKEND_PRICE_PROFILES[backend] : undefined;

export const getSearchBackendCostMicroUsdPerRequest = (
    backend: WebSearchBackend | undefined
): number | undefined => getSearchBackendPriceProfile(backend)?.costMicroUsdPerRequest;

/**
 * The worst a single model's search can cost in a single turn.
 *
 * Ceiling times rate, rounded up for the same reason every other reservation
 * component is: a reservation short by a fraction is short. Five requests at
 * 5,000 micro-USD is 25,000 micro-USD -- US$0.025 -- per model per turn.
 */
export const searchBackendWorstCaseCostMicroUsd = (
    backend: WebSearchBackend | undefined,
    maxQueries: number = APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest
): number | undefined => {
    const rate = getSearchBackendCostMicroUsdPerRequest(backend);
    if (!rate || rate <= 0) return undefined;
    if (!Number.isSafeInteger(maxQueries) || maxQueries <= 0) return undefined;
    return Math.ceil(rate * maxQueries);
};
