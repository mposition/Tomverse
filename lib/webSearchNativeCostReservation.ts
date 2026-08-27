/**
 * What a native web search may cost, decided before the request is sent.
 *
 * A provider-native search is charged per query, on top of tokens, and until
 * now nothing reserved it. `getChatBudgetReservedCostMicroUsd` covered the
 * token cost only, and settlement added `searchCostMicroUsd` afterwards -- so
 * the search half of a turn's provider spend was recorded after the fact and
 * had never been checked against the provider budget the guardrail exists to
 * bound. A budget that only learns about spend once it has happened is a
 * budget that keeps saying yes.
 *
 * ## Why the ceiling has to be enforced, not estimated
 *
 * Reserving the worst case only works if there is a worst case, and a worst
 * case exists only where the request imposes one. Two providers let it:
 *
 * - Anthropic's `web_search_20250305` tool takes `maxUses`, and
 *   `buildWebSearchToolConfig` sends it, so five is a real ceiling and five
 *   queries' worth is a real reservation.
 * - OpenAI's Responses API takes `max_tool_calls`, which bounds the built-in
 *   tool calls one Response may make. The installed @ai-sdk/openai sends it
 *   from `providerOptions.openai.maxToolCalls`, and
 *   `getModelGenerationSettings` puts it there on every turn that attaches
 *   the native search. So OpenAI is bounded too -- it was not always read
 *   that way, and a whole family of models, the default one included, was
 *   refused here as a result.
 *
 * Google's Search grounding still takes neither: no `maxUses` on the tool and
 * no per-request cap, so the worst case there is "as many as the model
 * decides", which no number covers.
 *
 * The tempting move is to pick something from observed traffic -- most turns
 * search once or twice, so reserve three and move on. That is a reservation
 * which is correct exactly when it does not matter and wrong exactly when it
 * does, and the failure it produces is silent overspend on a budget that
 * believed it was bounded. So a paid search with no enforceable ceiling is
 * refused before dispatch instead.
 *
 * What this module does *not* do is decide what a surface may offer. That is
 * `nativeSearchIsDispatchable` in `lib/webSearchCapability.ts`, which every
 * surface asks so that nothing is offered that would be refused here. This
 * stays fail-closed for whatever still reaches it.
 *
 * A search model like Perplexity is not this: its search is inside the
 * response cost the provider reports, `hasAdditionalCost` is false, and there
 * is no separate per-query charge to reserve.
 */

import { getNativeSearchCostMicroUsdPerQuery } from "@/lib/modelPricing";
import type { AiModel } from "@/lib/models";
import type { WebSearchCapability } from "@/lib/webSearchCapability";
import type { WebSearchBackend } from "@/lib/webSearchBackends";
import {
    getSearchBackendPriceProfile,
    searchBackendWorstCaseCostMicroUsd,
} from "@/lib/webSearchBackendPricing";

export type NativeSearchReservation =
    | {
          ok: true;
          /** Zero when the turn attaches no paid native search. */
          reservedCostMicroUsd: number;
          costPerQueryMicroUsd: number;
          maxQueries: number;
      }
    | { ok: false; reason: NativeSearchRefusal };

export type NativeSearchRefusal =
    /** The capability charges per query and declares no enforceable ceiling. */
    | "unbounded_search_queries"
    /** The capability charges per query and the catalogue has no rate for it. */
    | "unpriced_search_queries"
    /** The ceiling was exceeded before, so this capability is not dispatching. */
    | "search_query_ceiling_breached"
    /**
     * An application-managed capability with no usable backend: the register
     * names one this build does not price, or the caller enabled the search
     * without the deployment being able to reach it.
     *
     * Distinct from `unbounded_search_queries` because the two are fixed in
     * different places -- one by a provider shipping a parameter, the other by
     * an environment variable.
     */
    | "search_backend_unavailable";

/**
 * Which budget the reserved amount belongs to.
 *
 * The reason this is a value rather than something derived later from the
 * model's provider: an application-managed search is paid to a search vendor,
 * not to the model's provider, and a reservation that could not say so would
 * have its spend counted against Google's operational budget. Two invoices, two
 * buckets -- docs/policy/credit-and-cost-limits.md.
 */
