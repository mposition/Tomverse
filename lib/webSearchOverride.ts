/**
 * An administrator's per-model override of the web search route.
 *
 * Stored on `ModelRegistryEntry.webSearchOverride`. NULL is the default and
 * means "follow the code": the register in `lib/webSearchCapability.ts` for a
 * model it lists, the provider rule for one it does not. A value is a decision
 * someone made in the Admin Console, and it can only ever move a model onto a
 * route whose worst case this application already bounds:
 *
 * - `off` -- the model does not search. For a model whose function calling is
 *   unreliable, or one an operator wants out of the search budget.
 * - `app-managed` -- the model searches through this application's own backend
 *   (Brave), whatever its provider offers. Bounded by the executor's counter,
 *   priced by the backend's own profile.
 *
 * There is deliberately no value for a provider's native tool. Whether a
 * model's native search exists, what one query costs and what ceiling the
 * request can enforce are facts `reserveNativeSearchCost` sizes money on; they
 * are verified per model and written into the register in code, where a wrong
 * one fails review rather than an invoice. See
 * docs/policy/credit-and-cost-limits.md.
 *
 * Pure and dependency-free: the model catalogue, the capability resolver, the
 * admin schema and the database CHECK all read this one list.
 */

export const WEB_SEARCH_OVERRIDES = ["off", "app-managed"] as const;

export type WebSearchOverride = (typeof WEB_SEARCH_OVERRIDES)[number];

export const isWebSearchOverride = (value: unknown): value is WebSearchOverride =>
  typeof value === "string" &&
  (WEB_SEARCH_OVERRIDES as readonly string[]).includes(value);

/**
 * Providers whose models take no override at all.
 *
 * Perplexity's chat models search inside every completion; there is no switch
 * to turn off, so `off` would make every badge claim a search did not happen
 * when it did. `app-managed` would add a second, separately billed search on
 * top of the one the answer already ran. Neither can be honoured, so neither
 * is accepted.
 */
export const WEB_SEARCH_OVERRIDE_REFUSED_PROVIDERS: ReadonlySet<string> = new Set([
  "perplexity",
]);

/** Why this override cannot be saved for this provider, or null when it can. */
export const webSearchOverrideRefusal = (
  provider: string,
  override: WebSearchOverride | null | undefined
): string | null => {
  if (override == null) return null;
  if (WEB_SEARCH_OVERRIDE_REFUSED_PROVIDERS.has(provider)) {
    return "Perplexity models search inside every answer, so their web search route cannot be overridden.";
  }
  return null;
};
