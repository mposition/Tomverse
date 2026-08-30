import { sanitizeWebSearchCitations, type WebSearchCitation } from "@/lib/webSearchCitations";
import {
  appManagedSearchIsDispatchable,
  nativeSearchIsDispatchable,
  webSearchIsDispatchable,
  type WebSearchCapability,
} from "@/lib/webSearchCapability";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
import type { AppManagedSearchSnapshot } from "@/lib/appManagedWebSearchCore";
import { getNativeSearchCostMicroUsdPerQuery } from "@/lib/modelPricing";
import { getSearchBackendCostMicroUsdPerRequest } from "@/lib/webSearchBackendPricing";

/** Which of the three routes produced (or would have produced) this turn's search. */
export type WebSearchExecutionKind =
  | "provider_native"
  | "search_model"
  | "app_managed";

export type WebSearchExecution = {
  requested: boolean;
  supported: boolean;
  executed: boolean;
  provider: string;
  tool?: string;
  queryCount?: number;
  citations: WebSearchCitation[];
  failureCode?: string;
  costMetadata?: Record<string, number>;
  /**
   * Which route this turn's search took.
   *
   * Absent on rows written before the application-managed route existed, which
   * is why every reader treats absence as "provider-native or search-model" --
   * the two that existed then -- rather than as a defect.
   */
  executionKind?: WebSearchExecutionKind;
  /** The search vendor, on an application-managed turn. Never the model's provider. */
  searchBackend?: string;
  /**
   * Backend requests that reached the network, successful or not.
   *
   * Reported beside `queryCount` rather than instead of it because they answer
   * different questions: this is what the ceiling bounded, `queryCount` is what
   * the vendor is owed for. A turn that tried five times and was rate-limited
   * three of them has five here and two there, and both numbers are needed to
   * tell "the model searched a lot" from "the backend was unwell".
   */
  backendRequestCount?: number;
};

type UnknownContentPart = { type?: unknown; [key: string]: unknown };

// Per-query native-search prices live in the pricing registry alongside every
// other price this application charges, so a search price change is versioned
// and audited the same way a token price change is. Application-managed backend
// prices live in their own registry for the same reason and a different
// invoice: lib/webSearchBackendPricing.ts.

const isToolPart = (
  part: unknown,
  partType: "tool-result" | "tool-error",
  toolName: string
): part is UnknownContentPart & { url?: string; title?: string } => {
  if (!part || typeof part !== "object") return false;
  const candidate = part as UnknownContentPart;
  return candidate.type === partType && candidate.toolName === toolName;
};

const isUrlSourcePart = (
  part: unknown
): part is { type: "source"; sourceType: "url"; url: string; title?: string } => {
  if (!part || typeof part !== "object") return false;
  const candidate = part as UnknownContentPart;
  return candidate.type === "source" && candidate.sourceType === "url";
};

