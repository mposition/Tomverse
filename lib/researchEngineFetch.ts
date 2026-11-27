import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { BoundedBufferError, readWebStreamToBuffer } from "@/lib/boundedBuffer";
import { RESEARCH_RESOURCE_LIMITS } from "@/lib/researchEngineContract";
import { canonicalResearchUrl, hostMatchesDomain, researchUrlHost } from "@/lib/researchEngineEvidence";
import {
  isPublicResearchPageAddress, researchPageRequestOptions, validateResearchPageUrl,
  type ResearchPageAddress, type ResearchPageResponse, type ResearchPageTransport,
} from "@/lib/researchPreviewPageRead";
import { runWebSearchBackendRequest, type WebSearchBackendOutcome, type WebSearchBackendRequest } from "@/lib/webSearchBackendAdapter";
import { validateSearchQuery } from "@/lib/webSearchBackends";

/**
 * Network edges of Research engine v2. Every URL -- search result, user URL or
 * a link discovered on a read page -- goes through the same checks as the
 * Preview reader: https only, public DNS answers only, the socket pinned to
 * the checked address, every redirect re-validated, bounded size and time. No
 * cookies or credentials are ever sent; login and paywalled pages simply come
 * back as unavailable.
 */

export const RESEARCH_READ_DEADLINE_MS = 15_000;
export const RESEARCH_READ_MAX_REDIRECTS = 3;

export type ResearchFetchFailure = "unsafe_url" | "unsafe_address" | "dns_unavailable" | "redirect_limit" | "http_error" |
  "login_or_paywall" | "unsupported_content" | "response_too_large" | "timeout" | "aborted" | "network_error";

export type ResearchFetchResult =
  | { ok: true; finalUrl: string; mediaType: string; bytes: Buffer; lastModified?: string }
  | { ok: false; reason: ResearchFetchFailure };

class FetchFailure extends Error { constructor(readonly reason: ResearchFetchFailure) { super(reason); } }

const ACCEPT = "text/html, application/xhtml+xml;q=0.95, text/plain;q=0.9, text/markdown;q=0.9, text/csv;q=0.8, application/pdf;q=0.8, " +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document;q=0.7, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;q=0.7";

