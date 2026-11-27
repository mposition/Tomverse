import { z } from "zod";

import { APP_MANAGED_SEARCH_LIMITS, validateSearchQuery } from "@/lib/webSearchBackends";

/**
 * The coding API's web search (`POST /api/code/v1/web-search`): the agent
 * engine's `web_search` tool (apps/tomverse-cli) asks Tomverse to search the web
 * and gets titles, addresses and short extracts back. The search itself is
 * Chat's application-managed search -- the same Brave backend, the same
 * five-request counter, the same flat surcharge and the same search vendor
 * budget (docs/policy/credit-and-cost-limits.md). The engine's own model reads
 * the results; nothing else is generated here.
 *
 * Pure: the request schema, the switch and the response shape. The server half
 * is lib/codeWebSearch.ts. See docs/policy/external-api.md section 11.1.
 */

/** Exactly "true" turns the route on. Default off; EXTERNAL_API_ENABLED must be on as well. */
export const CODE_WEB_SEARCH_SWITCH_ENV = "TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED";

export const codeWebSearchSwitchOn = (env: Record<string, string | undefined>) =>
    env[CODE_WEB_SEARCH_SWITCH_ENV] === "true";

/** What a web search receipt records as its protocol (ExternalApiRequest.protocol has no CHECK constraint). */
export const CODE_WEB_SEARCH_PROTOCOL = "web_search";

/** A search request is a few short queries; anything larger is not one. */
export const CODE_WEB_SEARCH_MAX_BODY_BYTES = 8 * 1024;

/** At most this many independent queries in one request: the turn ceiling Chat's search reserves for. */
export const CODE_WEB_SEARCH_MAX_QUERIES = APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest;

/**
 * The request. Narrow on purpose, like Chat's tool input: no URL, no count, no
 * page, no site filter, no raw parameter bag. The three hints are checked again
 * by the backend adapter, so an unusable value is dropped rather than sent.
 */
export const codeWebSearchRequestSchema = z
    .object({
        query: z.union([z.string(), z.array(z.string()).min(1).max(CODE_WEB_SEARCH_MAX_QUERIES)]),
        country: z.string().length(2).optional(),
        search_lang: z.string().min(2).max(10).optional(),
        freshness: z.enum(["day", "week", "month", "year"]).optional(),
    })
    .strict();

export type CodeWebSearchRequest = z.infer<typeof codeWebSearchRequestSchema>;

/** The search tool's own input (lib/appManagedWebSearchTool.ts). */
export type CodeWebSearchToolInput = {
    query: string | string[];
    country?: string;
    searchLang?: string;
    freshness?: "day" | "week" | "month" | "year";
};

export type CodeWebSearchParse =
    | { ok: true; input: CodeWebSearchToolInput; queries: string[] }
    | { ok: false; code: "invalid_json" | "invalid_request" | "invalid_query"; message: string; param: string | null };

/**
 * Parses and validates the body before anything is reserved. Every query must be
 * one the backend would send: a request with an unusable query is refused whole,
 * at no cost, so the model can rewrite it -- never sent in part and charged.
 */
export const parseCodeWebSearchRequest = (raw: string): CodeWebSearchParse => {
    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return { ok: false, code: "invalid_json", message: "The request body is not valid JSON.", param: null };
    }
    const parsed = codeWebSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            ok: false,
            code: "invalid_request",
            message: `The web search request is not valid: ${issue?.message ?? "unknown field"}.`,
            param: issue?.path.length ? issue.path.join(".") : null,
        };
    }
    const list = Array.isArray(parsed.data.query) ? parsed.data.query : [parsed.data.query];
    const queries: string[] = [];
    for (const [index, query] of list.entries()) {
        const validated = validateSearchQuery(query);
        if (!validated.ok) {
            return {
                ok: false,
                code: "invalid_query",
                message: `Query ${index + 1} cannot be searched (${validated.reason}). Nothing was searched or charged.`,
                param: "query",
            };
        }
        queries.push(validated.query);
    }
    return {
        ok: true,
        queries,
        input: {
            query: Array.isArray(parsed.data.query) ? queries : queries[0]!,
            ...(parsed.data.country ? { country: parsed.data.country } : {}),
            ...(parsed.data.search_lang ? { searchLang: parsed.data.search_lang } : {}),
            ...(parsed.data.freshness ? { freshness: parsed.data.freshness } : {}),
        },
    };
};

/** One search as the tool returns it (lib/appManagedWebSearchTool.ts AppManagedSearchToolResult). */
type ToolSearch = {
    status: "ok" | "limit_reached" | "invalid_query" | "failed";
    query?: string;
    results?: Array<{ title: string; url: string; snippet?: string; publishedAt?: string }>;
    reason?: string;
    notice?: string;
    truncated?: boolean;
};
type ToolResult = ToolSearch | { status: "batch"; searches: ToolSearch[] };

export type CodeWebSearchResponse = {
    object: "tomverse.web_search";
    request_id: string;
    searches: Array<{
        query: string | null;
        status: ToolSearch["status"];
        results?: Array<{ title: string; url: string; snippet?: string; published_at?: string }>;
        reason?: string;
        truncated?: true;
    }>;
    /** Every distinct address the searches returned, in order: what an answer may cite. */
    sources: string[];
    /** Says what the extracts are: third-party text, never instructions. */
    notice: string | null;
    /** Credits this request was charged; null when its settlement is not yet known. */
    charged_credits: number | null;
};

/** The response body, from the tool's result. Snake case, like the rest of the Tomverse API. */
export const codeWebSearchResponse = (input: {
    requestId: string;
    result: ToolResult;
    chargedCredits: number | null;
}): CodeWebSearchResponse => {
    const list = input.result.status === "batch" ? input.result.searches : [input.result];
    const sources: string[] = [];
    let notice: string | null = null;
    const searches = list.map((search) => {
        if (search.notice && !notice) notice = search.notice;
        for (const result of search.results ?? []) if (!sources.includes(result.url)) sources.push(result.url);
        return {
            query: search.query ?? null,
            status: search.status,
            ...(search.status === "ok"
                ? {
                      results: (search.results ?? []).map((result) => ({
                          title: result.title,
                          url: result.url,
                          ...(result.snippet ? { snippet: result.snippet } : {}),
                          ...(result.publishedAt ? { published_at: result.publishedAt } : {}),
                      })),
                  }
                : {}),
            ...(search.reason ? { reason: search.reason } : {}),
            ...(search.truncated ? { truncated: true as const } : {}),
        };
    });
    return {
        object: "tomverse.web_search",
        request_id: input.requestId,
        searches,
        sources,
        notice,
        charged_credits: input.chargedCredits,
    };
};