export type SearchCostScope =
    | { kind: "provider_native"; provider: string }
    | { kind: "search_backend"; backend: WebSearchBackend };

/**
 * Capabilities whose declared ceiling a provider has already exceeded.
 *
 * A provider that billed more searches than the request authorized has broken
 * the assumption every reservation for it rests on, so it stops dispatching:
 * continuing would keep authorizing amounts demonstrated not to bound
 * anything.
 *
 * This used to be one per-process Set, with a comment conceding that "the
 * durable stop is disabling the model or the feature". That was the wrong
 * shape for what actually happens. The latch fired on staging on 2026-08-26,
 * and the next deploy would have cleared it silently -- so the guarantee was
 * really "safe until the next deploy", which is not a guarantee, and on more
 * than one instance only the instance that saw the overshoot stopped.
 *
 * So there are two sets now, and the split matters:
 *
 * - `localBreaches` is what *this* process observed. Append-only, never
 *   cleared by a refresh, because a durable write that failed must not be
 *   able to un-latch the process that saw the breach.
 * - `durableBreaches` is the shared record, replaced wholesale on each
 *   refresh. Replaced rather than merged so that an operator who has dealt
 *   with a breach can clear the row and have every instance resume within one
 *   refresh, instead of needing a deploy to forget.
 *
 * The store and the refresh live in `lib/webSearchCeilingBreachStore.ts`;
 * this module stays synchronous and free of database access so the reservation
 * path is still a pure function of the catalogue.
 */
const localBreaches = new Set<string>();
const durableBreaches = new Set<string>();

export const recordSearchQueryCeilingBreach = (provider: string) => {
    localBreaches.add(provider);
};

/**
 * Replaces the shared half of the latch. Called by the refresh, never by a
 * request path deciding anything.
 */
export const applyDurableSearchQueryCeilingBreaches = (
    providers: Iterable<string>
) => {
    durableBreaches.clear();
    for (const provider of providers) durableBreaches.add(provider);
};

export const searchQueryCeilingBreached = (provider: string) =>
    localBreaches.has(provider) || durableBreaches.has(provider);

/** Test seam. Never called on a request path. */
export const resetSearchQueryCeilingBreaches = () => {
    localBreaches.clear();
    durableBreaches.clear();
};

/**
 * The worst case an application-managed search may cost, or why it cannot run.
 *
 * Priced from the search backend's own registry, never from
 * `NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY`. Reusing Google's grounding rate for
 * a Brave request would overstate every Gemini turn by 2.8x and would put a
 * figure in the audit trail that no invoice will ever match.
 *
 * The ceiling comes from `requestEnforcedSearchQueries` -- the same field the
 * executor's counter is built from -- so the number the money is authorized on
 * and the number the sixth call is refused at travel together.
 */
export const reserveAppManagedSearchCost = (input: {
    capability: Pick<
        WebSearchCapability,
        | "support"
        | "searchBackend"
        | "hasAdditionalCost"
        | "requestEnforcedSearchQueries"
        | "maxBillableSearchQueriesPerRequest"
    >;
    appManagedSearchEnabled: boolean;
}): NativeSearchReservation => {
    const { capability, appManagedSearchEnabled } = input;
    if (!appManagedSearchEnabled || !capability.hasAdditionalCost) {
        return {
            ok: true,
            reservedCostMicroUsd: 0,
            costPerQueryMicroUsd: 0,
            maxQueries: 0,
        };
    }
    const backend = capability.searchBackend;
    if (!backend) {
        return { ok: false, reason: "search_backend_unavailable" };
    }
    if (searchQueryCeilingBreached(searchBackendLatchKey(backend))) {
        return { ok: false, reason: "search_query_ceiling_breached" };
    }
    const maxQueries = capability.requestEnforcedSearchQueries;
    if (!maxQueries || maxQueries <= 0) {
        return { ok: false, reason: "unbounded_search_queries" };
    }
    const profile = getSearchBackendPriceProfile(backend);
    const reserved = searchBackendWorstCaseCostMicroUsd(backend, maxQueries);
    if (!profile || reserved === undefined) {
        return { ok: false, reason: "unpriced_search_queries" };
    }
    return {
        ok: true,
        reservedCostMicroUsd: reserved,
        costPerQueryMicroUsd: profile.costMicroUsdPerRequest,
        maxQueries,
    };
};

