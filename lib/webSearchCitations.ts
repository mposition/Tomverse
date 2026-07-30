// Shared citation sanitizer for provider-native web search results. Keeping
// this in one place (rather than duplicating scheme/dedup checks per
// provider adapter) is what makes the "no javascript:/data: URLs, no raw
// HTML, de-duplicated" guarantee actually hold across every provider.

export type WebSearchCitation = {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
  sourceProvider?: string;
};

const isSafeHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

// Drops unsafe schemes, de-duplicates by exact URL (first occurrence wins,
// merging any start/end index range so multiple citations of the same
// source don't become multiple list entries), and never touches title/url
// text beyond that -- rendering as raw HTML is the caller's responsibility
// to avoid, not this function's.
export const sanitizeWebSearchCitations = (
  citations: Array<Partial<WebSearchCitation> & { url?: unknown }>
): WebSearchCitation[] => {
  const byUrl = new Map<string, WebSearchCitation>();
  for (const raw of citations) {
    if (!isSafeHttpUrl(raw.url)) continue;
    const existing = byUrl.get(raw.url);
    if (!existing) {
      byUrl.set(raw.url, {
        url: raw.url,
        title: typeof raw.title === "string" ? raw.title : undefined,
        startIndex: typeof raw.startIndex === "number" ? raw.startIndex : undefined,
        endIndex: typeof raw.endIndex === "number" ? raw.endIndex : undefined,
        sourceProvider:
          typeof raw.sourceProvider === "string" ? raw.sourceProvider : undefined,
      });
      continue;
    }
    if (!existing.title && typeof raw.title === "string") {
      existing.title = raw.title;
    }
    if (
      typeof raw.startIndex === "number" &&
      (existing.startIndex === undefined || raw.startIndex < existing.startIndex)
    ) {
      existing.startIndex = raw.startIndex;
    }
    if (
      typeof raw.endIndex === "number" &&
      (existing.endIndex === undefined || raw.endIndex > existing.endIndex)
    ) {
      existing.endIndex = raw.endIndex;
    }
  }
  return Array.from(byUrl.values());
};
