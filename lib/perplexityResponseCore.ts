import { forEachPerplexityResponsePayload } from "@/lib/perplexityResponseEvents";
import {
  combinePerplexityUsageCosts,
  parsePerplexityUsageCost,
  type PerplexityUsageCostSnapshot,
} from "@/lib/perplexityUsageCore";
import {
  buildPerplexitySearchMetadata,
  combinePerplexitySearchMetadata,
  mergePerplexitySearchPayloads,
  parsePerplexitySearchPayload,
  type PerplexitySearchMetadataSnapshot,
  type PerplexitySearchPayload,
} from "@/lib/perplexitySearchMetadataCore";

/**
 * Everything one captured Perplexity response body yields, kept as two
 * separate fields answering to two separate owners:
 *
 * - `usage` is billing evidence. It carries provider USD figures and never
 *   leaves the server (see docs/policy/credit-and-cost-limits.md).
 * - `search` is what the user is shown: URLs, titles and the reference number
 *   each one has in the answer text.
 *
 * They travel together only because they arrive in the same bytes.
 */
export type PerplexityResponseCapture = {
  usage: PerplexityUsageCostSnapshot | null;
  search: PerplexitySearchMetadataSnapshot | null;
};

export const EMPTY_PERPLEXITY_RESPONSE_CAPTURE: PerplexityResponseCapture = {
  usage: null,
  search: null,
};

/**
 * The canonical read of a Perplexity response body: one pass, both
 * concerns. Handles a plain JSON body and an SSE stream alike, and for SSE
 * inspects every well-formed event rather than only the last -- usage and
 * sources are not guaranteed to land on the same chunk.
 */
export const parsePerplexityResponseCapture = (
  responseBody: string
): PerplexityResponseCapture => {
  let usage: PerplexityUsageCostSnapshot | null = null;
  let searchPayload: PerplexitySearchPayload | null = null;

  forEachPerplexityResponsePayload(responseBody, (payload) => {
    usage = parsePerplexityUsageCost(payload) || usage;
    searchPayload = mergePerplexitySearchPayloads(
      searchPayload,
      parsePerplexitySearchPayload(payload)
    );
  });

  return { usage, search: buildPerplexitySearchMetadata(searchPayload) };
};

/**
 * Combines the captures of every provider call made under one trace. Costs
 * add up (a retry really was paid for twice); citations do not (see
 * combinePerplexitySearchMetadata).
 */
export const combinePerplexityResponseCaptures = (
  captures: Array<PerplexityResponseCapture | null>
): PerplexityResponseCapture => ({
  usage: combinePerplexityUsageCosts(
    captures.map((capture) => capture?.usage ?? null)
  ),
  search: combinePerplexitySearchMetadata(
    captures.map((capture) => capture?.search ?? null)
  ),
});