/**
 * How a search backend is named in the ceiling-breach latch.
 *
 * Prefixed so it can never collide with a model provider's name. The latch is
 * one namespace shared by both routes, and a backend called `google` -- there
 * is no reason one could not be -- would otherwise stop Gemini's *token*
 * traffic by stopping a search vendor.
 */
export const searchBackendLatchKey = (backend: string) =>
    `search-backend:${backend}`;

/**
 * The worst case this turn's native search can cost, or why it cannot be run.
 *
 * `nativeSearchEnabled` is the caller's decision that a native tool is being
 * attached; everything else is read from the catalogue, so the reservation and
 * the request cannot disagree about which model is searching.
 */
export const reserveNativeSearchCost = (input: {
    model: AiModel;
    capability: WebSearchCapability;
    nativeSearchEnabled: boolean;
}): NativeSearchReservation => {
    const { capability, nativeSearchEnabled } = input;
    // Not searching, or searching at no extra charge. A search model's cost is
    // inside the response cost its provider reports.
    if (!nativeSearchEnabled || !capability.hasAdditionalCost) {
        return {
            ok: true,
            reservedCostMicroUsd: 0,
            costPerQueryMicroUsd: 0,
            maxQueries: 0,
        };
    }

    const provider = capability.provider ?? input.model.provider;
    if (searchQueryCeilingBreached(provider)) {
        return { ok: false, reason: "search_query_ceiling_breached" };
    }

    const maxQueries = capability.maxBillableSearchQueriesPerRequest;
    if (!maxQueries || maxQueries <= 0) {
        return { ok: false, reason: "unbounded_search_queries" };
    }

    const costPerQueryMicroUsd = getNativeSearchCostMicroUsdPerQuery(provider);
    if (!costPerQueryMicroUsd || costPerQueryMicroUsd <= 0) {
        return { ok: false, reason: "unpriced_search_queries" };
    }

    return {
        ok: true,
        // Ceiling times rate. Rounded up for the same reason every other
        // component is: a reservation that is short by a fraction is short.
        reservedCostMicroUsd: Math.ceil(costPerQueryMicroUsd * maxQueries),
        costPerQueryMicroUsd,
        maxQueries,
    };
};

/**
 * What the provider says it actually ran, checked against what was authorized.
 *
 * Over the ceiling is not clamped. The provider is going to bill for what it
 * did, and a ledger that recorded the authorized figure instead would be
 * accurate about the authorization and wrong about the money -- which is the
 * direction that hides the problem. The full cost is kept, the breach is an
 * incident, and the capability stops dispatching.
 */
export const settledNativeSearchCost = (input: {
    provider: string;
    queryCount: number;
    costPerQueryMicroUsd: number;
    maxQueries: number;
}): { costMicroUsd: number; breachedCeiling: boolean } => {
    const queries = Number.isSafeInteger(input.queryCount)
        ? Math.max(0, input.queryCount)
        : 0;
    return {
        costMicroUsd: Math.ceil(queries * input.costPerQueryMicroUsd),
        breachedCeiling: input.maxQueries > 0 && queries > input.maxQueries,
    };
};

/**
 * When authorizations began being frozen into reservations.
 *
 * A reservation created before it settles on the caller's figure and is not a
 * defect -- it was dispatched correctly under the older contract, and failing
 * it or dropping its cost would punish a turn that did nothing wrong. One
 * created after it and carrying none is a writer that stopped filling it.
 *
 * Unset means the two cannot be told apart, and the honest answer there is the
 * lenient one: settle on the caller's figure and say nothing. The alternative
 * would page about every legacy turn on a deployment that never set it.
 */
export const NATIVE_SEARCH_AUTHORIZATION_CUTOVER_ENV =
    "NATIVE_SEARCH_AUTHORIZATION_CUTOVER_AT";

export const missingAuthorizationIsADefect = (reservationCreatedAt: Date) => {
    const raw = process.env[NATIVE_SEARCH_AUTHORIZATION_CUTOVER_ENV]?.trim();
    if (!raw) return false;
    const cutover = new Date(raw);
    if (Number.isNaN(cutover.getTime())) return false;
    return reservationCreatedAt >= cutover;
};

