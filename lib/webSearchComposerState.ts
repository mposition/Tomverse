// The composer used to render the web-search *mode* ("Web search · Use web
// search") and its *readiness* ("Search-ready 1 · Unsupported 0") as two
// separate blocks, so the normal all-supported case cost two rows and repeated
// the words "web search" twice. This derives one compact state from the same
// inputs the credit estimate already uses, so the chip, the exception row and
// the surcharge can never describe different selections.
import {
  getWebSearchCapability,
  webSearchIsDispatchable,
  type DispatchableWebSearchCapability,
} from "@/lib/webSearchCapability";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
import {
  modelEligibleForWebSearchSurcharge,
  WEB_SEARCH_SURCHARGE_CREDITS,
} from "@/lib/webSearchCredits";
import {
  normalizeWebSearchMode,
  type WebSearchMode,
  type WebSearchToggleMode,
} from "@/lib/appDefaults";

/**
 * Whether the composer may count this model as one that will search.
 *
 * The whole capability plus this deployment's backend readiness, never
 * `support` alone. `support: "native"` says the provider has a tool; it does
 * not say a request carrying it can be authorized. `support: "app-managed"`
 * says this application knows how to run one; it does not say this deployment
 * holds the credential. A model counted here is a model the chip promises will
 * search, and counting one on either of those grounds produces exactly the
 * failure this contract forbids: the composer says search-ready, the request is
 * sent, and the dispatch refuses it.
 */
export const modelSupportsWebSearch = (
  capability: DispatchableWebSearchCapability,
  readiness: WebSearchBackendReadiness
) => webSearchIsDispatchable(capability, readiness);

export type WebSearchComposerTone =
  /** Requested and every selected model can honour it. */
  | "neutral"
  /** Requested, but at least one selected model cannot search. */
  | "warning"
  /** Requested and no selected model can search at all. */
  | "blocked";

export type WebSearchComposerState = {
  /** Always one of the two states the switch offers, never the retired "auto". */
  mode: WebSearchToggleMode;
  /** The chip (and everything below it) is hidden entirely when false. */
  isVisible: boolean;
  selectedCount: number;
  supportedCount: number;
  unsupportedCount: number;
  /** Ids of the selected models that cannot search, for naming them in the detail. */
  unsupportedModelIds: string[];
  allUnsupported: boolean;
  tone: WebSearchComposerTone;
  /**
   * True only when there is a real exception worth its own affordance. The
   * healthy "0 unsupported" case deliberately produces no secondary line.
   */
  hasException: boolean;
  /** Upper bound of the extra credits this request may reserve for search. */
  estimatedSurchargeCredits: number;
};

export function deriveWebSearchComposerState({
  webSearchMode: storedMode,
  selectedModelIds,
  backendReadiness,
}: {
  webSearchMode: WebSearchMode;
  selectedModelIds: readonly string[];
  /**
   * Which application-managed search backends this deployment can reach,
   * resolved on the server and handed down as a prop.
   *
   * The composer cannot work this out for itself and must not try: the only
   * client-visible signal would be a public environment variable, which would
   * mean shipping the fact of a credential's existence to every browser. It is
   * required rather than optional so a caller that has not been wired to the
   * prop fails to compile instead of quietly promising a search this deployment
   * cannot run.
   */
  backendReadiness: WebSearchBackendReadiness;
}): WebSearchComposerState {
  // Normalized here as well as at every read path, because this is what the
  // chip, the exception row and the surcharge estimate are all derived from:
  // a stored "auto" reaching this function must not produce a chip promising
  // a search, or a credit ceiling for one.
  const webSearchMode = normalizeWebSearchMode(storedMode);
  const unsupportedModelIds: string[] = [];
  let supportedCount = 0;
  let estimatedSurchargeCredits = 0;

  for (const modelId of selectedModelIds) {
    const capability = getWebSearchCapability(modelId);
    if (modelSupportsWebSearch(capability, backendReadiness)) {
      supportedCount += 1;
    } else {
      unsupportedModelIds.push(modelId);
    }
    if (
      webSearchMode === "always" &&
      modelEligibleForWebSearchSurcharge(capability, backendReadiness)
    ) {
      estimatedSurchargeCredits += WEB_SEARCH_SURCHARGE_CREDITS;
    }
  }

  const selectedCount = selectedModelIds.length;
  const unsupportedCount = unsupportedModelIds.length;
  const isVisible = webSearchMode === "always";
  const allUnsupported = isVisible && selectedCount > 0 && supportedCount === 0;
  const hasException = isVisible && unsupportedCount > 0;

  return {
    mode: webSearchMode,
    isVisible,
    selectedCount,
    supportedCount,
    unsupportedCount,
    unsupportedModelIds,
    allUnsupported,
    tone: !isVisible
      ? "neutral"
      : allUnsupported
        ? "blocked"
        : hasException
          ? "warning"
          : "neutral",
    hasException,
    estimatedSurchargeCredits,
  };
}
