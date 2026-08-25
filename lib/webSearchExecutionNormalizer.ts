import { sanitizeWebSearchCitations, type WebSearchCitation } from "@/lib/webSearchCitations";
import {
  nativeSearchIsDispatchable,
  webSearchIsDispatchable,
  type WebSearchCapability,
} from "@/lib/webSearchCapability";
import { getNativeSearchCostMicroUsdPerQuery } from "@/lib/modelPricing";

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
};

type UnknownContentPart = { type?: unknown; [key: string]: unknown };

// Per-query native-search prices live in the pricing registry alongside every
// other price this application charges, so a search price change is versioned
// and audited the same way a token price change is.

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
// part -- so citation extraction here is provider-agnostic too, rather than
// three separate raw-JSON parsers. Tool execution status still needs a
// per-call toolName match since `content` mixes every tool a request could
// have used (there's only ever one search tool per request in this app
// today, but this stays correct if that ever changes).
export function normalizeWebSearchExecution(args: {
  capability: WebSearchCapability;
  searchRequested: boolean;
  provider: string;
  toolName?: string;
  content?: readonly unknown[];
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
    providerCitations,
  } = args;
  // Dispatchability, not declared support: a model whose native search this
  // request could never have carried did not search, and reporting it as
  // "supported" would make the badge say the search was possible and simply
  // did not happen. `webSearchIsDispatchable` is the same answer the composer
  // and the credit estimate gave before the turn was sent.
  const supported = webSearchIsDispatchable(capability);

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
    return { requested: true, supported: true, executed: true, provider, citations };
  }

  if (!searchRequested) {
    return { requested: false, supported, executed: false, provider, citations: [] };
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
  };
}