/**
 * Both halves of one turn's search authorization, decided together.
 *
 * Four call sites need this exact pair -- the chat route, the fallback plan,
 * preflight and availability -- and each of them used to compute the native
 * half alone. Adding a second route by letting each of them remember to also
 * call the app-managed reservation is how three of them end up doing it and one
 * does not, and the one that does not dispatches a search nobody reserved.
 *
 * The two never both apply: a capability is native or application-managed, and
 * the enabled flags come from that same capability. Returning both anyway keeps
 * the caller from having to know which, and keeps the budget wiring reading one
 * shape.
 */
export type TurnSearchCostReservation =
    | {
          ok: true;
          /** The model provider's own search charge. Zero for every other route. */
          native: {
              reservedCostMicroUsd: number;
              costPerQueryMicroUsd: number;
              maxQueries: number;
          };
          /**
           * The search vendor's charge, and which vendor. Null when this turn
           * runs no application-managed search -- which is not the same as zero,
           * and the difference is whether a hold is placed on the search budget
           * at all.
           */
          searchBackend: {
              backend: WebSearchBackend;
              reservedCostMicroUsd: number;
              costPerQueryMicroUsd: number;
              maxQueries: number;
              pricingVersion: string;
          } | null;
      }
    | { ok: false; reason: NativeSearchRefusal };

export const reserveTurnSearchCost = (input: {
    model: AiModel;
    capability: WebSearchCapability;
    /** A provider-native tool is being attached. */
    nativeSearchEnabled: boolean;
    /** This application's own search tool is being registered. */
    appManagedSearchEnabled: boolean;
}): TurnSearchCostReservation => {
    const native = reserveNativeSearchCost({
        model: input.model,
        capability: input.capability,
        nativeSearchEnabled: input.nativeSearchEnabled,
    });
    if (!native.ok) return { ok: false, reason: native.reason };

    const appManaged = reserveAppManagedSearchCost({
        capability: input.capability,
        appManagedSearchEnabled: input.appManagedSearchEnabled,
    });
    if (!appManaged.ok) return { ok: false, reason: appManaged.reason };

    const backend = input.capability.searchBackend;
    const profile = getSearchBackendPriceProfile(backend);
    return {
        ok: true,
        native: {
            reservedCostMicroUsd: native.reservedCostMicroUsd,
            costPerQueryMicroUsd: native.costPerQueryMicroUsd,
            maxQueries: native.maxQueries,
        },
        searchBackend:
            input.appManagedSearchEnabled && backend && profile && appManaged.maxQueries > 0
                ? {
                      backend,
                      reservedCostMicroUsd: appManaged.reservedCostMicroUsd,
                      costPerQueryMicroUsd: appManaged.costPerQueryMicroUsd,
                      maxQueries: appManaged.maxQueries,
                      // Frozen with the rest of the authorization, so settlement
                      // prices the searches this turn was allowed rather than
                      // the ones today's price list would sell.
                      pricingVersion: profile.pricingVersion,
                  }
                : null,
    };
};

/**
 * What the application-managed searches actually cost, priced at what was
 * authorized.
 *
 * Successes, not attempts. The vendor bills for requests it served; a 429 was
 * not one. The counter bounds attempts so a failing backend cannot be retried
 * without limit, and this bounds money to what was actually bought.
 *
 * `breachedCeiling` should be unreachable -- the counter refuses the sixth call
 * in this process, so there is no provider to disagree with. It is still
 * computed and still latches, because "unreachable" here means "unless this
 * application has a bug", and the bug's symptom would otherwise be a quiet
 * overspend rather than a stopped feature.
 */
export const settledAppManagedSearchCost = (input: {
    succeededRequestCount: number;
    costPerQueryMicroUsd: number;
    maxQueries: number;
}): { costMicroUsd: number; breachedCeiling: boolean } => {
    const requests = Number.isSafeInteger(input.succeededRequestCount)
        ? Math.max(0, input.succeededRequestCount)
        : 0;
    return {
        costMicroUsd: Math.ceil(requests * input.costPerQueryMicroUsd),
        breachedCeiling: input.maxQueries > 0 && requests > input.maxQueries,
    };
};
