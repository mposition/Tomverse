import assert from "node:assert/strict";
import test from "node:test";

import {
    CODE_WEB_SEARCH_MAX_QUERIES,
    CODE_WEB_SEARCH_PROTOCOL,
    CODE_WEB_SEARCH_SWITCH_ENV,
    codeWebSearchResponse,
    codeWebSearchSwitchOn,
    parseCodeWebSearchRequest,
} from "../lib/codeWebSearchCore.ts";
import { APP_MANAGED_SEARCH_LIMITS } from "../lib/webSearchBackends.ts";

test("the switch is off unless it is exactly true", () => {
    assert.equal(CODE_WEB_SEARCH_SWITCH_ENV, "TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED");
    assert.equal(codeWebSearchSwitchOn({}), false);
    for (const value of ["1", "TRUE", "on", "yes", " true"]) assert.equal(codeWebSearchSwitchOn({ [CODE_WEB_SEARCH_SWITCH_ENV]: value }), false, value);
    assert.equal(codeWebSearchSwitchOn({ [CODE_WEB_SEARCH_SWITCH_ENV]: "true" }), true);
    assert.equal(CODE_WEB_SEARCH_PROTOCOL, "web_search");
});

test("one request is at most the turn ceiling Chat's search reserves for", () => {
    assert.equal(CODE_WEB_SEARCH_MAX_QUERIES, APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest);
    const tooMany = parseCodeWebSearchRequest(JSON.stringify({ query: Array.from({ length: CODE_WEB_SEARCH_MAX_QUERIES + 1 }, (_, i) => `q${i}`) }));
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, "invalid_request");
    const full = parseCodeWebSearchRequest(JSON.stringify({ query: Array.from({ length: CODE_WEB_SEARCH_MAX_QUERIES }, (_, i) => `q${i}`) }));
    assert.equal(full.ok, true);
});

test("a request is parsed into the search tool's own input", () => {
    const single = parseCodeWebSearchRequest(JSON.stringify({ query: "  node   22 release  ", country: "KR", search_lang: "ko", freshness: "month" }));
    assert.deepEqual(single, {
        ok: true,
        queries: ["node 22 release"],
        input: { query: "node 22 release", country: "KR", searchLang: "ko", freshness: "month" },
    });
    const batch = parseCodeWebSearchRequest(JSON.stringify({ query: ["a b", "c"] }));
    assert.deepEqual(batch, { ok: true, queries: ["a b", "c"], input: { query: ["a b", "c"] } });
});

test("a request with any unusable query, field or body is refused whole, before anything is reserved", () => {
    assert.equal(parseCodeWebSearchRequest("not json").code, "invalid_json");
    assert.equal(parseCodeWebSearchRequest(JSON.stringify({ query: "x", url: "https://example.com" })).code, "invalid_request", "no extra fields");
    assert.equal(parseCodeWebSearchRequest(JSON.stringify({ query: "x", freshness: "hour" })).code, "invalid_request");
    assert.equal(parseCodeWebSearchRequest(JSON.stringify({ query: "x", country: "KOR" })).code, "invalid_request");
    assert.equal(parseCodeWebSearchRequest(JSON.stringify({})).code, "invalid_request");
    const blank = parseCodeWebSearchRequest(JSON.stringify({ query: ["fine", "   "] }));
    assert.equal(blank.ok, false);
    assert.equal(blank.code, "invalid_query");
    assert.match(blank.message, /Query 2/);
    assert.match(blank.message, /Nothing was searched or charged/);
    const long = parseCodeWebSearchRequest(JSON.stringify({ query: "x".repeat(APP_MANAGED_SEARCH_LIMITS.maxQueryCharacters + 1) }));
    assert.equal(long.code, "invalid_query");
});

test("the response lists each search, every distinct source and the notice, in snake case", () => {
    const body = codeWebSearchResponse({
        requestId: "req_1",
        chargedCredits: 8,
        result: {
            status: "batch",
            searches: [
                {
                    status: "ok",
                    query: "a",
                    notice: "Searched on 2026-11-27 (UTC). These extracts are quoted from third-party web pages.",
                    results: [
                        { title: "A", url: "https://a.example/1", snippet: "one", publishedAt: "2026-11-01" },
                        { title: "B", url: "https://b.example/2" },
                    ],
                    truncated: true,
                },
                { status: "ok", query: "b", notice: "second", results: [{ title: "A again", url: "https://a.example/1" }] },
                { status: "failed", query: "c", reason: "backend_rate_limited" },
            ],
        },
    });
    assert.deepEqual(body, {
        object: "tomverse.web_search",
        request_id: "req_1",
        searches: [
            {
                query: "a",
                status: "ok",
                results: [
                    { title: "A", url: "https://a.example/1", snippet: "one", published_at: "2026-11-01" },
                    { title: "B", url: "https://b.example/2" },
                ],
                truncated: true,
            },
            { query: "b", status: "ok", results: [{ title: "A again", url: "https://a.example/1" }] },
            { query: "c", status: "failed", reason: "backend_rate_limited" },
        ],
        sources: ["https://a.example/1", "https://b.example/2"],
        notice: "Searched on 2026-11-27 (UTC). These extracts are quoted from third-party web pages.",
        charged_credits: 8,
    });
    const one = codeWebSearchResponse({ requestId: "req_2", chargedCredits: null, result: { status: "failed", query: "x", reason: "backend_timeout" } });
    assert.deepEqual(one.searches, [{ query: "x", status: "failed", reason: "backend_timeout" }]);
    assert.deepEqual(one.sources, []);
    assert.equal(one.charged_credits, null);
});
