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
 * The model catalogue, the capability resolver, the admin schema and the
 * database CHECK all read one list.
 */

// The values live in lib/webSearchCapability.ts, which sits inside the Prompt
// Refiner runtime closure: defining them here and importing them there would
// have grown that pinned closure by this file. Everything outside the closure
// -- the admin schema, the registry panel, the enum-constraint check --
// imports from here.
import {
  WEB_SEARCH_OVERRIDES,
  WEB_SEARCH_OVERRIDE_REFUSED_PROVIDERS,
  isWebSearchOverride,
  type WebSearchOverride,
} from "@/lib/webSearchCapability";

export {
  WEB_SEARCH_OVERRIDES,
  WEB_SEARCH_OVERRIDE_REFUSED_PROVIDERS,
  isWebSearchOverride,
  type WebSearchOverride,
};

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
