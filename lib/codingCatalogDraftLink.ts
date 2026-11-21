/**
 * The hand-off from the model discovery queue to the coding catalogue.
 *
 * A code-specialized model has no reason to enter Chat, so the queue sends it
 * to the coding catalogue's "dedicated model" draft form with the provider and
 * API model id already filled in: the operator never retypes an id. Pure and
 * client-safe, like `catalogImageDraftHref` in lib/runtimeImageProviders.ts.
 */

/**
 * Providers a coding draft can read: the code's own providers that have
 * official documentation hosts (`OFFICIAL_SOURCE_HOSTS` in
 * lib/modelCatalogCore.ts, which a client bundle cannot import).
 * tests/codingCatalogDraftLink.test.ts holds this list equal to that set.
 */
export const CODING_DRAFT_PROVIDERS = [
  "openai",
  "anthropic",
  "cohere",
  "google",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "moonshot",
  "minimax",
  "qwen",
  "zhipu",
  "perplexity",
] as const;

export const isCodingDraftProvider = (provider: string) =>
  (CODING_DRAFT_PROVIDERS as readonly string[]).includes(provider);

/**
 * Where the first provider that can be drafted saw the model: the row's own
 * provider, then the others that listed it. An aggregator sighting alone has no
 * official pages to read, so it returns null.
 */
export const codingDraftSighting = (input: {
  provider: string;
  apiModel: string;
  observedVia?: readonly { provider: string; apiModel: string }[];
}): { provider: string; apiModel: string } | null => {
  const sightings = [{ provider: input.provider, apiModel: input.apiModel }, ...(input.observedVia ?? [])];
  return sightings.find((sighting) => isCodingDraftProvider(sighting.provider)) ?? null;
};

/** Where the discovery queue sends a coding candidate: the coding catalogue, form prefilled. */
export const catalogCodingDraftHref = (provider: string, apiModelId: string) =>
  `/admin/models?${new URLSearchParams({ tab: "coding", draft: "coding", provider, api: apiModelId })}`;

/** Queue statuses an operator can still act on: adoption and drafts apply only to these. */
const ACTIONABLE_STATUSES = ["discovered", "awaiting_decision", "deferred", "approved", "implementation_pending"];

/**
 * What the queue row offers for a coding candidate: the prefilled draft link,
 * or the reason there is none. Null for every other row. A research proposal
 * counts -- the form needs a provider with official pages, not an adapter.
 */
export const codingDraftOffer = (row: {
  action: string;
  product: string;
  status: string;
  provider: string;
  apiModel: string;
  observedVia?: readonly { provider: string; apiModel: string }[];
}): { kind: "draft"; href: string } | { kind: "no_provider"; provider: string } | null => {
  if (row.action !== "add" || row.product !== "coding" || !ACTIONABLE_STATUSES.includes(row.status)) return null;
  const sighting = codingDraftSighting(row);
  return sighting
    ? { kind: "draft", href: catalogCodingDraftHref(sighting.provider, sighting.apiModel) }
    : { kind: "no_provider", provider: row.provider };
};

/** The query keys a coding draft link carries; the coding tab clears them once it has opened the form. */
export const CODING_DRAFT_QUERY_KEYS = ["draft", "provider", "api"] as const;

/** The draft a discovery link asks for (?draft=coding&provider=&api=), or null. */
export const codingDraftRequest = (search: string) => {
  const params = new URLSearchParams(search);
  if (params.get("draft") !== "coding") return null;
  const provider = params.get("provider")?.trim() ?? "";
  const apiModelId = params.get("api")?.trim() ?? "";
  if (!provider || !apiModelId) return null;
  return { provider, apiModelId };
};
