/**
 * The native-search cost refusal's error code, on its own.
 *
 * Split out of `lib/webSearchCostRefusal.ts` because that module is
 * `server-only` -- it builds a `ChatAccessError` and writes a
 * `ChatLimitDecisionEvent` -- and a client now has to recognise the code.
 * The web-search offer tells "the server refused the search itself" apart from
 * "the request failed", because the first is not something a retry or an
 * account setting can change and the second is
 * (`lib/webSearchRetrySuggestion.ts`).
 *
 * Only the string lives here. Everything that raises, classifies or records
 * the refusal stays behind the server boundary, so a client can name the code
 * without being able to construct the refusal.
 */
export const WEB_SEARCH_COST_UNBOUNDED = "WEB_SEARCH_COST_UNBOUNDED";
