import type { WebSearchCitation } from "../../../lib/webSearchCitations";
import { linkViewUrl } from "./web-view-contract";

export type SourceRow = {
  key: string;
  url: string;
  title: string;
  host: string;
  referenceNumber?: number;
  /** Only public https pages open in the in-app viewer; anything else stays readable text. */
  openable: boolean;
};

/** Rows for the sources list under a web-search answer, in the provider's order. */
export function sourceRows(citations: readonly WebSearchCitation[]): SourceRow[] {
  return citations.map((citation, index) => {
    const target = linkViewUrl(citation.url);
    let host = target?.host ?? "";
    if (!host) {
      try { host = new URL(citation.url).host; } catch { host = citation.url; }
    }
    return {
      key: `${index}:${citation.url}`, url: citation.url, title: citation.title?.trim() || host, host,
      ...(citation.referenceNumber !== undefined ? { referenceNumber: citation.referenceNumber } : {}),
      openable: Boolean(target),
    };
  });
}
