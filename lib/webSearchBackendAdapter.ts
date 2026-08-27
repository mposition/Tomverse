import "server-only";

/**
 * The one place an application-managed web search leaves this process.
 *
 * Exactly one HTTP request per call, by construction and not by convention:
 * the executor counts calls to this function, the reservation is sized on that
 * count, and a retry loop hidden in here would bill twice for one counted
 * search. A transient failure is reported to the model as a failure, which it
 * may answer by searching again -- and that second search is counted, priced
 * and bounded like any other.
 *
 * ## What comes back is untrusted
 *
 * Everything below the fold of this function is text a stranger wrote and
 * chose to have indexed. It is put in front of a model that is, at that
 * moment, following instructions. So:
 *
 *   * only `title`, `url`, `snippet` and `publishedAt` survive -- no vendor
 *     ranking fields, no tracking parameters the vendor bolted on, no raw
 *     response object;
 *   * markup is removed rather than escaped, because the model is not a
 *     browser and a `<strong>` is only noise to it;
 *   * every string is length-capped and the whole payload is capped again, so
 *     a page cannot spend the turn's remaining context on itself;
 *   * only `http:` and `https:` URLs survive, so nothing the model repeats can
 *     be a `javascript:` or `data:` link;
 *   * the tool result the model sees carries an explicit statement that this
 *     is quoted third-party content and not instructions
 *     (`lib/appManagedWebSearchTool.ts`).
 *
 * ## What never leaves
 *
 * The API key is read from the environment at the moment of the call and put
 * in one header. It is not logged, not attached to an error, not returned, and
 * not stored. Provider response bodies are read for parsing and then dropped:
 * an HTTP failure is reported as one of a fixed set of codes, so nothing a
 * vendor wrote can reach a user-facing error. The user's query is not written
 * to any log; what is logged is its length and the outcome.
 */

import {
  APP_MANAGED_SEARCH_LIMITS,
  type WebSearchBackend,
  type WebSearchBackendResult,
} from "@/lib/webSearchBackends";
import {
  readWebSearchBackendKey,
  webSearchFakeBackendEnabled,
} from "@/lib/webSearchBackendRuntime";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export type { WebSearchBackendResult };

/** Why a backend request produced nothing usable. A fixed, user-safe set. */
export type WebSearchBackendFailure =
  /** No credential for this backend in this process. */
  | "backend_not_configured"
  /** The backend rejected the credential. */
  | "backend_unauthorized"
  /** The backend asked us to slow down. */
  | "backend_rate_limited"
  /** The backend answered, unsuccessfully. */
  | "backend_error"
  /** The request was aborted, by our deadline or by the turn ending. */
  | "backend_timeout"
  /** The backend answered with something this adapter could not read. */
  | "backend_invalid_response";

export type WebSearchBackendOutcome =
  | {
      ok: true;
      results: WebSearchBackendResult[];
      /** True when results were dropped to stay inside the payload ceiling. */
      truncated: boolean;
    }
  | { ok: false; failure: WebSearchBackendFailure };

export type WebSearchBackendRequest = {
  /** Already validated by `validateSearchQuery`. Never sent unvalidated. */
  query: string;
  /**
   * A two-letter country the results should be biased toward, and a language
   * for them. Both optional, both passed through the vendor's own parameters,
   * both format-checked here -- an unrecognised value is dropped rather than
   * forwarded, so a model cannot smuggle arbitrary query parameters through
   * them.
   */
  country?: string;
  searchLang?: string;
  /** How recent a result must be. Restricted to the vendor's own vocabulary. */
  freshness?: "day" | "week" | "month" | "year";
  /** Aborts the request when the turn ends. */
  signal?: AbortSignal;
};

const FRESHNESS_CODES: Record<
  NonNullable<WebSearchBackendRequest["freshness"]>,
  string
> = { day: "pd", week: "pw", month: "pm", year: "py" };

/** Two ASCII letters, uppercased. Anything else is dropped. */
const normalizeCountry = (value: string | undefined) =>
  typeof value === "string" && /^[A-Za-z]{2}$/.test(value)
    ? value.toUpperCase()
    : undefined;

/** A BCP-47-ish language tag, conservatively. Anything else is dropped. */
const normalizeSearchLang = (value: string | undefined) =>
  typeof value === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(value)
    ? value.toLowerCase()
    : undefined;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Markup out, plain text in.
 *
 * Tags are removed, not escaped: the consumer is a language model, and an
 * escaped tag is the same noise with more characters. Control characters go
 * too -- including the NUL the stream trailer's marker is built from, which a
 * result title has no business carrying.
 */
export const plainTextFromBackend = (value: unknown, maxLength: number) => {
  if (typeof value !== "string") return undefined;
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => HTML_ENTITIES[entity] ?? " ")
    // Unicode control characters, named by property rather than by literal
    // range: a source file that contains a NUL to strip NULs is a source file
    // every grep, diff and editor reports as binary.
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return undefined;
  return stripped.length > maxLength
    ? `${stripped.slice(0, maxLength - 1).trimEnd()}…`
    : stripped;
};

/**
 * A URL the model may be shown, or nothing.
 *
 * Re-serialized from a parsed `URL` rather than passed through, so a result
 * whose href carries whitespace or a stray control character cannot be
 * reproduced verbatim in an answer.
 */
export const safeResultUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const isoDate = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

/**
 * Applies the per-result and whole-payload ceilings.
 *
 * Whole results are dropped from the end rather than fields being shortened
 * further, so what the model sees is always a prefix of what the backend
 * ranked first -- a half-populated result reads as a result that had no
 * snippet, which is a different claim from one that was cut.
 */
