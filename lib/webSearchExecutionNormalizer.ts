import { sanitizeWebSearchCitations, type WebSearchCitation } from "@/lib/webSearchCitations";
import type { WebSearchCapability } from "@/lib/webSearchCapability";

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

// Conservative internal per-query cost estimates for provider-native web
// search, in micro-USD (1,000,000 = US$1), used only for internal cost
// accounting (settledCostMicroUsd / provider spend buckets) -- never exposed
// as extra user-facing credits beyond the flat surcharge already reserved.
// OpenAI/Anthropic: documented flat $10 per 1,000 searches (i.e. $0.01 each).
// Google: Gemini native search's public list price is $14 per 1,000 requests
// past the free grounding quota; billed here at that rate regardless of
// quota so the internal estimate never understates cost. Perplexity is
// excluded -- its own reported response cost is used instead (see
// lib/perplexityUsageCore.ts), never this flat per-query estimate.
const NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY: Partial<Record<string, number>> = {
  openai: 10_000,
  anthropic: 10_000,
  google: 14_000,
};

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
}): WebSearchExecution {
  const { capability, searchRequested, provider, toolName, content } = args;
  const supported = capability.support === "native" || capability.support === "search-model";

  if (capability.support === "search-model") {
    // Perplexity's search-capable chat models search unconditionally as
    // part of normal completion, independent of the global webSearchMode
    // toggle -- selecting one of them always searches.
    const parts = Array.isArray(content) ? content : [];
    const citations = sanitizeWebSearchCitations(
      parts.filter(isUrlSourcePart).map((part) => ({
        url: part.url,
        title: part.title,
        sourceProvider: provider,
      }))
    );
    return { requested: true, supported: true, executed: true, provider, citations };
  }

  if (!searchRequested) {
    return { requested: false, supported, executed: false, provider, citations: [] };
  }

  if (capability.support !== "native" || !toolName) {
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
  const costPerQuery = NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY[provider];
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
