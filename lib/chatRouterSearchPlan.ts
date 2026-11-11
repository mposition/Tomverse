import { APP_MANAGED_SEARCH_LIMITS, validateSearchQuery } from "./webSearchBackends";

// Leave at least three of the existing five searches for dependent follow-ups.
export const ROUTER_SEARCH_MAX_QUERIES = 2;
export const ROUTER_SEARCH_OUTPUT_TOKENS = 240;
export const routerSearchQueriesSchema = {
  type: "array" as const,
  maxItems: ROUTER_SEARCH_MAX_QUERIES,
  items: { type: "string" as const, maxLength: APP_MANAGED_SEARCH_LIMITS.maxQueryCharacters },
};

export const routerSearchInstructions = (date: string) =>
  `Also return searchQueries: zero to ${ROUTER_SEARCH_MAX_QUERIES} short, independent web queries. Today is ${date} (UTC). ` +
  "Use [] unless external evidence is needed for the answer (current facts or requested sources). " +
  "Use [] for rewriting, coding from supplied material, arithmetic, image creation, or missing context. " +
  "Use [] when requiresFileGeneration is true or it is unclear whether the user wants a downloadable file. " +
  "Do not guess facts or a device location. If the question needs the user's current location, use [] and let the answer model search with the consented location. " +
  "Queries must stand alone, preserve the user's constraints, and not depend on earlier search results. " +
  "Use the language and names used by primary sources. For a named city and today’s weather, seek the local official forecast and recent observations in parallel, without assuming UTC is the local date. " +
  "Return simpleLookup=true only for an unambiguous direct factual lookup such as ordinary weather in a named city. Return false for analysis, comparison, calculations, safety-critical advice, explicit requests for reasoning, or unclear requests, including constraints in the conversation. " +
  "Do not plan the full investigation: the answer model can resolve missing facts with follow-up searches. " +
  "These are suggestions only; they do not enable a tool or change a budget.";

/** Model suggestions are data, never permission to search. */
export function parseRouterSearchQueries(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ROUTER_SEARCH_MAX_QUERIES) return [];
  const queries: string[] = [];
  for (const item of value) {
    const parsed = validateSearchQuery(item);
    if (!parsed.ok) return [];
    if (!queries.includes(parsed.query)) queries.push(parsed.query);
  }
  return queries;
}
