/**
 * The counter that makes an application-managed web search affordable.
 *
 * Everything else about this feature is arrangement; this is the part that has
 * to be true. The reservation authorizes five backend requests for one model on
 * one turn, and the only reason five is a real number rather than a hope is
 * that the sixth call returns without opening a socket. Not because the system
 * prompt asked for five, not because `stopWhen` caps the tool loop at some
 * number of steps, not because the provider's project quota happens to be low:
 * because this object refuses.
 *
 * That distinction is the whole design. A ceiling enforced by anything the
 * model can decide to ignore -- a sentence in a prompt, a convention, an
 * observed average -- is a ceiling that holds until the first turn where it
 * matters. `stopWhen` is closer but still wrong: it bounds *steps*, and a
 * single step can carry several parallel tool calls, so a step budget is not a
 * request budget.
 *
 * ## Attempts and successes are different numbers
 *
 * The ceiling counts *claims*: every call that is going to reach the network,
 * whether or not it comes back. If it counted only successes, a backend having
 * a bad minute would let one turn retry indefinitely at full speed.
 *
 * Settlement counts *successes*: the vendor bills for requests it served, and
 * a request that came back 429 was not one. So a turn that claims five and
 * succeeds twice is bounded at five and billed for two, and the reservation
 * hands the other three back.
 *
 * ## Why this is pure
 *
 * No `server-only`, no fetch, no SDK. The ceiling is the part most worth
 * testing exhaustively -- "the sixth call makes no request" is a claim about
 * this object and nothing else -- and a test for it should not need a provider
 * package in scope. `lib/appManagedWebSearchTool.ts` is the thin server half
 * that owns the actual call.
 */

import {
  APP_MANAGED_SEARCH_LIMITS,
  type WebSearchBackend,
  type WebSearchBackendResult,
} from "@/lib/webSearchBackends";

/** Why a tool call produced no backend request. */
export type AppManagedSearchRefusal =
  /** The turn has already used every search it was authorized for. */
  | "query_limit_reached"
  /** The query itself was unusable; nothing was spent. */
  | "invalid_query";

export type AppManagedSearchClaim =
  | { ok: true; queryIndex: number; remaining: number }
  | { ok: false; reason: "query_limit_reached"; remaining: 0 };

/** One source this turn's searches actually returned. */
export type AppManagedSearchSource = {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
};

export type AppManagedSearchSnapshot = {
  backend: WebSearchBackend;
  /** Requests that reached the network. Bounded by the ceiling. */
  backendRequestCount: number;
  /** Requests the backend served. What settlement is priced on. */
  succeededRequestCount: number;
  /** Tool calls refused before any request, by reason. Never billed. */
  refusedCallCount: number;
  /** True once at least one request succeeded. Gates the surcharge. */
  executed: boolean;
  /** Distinct sources, in the order they were first returned. */
  sources: AppManagedSearchSource[];
  /**
   * The first failure this turn hit, if any, and only when nothing succeeded
   * afterwards. A turn that failed once and then searched successfully is not
   * a failed search.
   */
  failureCode?: string;
  maxQueries: number;
};

/**
 * How many sources one turn may accumulate across all of its searches.
 *
 * Five requests times five results is twenty-five, and a citation list of
 * twenty-five is not a citation list. This bounds what is *kept and shown*; it
 * does not bound what the model saw, which is bounded by the payload ceiling
 * per request.
 */
export const APP_MANAGED_MAX_SOURCES = 15;

export type AppManagedSearchSession = {
  readonly backend: WebSearchBackend;
  readonly maxQueries: number;
  /**
   * Reserves one backend request, or refuses.
   *
   * Increments before the call rather than after it, so two tool calls the
   * provider issued in the same step cannot both read "four used" and both
   * proceed. The AI SDK executes a step's tool calls concurrently; a counter
   * that incremented on completion would be a counter that does not count.
   */
  claim(): AppManagedSearchClaim;
  recordSuccess(results: readonly WebSearchBackendResult[]): void;
  recordFailure(code: string): void;
  recordRefusal(reason: AppManagedSearchRefusal): void;
  remaining(): number;
  snapshot(): AppManagedSearchSnapshot;
};

export const createAppManagedSearchSession = (input: {
  backend: WebSearchBackend;
  /**
   * The ceiling, from the capability that sized the reservation. Passed rather
   * than read from `APP_MANAGED_SEARCH_LIMITS` so the number enforced here and
   * the number the money was authorized on are the same field travelling
   * together, not two constants that agree today.
   */
  maxQueries?: number;
}): AppManagedSearchSession => {
  const maxQueries = Math.max(
    0,
    Number.isSafeInteger(input.maxQueries ?? NaN)
      ? (input.maxQueries as number)
      : APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest
  );
  let claimed = 0;
  let succeeded = 0;
  let refused = 0;
  let failureCode: string | undefined;
  const sources = new Map<string, AppManagedSearchSource>();

  return {
    backend: input.backend,
    maxQueries,
    claim() {
      if (claimed >= maxQueries) {
        return { ok: false, reason: "query_limit_reached", remaining: 0 };
      }
      claimed += 1;
      return {
        ok: true,
        queryIndex: claimed,
        remaining: Math.max(0, maxQueries - claimed),
      };
    },
    recordSuccess(results) {
      succeeded += 1;
      // A success clears the standing failure: the turn did search, and
      // reporting it as failed would refund a surcharge that was earned and
      // label an answer that has sources as one that has none.
      failureCode = undefined;
      for (const result of results) {
        if (sources.size >= APP_MANAGED_MAX_SOURCES) break;
        if (sources.has(result.url)) continue;
        sources.set(result.url, {
          url: result.url,
          ...(result.title ? { title: result.title } : {}),
          ...(result.snippet ? { snippet: result.snippet } : {}),
          ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
        });
      }
    },
    recordFailure(code) {
      if (!failureCode) failureCode = code;
    },
    recordRefusal() {
      refused += 1;
    },
    remaining() {
      return Math.max(0, maxQueries - claimed);
    },
    snapshot() {
      return {
        backend: input.backend,
        backendRequestCount: claimed,
        succeededRequestCount: succeeded,
        refusedCallCount: refused,
        executed: succeeded > 0,
        sources: Array.from(sources.values()),
        ...(failureCode ? { failureCode } : {}),
        maxQueries,
      };
    },
  };
};
