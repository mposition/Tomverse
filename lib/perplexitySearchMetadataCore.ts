import {
  sanitizeWebSearchCitations,
  type WebSearchCitation,
} from "@/lib/webSearchCitations";

// Perplexity returns its sources as top-level response fields -- `citations`
// (an ordered array of URL strings) and `search_results` (objects carrying a
// title, url and, for some models, a snippet). Neither is a chat completion
// `annotations` entry, so the generic OpenAI-compatible adapter this app runs
// Perplexity through drops both: the answer keeps its "[1]" markers while the
// source list underneath comes back empty. This module is the counterpart to
// lib/perplexityUsageCore.ts -- same captured response body, entirely
// separate concern: what the user is shown, never what they are charged.
//
// Deliberately not extracted: `snippet`/`date`/`last_updated` and anything
// else in a search result beyond its URL and title. A snippet is
// provider-supplied prose we would then have to store, escape and moderate;
// the citation list only needs to be clickable and labelled.

export const PERPLEXITY_SEARCH_METADATA_SOURCE =
  "perplexity_response_search" as const;

/** The provider tag written onto every citation this module produces. */
export const PERPLEXITY_SOURCE_PROVIDER = "perplexity";

export type PerplexitySearchMetadataSnapshot = {
  source: typeof PERPLEXITY_SEARCH_METADATA_SOURCE;
  citations: WebSearchCitation[];
};

/**
 * The raw shape lifted from one response payload, before sanitizing: the
 * citation URL order exactly as the provider sent it, plus whatever titles
 * `search_results` offered for those URLs.
 */
export type PerplexitySearchPayload = {
  citations: string[];
  searchResults: Array<{ url: string; title?: string }>;
};

const MAX_CITATIONS = 100;
const MAX_TITLE_CHARACTERS = 300;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, MAX_CITATIONS)
    : [];

const asSearchResults = (
  value: unknown
): Array<{ url: string; title?: string }> => {
  if (!Array.isArray(value)) return [];
  const results: Array<{ url: string; title?: string }> = [];
  for (const entry of value.slice(0, MAX_CITATIONS)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== "string" || !record.url) continue;
    results.push({
      url: record.url,
      ...(typeof record.title === "string" && record.title.trim()
        ? { title: record.title.trim().slice(0, MAX_TITLE_CHARACTERS) }
        : {}),
    });
  }
  return results;
};

/**
 * Reads the source fields out of one Perplexity payload -- a whole
 * non-streaming response body, or a single SSE `data:` event. Returns null
 * when the payload carries neither field, which is the normal case for every
 * streaming event except the last.
 */
export const parsePerplexitySearchPayload = (
  payload: unknown
): PerplexitySearchPayload | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const citations = asStringArray(record.citations);
  const searchResults = asSearchResults(record.search_results);
  if (citations.length === 0 && searchResults.length === 0) return null;
  return { citations, searchResults };
};

/**
 * Folds one payload into the running result. Later events win per field but
 * only when they actually carry that field: Perplexity may repeat `citations`
 * on several events and send `search_results` once, and an empty array on a
 * later event must not erase what an earlier one established.
 */
export const mergePerplexitySearchPayloads = (
  previous: PerplexitySearchPayload | null,
  next: PerplexitySearchPayload | null
): PerplexitySearchPayload | null => {
  if (!next) return previous;
  if (!previous) return next;
  return {
    citations: next.citations.length > 0 ? next.citations : previous.citations,
    searchResults:
      next.searchResults.length > 0
        ? next.searchResults
        : previous.searchResults,
  };
};

/**
 * Turns the raw payload into the citation list the client renders.
 *
 * The order of `citations` is the source of truth for the numbers in the
 * answer text: `citations[0]` is the "[1]" the model wrote, `citations[3]` is
 * "[4]". That number is carried explicitly as `referenceNumber` rather than
 * left implicit in array position, because sanitizing legitimately drops
 * entries (an unsafe scheme, a repeated URL) and the surviving entries must
 * keep the numbers the answer text already used. Nothing here renumbers, and
 * nothing rewrites the answer.
 *
 * `search_results` only ever supplies a title, matched on an exact URL --
 * it never adds, reorders or replaces a citation. When the response omits
 * `citations` entirely (some newer Perplexity models return only
 * `search_results`), the search-result order becomes the numbering instead,
 * which is the same order the provider documents those markers against.
 */
export const buildPerplexitySearchMetadata = (
  payload: PerplexitySearchPayload | null
): PerplexitySearchMetadataSnapshot | null => {
  if (!payload) return null;
  const titleByUrl = new Map<string, string>();
  for (const result of payload.searchResults) {
    if (result.title && !titleByUrl.has(result.url)) {
      titleByUrl.set(result.url, result.title);
    }
  }

  const orderedUrls =
    payload.citations.length > 0
      ? payload.citations
      : payload.searchResults.map((result) => result.url);

  // sanitizeWebSearchCitations is the single place http/https-only and
  // de-duplication are enforced for every provider; Perplexity is not
  // allowed its own weaker copy of those rules.
  const citations = sanitizeWebSearchCitations(
    orderedUrls.map((url, index) => ({
      url,
      title: titleByUrl.get(url),
      referenceNumber: index + 1,
      sourceProvider: PERPLEXITY_SOURCE_PROVIDER,
    }))
  );
  if (citations.length === 0) return null;
  return { source: PERPLEXITY_SEARCH_METADATA_SOURCE, citations };
};

/**
 * Combines the snapshots of several provider calls made under one trace (a
 * retried request, for example). The first call that produced sources wins:
 * the answer the user is reading cites one response's numbering, and merging
 * two numberings would make "[4]" point at a source the model never saw.
 */
export const combinePerplexitySearchMetadata = (
  snapshots: Array<PerplexitySearchMetadataSnapshot | null>
): PerplexitySearchMetadataSnapshot | null =>
  snapshots.find(
    (snapshot): snapshot is PerplexitySearchMetadataSnapshot =>
      snapshot !== null && snapshot.citations.length > 0
  ) || null;