// The Vercel AI SDK already normalizes provider-native search citations
// (OpenAI URL annotations, Anthropic web_search_result_location, Google
// grounding url_citation) into a single provider-agnostic `source` content
// part -- so citation extraction for the native route is provider-agnostic
// too, rather than three separate raw-JSON parsers. Tool execution status
// still needs a per-call toolName match since `content` mixes every tool a
// request could have used.
//
// The application-managed route does not read `content` at all. Its sources
// come from the session object the executor filled while the tool ran, which
// is the strongest provenance available anywhere in this feature: those URLs
// were returned by a backend request this process made and counted. Nothing is
// ever recovered from the model's own text -- a URL a model wrote is a string
// that looks like a citation, and treating it as one is how an answer gets a
// source list of pages that do not exist.
export function normalizeWebSearchExecution(args: {
  capability: WebSearchCapability;
  searchRequested: boolean;
  provider: string;
  toolName?: string;
  content?: readonly unknown[];
  /**
   * Which application-managed backends this deployment can reach.
   *
   * Needed here for the same reason the composer needs it: `supported` is the
   * badge's claim that the search was possible and simply did not happen, and
   * on a deployment with no backend key that claim is wrong.
   */
  backendReadiness: WebSearchBackendReadiness;
  /**
   * What the application-managed executor counted and collected, when this turn
   * ran one. Absent on every other route.
   */
  appManagedSearch?: AppManagedSearchSnapshot | null;
  /**
   * Citations read straight off the provider's own response body, for
   * providers whose sources never become AI SDK `source` parts. Perplexity
   * returns `citations`/`search_results` as top-level response fields, which
   * the OpenAI-compatible chat adapter it runs through does not carry over;
   * without this the answer keeps its "[1]" markers and the source list under
   * it is empty. These come first so their reference numbers survive
   * de-duplication, and `source` parts still supplement them.
   */
  providerCitations?: readonly WebSearchCitation[];
}): WebSearchExecution {
  const {
    capability,
    searchRequested,
    provider,
    toolName,
    content,
    backendReadiness,
    appManagedSearch,
    providerCitations,
  } = args;
  // Dispatchability, not declared support: a model whose search this request
  // could never have carried did not search, and reporting it as "supported"
  // would make the badge say the search was possible and simply did not
  // happen. `webSearchIsDispatchable` is the same answer the composer and the
  // credit estimate gave before the turn was sent.
  const supported = webSearchIsDispatchable(capability, backendReadiness);

  if (capability.support === "search-model") {
    // Perplexity's search-capable chat models search unconditionally as
    // part of normal completion, independent of the global webSearchMode
    // toggle -- selecting one of them always searches.
    const parts = Array.isArray(content) ? content : [];
    const citations = sanitizeWebSearchCitations([
      ...(providerCitations || []).map((citation) => ({
        ...citation,
        sourceProvider: citation.sourceProvider || provider,
      })),
      ...parts.filter(isUrlSourcePart).map((part) => ({
        url: part.url,
        title: part.title,
        sourceProvider: provider,
      })),
    ]);
    return {
      requested: true,
      supported: true,
      executed: true,
      provider,
      citations,
      executionKind: "search_model",
    };
  }

  if (!searchRequested) {
    return { requested: false, supported, executed: false, provider, citations: [] };
  }

  if (capability.support === "app-managed") {
    if (!appManagedSearchIsDispatchable(capability, backendReadiness)) {
      return {
        requested: true,
        supported: false,
        executed: false,
        provider,
        citations: [],
        executionKind: "app_managed",
      };
    }
    if (!appManagedSearch) {
      // The tool was registered and the model never called it. A real and
      // ordinary outcome -- "what is 2+2" with the switch on -- and the one the
      // surcharge refund exists for. Distinguished from a failure by carrying
      // no `failureCode`.
      return {
        requested: true,
        supported: true,
        executed: false,
        provider,
        tool: toolName,
        citations: [],
        executionKind: "app_managed",
        ...(capability.searchBackend
          ? { searchBackend: capability.searchBackend }
          : {}),
        backendRequestCount: 0,
        queryCount: 0,
      };
    }
    const citations = sanitizeWebSearchCitations(
      appManagedSearch.sources.map((source) => ({
        url: source.url,
        title: source.title,
        // The vendor that returned it, not the model's provider. A citation
        // list that credited Google for a Brave result would be wrong about
        // where the answer's evidence came from.
        sourceProvider: appManagedSearch.backend,
      }))
    );
    const rate = getSearchBackendCostMicroUsdPerRequest(
      appManagedSearch.backend
    );
    return {
      requested: true,
      supported: true,
      // Only a request the backend actually served counts as a search. A turn
      // whose five attempts were all rate-limited did not search, is refunded,
      // and says so.
      executed: appManagedSearch.executed,
      provider,
      tool: toolName,
      queryCount: appManagedSearch.succeededRequestCount,
      backendRequestCount: appManagedSearch.backendRequestCount,
      citations,
      executionKind: "app_managed",
      searchBackend: appManagedSearch.backend,
      ...(appManagedSearch.failureCode
        ? { failureCode: appManagedSearch.failureCode }
        : {}),
      ...(rate
        ? {
            costMetadata: {
              // Its own key, never `searchCostMicroUsd`. That field settles
              // against the *model provider's* budget, and a Brave charge put
              // there would be counted as money owed to Google.
              searchBackendCostMicroUsd:
                appManagedSearch.succeededRequestCount * rate,
            },
          }
        : {}),
    };
  }

  if (!nativeSearchIsDispatchable(capability) || !toolName) {
    return { requested: true, supported: false, executed: false, provider, citations: [] };
  }

  const parts = Array.isArray(content) ? content : [];
  const resultParts = parts.filter((part) => isToolPart(part, "tool-result", toolName));
  const errorParts = parts.filter((part) => isToolPart(part, "tool-error", toolName));
  const sourceParts = parts.filter(isUrlSourcePart);

  const executed = resultParts.length > 0;
  const citations = sanitizeWebSearchCitations(
    sourceParts.map((part) => ({ url: part.url, title: part.title, sourceProvider: provider }))
  );
  // resultParts.length is always >= 1 whenever executed is true, so this is
  // already the conservative "at least one query" floor the settlement
  // policy requires for providers that don't report a distinct count.
  const queryCount = executed ? resultParts.length : undefined;
  const failureCode = errorParts.length > 0 ? "provider_tool_error" : undefined;
  const costPerQuery = getNativeSearchCostMicroUsdPerQuery(provider);
  const costMetadata =
    queryCount && costPerQuery
      ? { searchCostMicroUsd: queryCount * costPerQuery }
      : undefined;

  return {
    requested: true,
    supported: true,
    executed,
    provider,
    tool: toolName,
    queryCount,
    citations,
    failureCode,
    costMetadata,
    executionKind: "provider_native",
  };
}
