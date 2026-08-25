// The composer used to render the web-search *mode* ("Web search · Use web
// search") and its *readiness* ("Search-ready 1 · Unsupported 0") as two
// separate blocks, so the normal all-supported case cost two rows and repeated
// the words "web search" twice. This derives one compact state from the same
// inputs the credit estimate already uses, so the chip, the exception row and
// the surcharge can never describe different selections.
import {
  getWebSearchCapability,
  webSearchIsDispatchable,
  type WebSearchCapability,
} from "@/lib/webSearchCapability";
import {
  modelEligibleForWebSearchSurcharge,
  WEB_SEARCH_SURCHARGE_CREDITS,
} from "@/lib/webSearchCredits";
import type { WebSearchMode } from "@/lib/appDefaults";

/**
 * Whether the composer may count this model as one that will search.
 *
 * The whole capability, not its `support` alone. `support: "native"` says the
 * provider has a tool; it does not say a request carrying it can be
 * authorized, and a model counted here is a model the chip promises will
 * search. Counting one whose search cost has no ceiling produced exactly the
 * failure this contract forbids: the composer said search-ready, the request
 * was sent, and the dispatch refused it.
 */
export const modelSupportsWebSearch = (
  capability: Pick<
    WebSearchCapability,
    "support" | "hasAdditionalCost" | "maxBillableSearchQueriesPerRequest"
  >
) => webSearchIsDispatchable(capability);

export type WebSearchComposerTone =
  /** Requested and every selected model can honour it. */
  | "neutral"
  /** Requested, but at least one selected model cannot search. */
  | "warning"
  /** Requested and no selected model can search at all. */
  | "blocked";

export type WebSearchComposerState = {
  mode: WebSearchMode;
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
  webSearchMode,
  selectedModelIds,
}: {
  webSearchMode: WebSearchMode;
  selectedModelIds: readonly string[];
}): WebSearchComposerState {
  const unsupportedModelIds: string[] = [];
  let supportedCount = 0;
  let estimatedSurchargeCredits = 0;

  for (const modelId of selectedModelIds) {
    const capability = getWebSearchCapability(modelId);
    if (modelSupportsWebSearch(capability)) {
      supportedCount += 1;
    } else {
      unsupportedModelIds.push(modelId);
    }
    if (
      webSearchMode === "always" &&
      modelEligibleForWebSearchSurcharge(capability)
    ) {
      estimatedSurchargeCredits += WEB_SEARCH_SURCHARGE_CREDITS;
    }
  }

  const selectedCount = selectedModelIds.length;
  const unsupportedCount = unsupportedModelIds.length;
  const isVisible = webSearchMode !== "off";
  // "Auto" only *offers* a search, so a model that cannot search is not an
  // exception the user has to resolve before sending -- it becomes one once
  // the request is unconditional.
  const allUnsupported =
    isVisible && selectedCount > 0 && supportedCount === 0;
  const hasException =
    isVisible && webSearchMode === "always" && unsupportedCount > 0;

  return {
    mode: webSearchMode,
    isVisible,
    selectedCount,
    supportedCount,
    unsupportedCount,
    unsupportedModelIds,
    allUnsupported: allUnsupported && webSearchMode === "always",
    tone: !isVisible
      ? "neutral"
      : webSearchMode === "always" && allUnsupported
        ? "blocked"
        : hasException
          ? "warning"
          : "neutral",
    hasException,
    estimatedSurchargeCredits,
  };
}