export const boundSearchResults = (
  results: readonly WebSearchBackendResult[]
): { results: WebSearchBackendResult[]; truncated: boolean } => {
  const kept: WebSearchBackendResult[] = [];
  let size = 0;
  let truncated = false;
  for (const result of results.slice(
    0,
    APP_MANAGED_SEARCH_LIMITS.maxResultsPerQuery
  )) {
    const cost =
      result.title.length +
      result.url.length +
      (result.snippet?.length ?? 0) +
      (result.publishedAt?.length ?? 0);
    if (
      kept.length > 0 &&
      size + cost > APP_MANAGED_SEARCH_LIMITS.maxResultPayloadCharacters
    ) {
      truncated = true;
      break;
    }
    kept.push(result);
    size += cost;
  }
  if (results.length > APP_MANAGED_SEARCH_LIMITS.maxResultsPerQuery) {
    truncated = true;
  }
  return { results: kept, truncated };
};

/** Brave's `web.results[]`, reduced to the four fields that survive. */
export const parseBraveWebSearchBody = (
  body: unknown
): WebSearchBackendResult[] | null => {
  if (!body || typeof body !== "object") return null;
  const web = (body as Record<string, unknown>).web;
  if (!web || typeof web !== "object") {
    // A well-formed answer with no web section is a search that found nothing,
    // which is a result and not a parse failure.
    return [];
  }
  const raw = (web as Record<string, unknown>).results;
  if (!Array.isArray(raw)) return [];
  const results: WebSearchBackendResult[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = safeResultUrl(record.url);
    if (!url) continue;
    const title =
      plainTextFromBackend(
        record.title,
        APP_MANAGED_SEARCH_LIMITS.maxTitleCharacters
      ) ?? url;
    const snippet = plainTextFromBackend(
      record.description,
      APP_MANAGED_SEARCH_LIMITS.maxSnippetCharacters
    );
    const publishedAt =
      isoDate(record.page_age) ??
      isoDate((record.article as Record<string, unknown> | undefined)?.date);
    results.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return results;
};

const failureForStatus = (status: number): WebSearchBackendFailure => {
  if (status === 401 || status === 403) return "backend_unauthorized";
  if (status === 429) return "backend_rate_limited";
  return "backend_error";
};

/**
 * A deterministic stand-in for a real backend, for development and tests.
 *
 * Deterministic on the query so a test can assert exact citations without a
 * fixture file, and obviously synthetic so nobody mistakes its output for the
 * web. Reachable only through `webSearchFakeBackendEnabled`, which refuses in
 * production.
 */
export const fakeWebSearchResults = (
  query: string
): WebSearchBackendResult[] => {
  const slug = encodeURIComponent(query.slice(0, 60).replace(/\s+/g, "-"));
  return Array.from({ length: 3 }, (_, index) => ({
    title: `Test result ${index + 1} for ${query}`,
    url: `https://example.test/${slug}/${index + 1}`,
    snippet: `Synthetic search result ${index + 1} for the query "${query}". This text is generated locally and is not from the web.`,
    publishedAt: "2026-01-01T00:00:00.000Z",
  }));
};

/**
 * One backend request. One.
 *
 * The body is consumed on every path -- success, HTTP failure, parse failure --
 * because an undrained response keeps a socket in the agent pool, and a route
 * that leaks one per failed search leaks one per failed search forever.
 */
export const runWebSearchBackendRequest = async (
  backend: WebSearchBackend,
  request: WebSearchBackendRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<WebSearchBackendOutcome> => {
  if (webSearchFakeBackendEnabled(env)) {
    const bounded = boundSearchResults(fakeWebSearchResults(request.query));
    return { ok: true, results: bounded.results, truncated: bounded.truncated };
  }
  if (backend !== "brave") {
    return { ok: false, failure: "backend_not_configured" };
  }
  const key = readWebSearchBackendKey(backend, env);
  if (!key) return { ok: false, failure: "backend_not_configured" };

  const url = new URL(BRAVE_WEB_SEARCH_URL);
  url.searchParams.set("q", request.query);
  url.searchParams.set(
    "count",
    String(APP_MANAGED_SEARCH_LIMITS.maxResultsPerQuery)
  );
  // Brave's own noise reducers. `text_decorations` off is why titles and
  // snippets arrive without `<strong>` in the common case; the stripper above
  // is still applied, because "in the common case" is not a guarantee.
  url.searchParams.set("text_decorations", "0");
  url.searchParams.set("safesearch", "moderate");
  const country = normalizeCountry(request.country);
  if (country) url.searchParams.set("country", country);
  const searchLang = normalizeSearchLang(request.searchLang);
  if (searchLang) url.searchParams.set("search_lang", searchLang);
  if (request.freshness) {
    url.searchParams.set("freshness", FRESHNESS_CODES[request.freshness]);
  }

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    APP_MANAGED_SEARCH_LIMITS.requestTimeoutMs
  );
  const abortFromCaller = () => controller.abort();
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": key,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    // Deliberately not the caught error. A fetch rejection can carry the
    // request headers on some runtimes, and this value goes into a tool result
    // the model reads back.
    return { ok: false, failure: "backend_timeout" };
  } finally {
    clearTimeout(deadline);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!response.ok) {
    // Drained and dropped. The vendor's error prose must not reach the model
    // or the user; the status is enough to act on.
    await response.text().catch(() => "");
    return { ok: false, failure: failureForStatus(response.status) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: "backend_invalid_response" };
  }

  const parsed = parseBraveWebSearchBody(body);
  if (parsed === null) return { ok: false, failure: "backend_invalid_response" };
  const bounded = boundSearchResults(parsed);
  return { ok: true, results: bounded.results, truncated: bounded.truncated };
};
