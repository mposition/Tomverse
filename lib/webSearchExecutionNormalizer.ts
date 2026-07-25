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
  const queryCount = executed ? resultParts.length : undefined;
  const failureCode = errorParts.length > 0 ? "provider_tool_error" : undefined;
  // Anthropic bills web search at a flat, documented $10 / 1,000 searches
  // (platform.claude.com web-search-tool docs) in addition to token cost --
  // tracked here for internal cost accounting only, never as extra
  // user-facing credits beyond the flat surcharge already reserved.
  const costMetadata =
    provider === "anthropic" && queryCount
      ? { searchCostMicroUsd: queryCount * 10_000 }
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