const pinnedTransport: ResearchPageTransport = ({ url, address, signal }) => new Promise((resolve, reject) => {
  const options = researchPageRequestOptions(url, address, signal);
  options.headers = { ...options.headers, accept: ACCEPT, "user-agent": "Tomverse-Research/2.0" };
  const request = httpsRequest(options, (response) => {
    const headers = new Headers();
    for (const name of ["location", "content-type", "content-length", "content-encoding", "last-modified", "www-authenticate"]) {
      const value = response.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    resolve({ status: response.statusCode ?? 500, headers, body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
      dispose: () => { response.destroy(); request.destroy(); } });
  });
  request.once("error", reject);
  request.end();
});

export type ResearchNetworkPorts = {
  lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  transport?: ResearchPageTransport;
  search?: (request: WebSearchBackendRequest) => Promise<WebSearchBackendOutcome>;
};
let ports: ResearchNetworkPorts = {};
export const setResearchNetworkPorts = (next: ResearchNetworkPorts | null) => { ports = next ?? {}; };

async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/**
 * `options.maxBytes` lowers the response ceiling for a caller that needs less than
 * a Research read (chat page reading); it can never raise it.
 */
export async function fetchResearchUrl(target: string, signal?: AbortSignal, options: { maxBytes?: number } = {}): Promise<ResearchFetchResult> {
  const maxBytes = Math.min(options.maxBytes ?? RESEARCH_RESOURCE_LIMITS.maxReadBytes, RESEARCH_RESOURCE_LIMITS.maxReadBytes);
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => controller.abort(new DOMException("Research read deadline", "TimeoutError")), RESEARCH_READ_DEADLINE_MS);
  const lookup = ports.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const transport = ports.transport ?? pinnedTransport;
  let response: ResearchPageResponse | undefined;
  try {
    let url: URL;
    try { url = validateResearchPageUrl(target); } catch { throw new FetchFailure("unsafe_url"); }
    for (let redirects = 0; ; redirects++) {
      combined.throwIfAborted();
      let addresses: readonly { address: string; family: number }[];
      try { addresses = await withAbort(lookup(url.hostname), combined); }
      catch (error) { if (combined.aborted) throw error; throw new FetchFailure("dns_unavailable"); }
      if (!addresses.length || addresses.length > 64 || addresses.some((address) =>
        ![4, 6].includes(address.family) || isIP(address.address) !== address.family || !isPublicResearchPageAddress(address.address))) {
        throw new FetchFailure("unsafe_address");
      }
      response = await withAbort(transport({ url, address: addresses[0] as ResearchPageAddress, signal: combined }), combined);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= RESEARCH_READ_MAX_REDIRECTS) throw new FetchFailure("redirect_limit");
        const location = response.headers.get("location");
        if (!location) throw new FetchFailure("http_error");
        let next: URL;
        try { next = new URL(location, url); } catch { throw new FetchFailure("unsafe_url"); }
        try { url = validateResearchPageUrl(next.href); } catch { throw new FetchFailure("unsafe_url"); }
        response.dispose(); response = undefined;
        continue;
      }
      if (response.status === 401 || response.status === 402 || response.status === 403 || response.headers.get("www-authenticate")) {
        throw new FetchFailure("login_or_paywall");
      }
      if (response.status !== 200) throw new FetchFailure("http_error");
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if (encoding && encoding !== "identity") throw new FetchFailure("unsupported_content");
      const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (!mediaType) throw new FetchFailure("unsupported_content");
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw new FetchFailure("response_too_large");
      if (!response.body) throw new FetchFailure("unsupported_content");
      const bytes = await readWebStreamToBuffer(response.body, maxBytes, combined);
      const lastModified = response.headers.get("last-modified") ?? undefined;
      return { ok: true, finalUrl: url.href, mediaType, bytes: Buffer.from(bytes), ...(lastModified ? { lastModified } : {}) };
    }
  } catch (error) {
    return { ok: false, reason: signal?.aborted ? "aborted" : controller.signal.aborted ? "timeout" :
      error instanceof FetchFailure ? error.reason : error instanceof BoundedBufferError ? "response_too_large" : "network_error" };
  } finally {
    clearTimeout(timer);
    response?.dispose();
  }
}

export type ResearchSearchFilters = {
  searchLanguage?: string; country?: string; freshness?: "day" | "week" | "month" | "year";
  includeDomains: readonly string[]; excludeDomains: readonly string[];
};

/**
 * One backend request. Language, country and freshness are the backend's own
 * parameters; domain include/exclude is applied to returned results (the
 * adapter has no site filter), and the result says so rather than implying a
 * backend-side filter.
 */
export async function runResearchSearch(query: string, filters: ResearchSearchFilters, signal?: AbortSignal) {
  const validated = validateSearchQuery(query);
  if (!validated.ok) return { ok: false as const, reason: "query_rejected" as const, dispatched: false };
  const request: WebSearchBackendRequest = { query: validated.query, signal,
    ...(filters.searchLanguage ? { searchLang: filters.searchLanguage } : {}),
    ...(filters.country ? { country: filters.country } : {}),
    ...(filters.freshness ? { freshness: filters.freshness } : {}) };
  const outcome = await (ports.search ?? ((value: WebSearchBackendRequest) => runWebSearchBackendRequest("brave", value)))(request);
  if (!outcome.ok) return { ok: false as const, reason: outcome.failure, dispatched: outcome.failure !== "backend_not_configured" };
  const results = outcome.results.flatMap((result) => {
    const url = canonicalResearchUrl(result.url);
    if (!url) return [];
    const host = researchUrlHost(url);
    if (filters.excludeDomains.some((domain) => hostMatchesDomain(host, domain))) return [];
    if (filters.includeDomains.length && !filters.includeDomains.some((domain) => hostMatchesDomain(host, domain))) return [];
    return [{ url, title: result.title, snippet: result.snippet, publishedAt: result.publishedAt }];
  });
  return { ok: true as const, results, truncated: outcome.truncated, domainFiltering: "post_filter" as const };
}

export function validateResearchQuery(query: string) {
  return validateSearchQuery(query).ok;
}
