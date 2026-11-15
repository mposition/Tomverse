import assert from "node:assert/strict";
import test from "node:test";

import {
    memoryRelevanceContextEnabled,
    memorySemanticQuery,
    prepareMemorySemanticInput,
} from "../lib/memorySemanticInput.ts";
import {
    rerankCacheKey,
    rerankRequestBody,
    rerankWorstCaseSearchUnits,
} from "../lib/semanticRetrievalCore.ts";

const tokenBilling = { unit: "token" };
const searchUnitBilling = { unit: "search_unit" };

test("the contextual Memory query policy is default-off", () => {
    assert.equal(memoryRelevanceContextEnabled({}), false);
    assert.equal(memoryRelevanceContextEnabled({ MEMORY_RELEVANCE_CONTEXT_ENABLED: "true" }), true);
    assert.equal(memoryRelevanceContextEnabled({ MEMORY_RELEVANCE_CONTEXT_ENABLED: "1" }), false);
});

test("a supported token-priced V5 path preserves a query past 400 bytes", () => {
    const currentQuery = `  ${"q".repeat(700)}  `;
    const prepared = prepareMemorySemanticInput({
        model: "rerank-v5.0-fast",
        billing: tokenBilling,
        currentQuery,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.effectiveQuery, currentQuery);
    assert.equal(prepared.value.historyCount, 0);
    assert.equal(prepared.value.tokenCountKind, "utf8_byte_upper_bound");
});

test("a long Korean middle condition survives the supported search-unit path", () => {
    const currentQuery = `${"가".repeat(70)}아틀라스-중간조건${"나".repeat(70)}`;
    assert.ok(Buffer.byteLength(currentQuery, "utf8") > 400);
    assert.ok(Buffer.byteLength(currentQuery, "utf8") < 500);
    const prepared = prepareMemorySemanticInput({
        model: "rerank-v4.0-fast",
        billing: searchUnitBilling,
        currentQuery,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.effectiveQuery, currentQuery.normalize("NFC"));
    assert.match(prepared.value.effectiveQuery, /아틀라스-중간조건/);
});

test("history is reduced oldest-first only to satisfy the model query limit", () => {
    const currentQuery = "q".repeat(700);
    const recent = "recent context";
    const prepared = prepareMemorySemanticInput({
        model: "rerank-v5.0-pro",
        billing: tokenBilling,
        currentQuery,
        history: ["old".repeat(900), recent],
        countTokens: (query) => Buffer.byteLength(query, "utf8"),
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.historyCount, 1);
    assert.equal(prepared.value.effectiveQuery, memorySemanticQuery(currentQuery, [recent]));
});

test("a byte upper bound never removes history without proof of a token overflow", () => {
    const prepared = prepareMemorySemanticInput({
        model: "rerank-v5.0-pro",
        billing: tokenBilling,
        currentQuery: "current",
        history: ["history".repeat(400)],
    });
    assert.deepEqual(prepared, { ok: false, reason: "query_token_count_unavailable" });
});

test("search-unit pricing refuses an unpriceable full query without deleting valid history", () => {
    const currentQuery = "current";
    const full = memorySemanticQuery(currentQuery, ["history".repeat(100)]);
    assert.ok(Buffer.byteLength(full, "utf8") >= 500);
    const prepared = prepareMemorySemanticInput({
        model: "rerank-v4.0-pro",
        billing: searchUnitBilling,
        currentQuery,
        history: ["history".repeat(100)],
    });
    assert.deepEqual(prepared, { ok: false, reason: "search_unit_cost_unverifiable" });
});

test("unknown model and unverified model/billing pairs fail before dispatch", () => {
    assert.deepEqual(
        prepareMemorySemanticInput({
            model: "rerank-test-model",
            billing: searchUnitBilling,
            currentQuery: "query",
        }),
        { ok: false, reason: "model_query_contract_unknown" }
    );
    assert.deepEqual(
        prepareMemorySemanticInput({
            model: "rerank-v3.0",
            billing: searchUnitBilling,
            currentQuery: "query",
        }),
        { ok: false, reason: "model_query_contract_unknown" }
    );
    assert.deepEqual(
        prepareMemorySemanticInput({
            model: "rerank-v4.0-fast",
            billing: tokenBilling,
            currentQuery: "query",
        }),
        { ok: false, reason: "billing_contract_unknown" }
    );
});

test("actual token overflow and unavailable token validation stay distinct", () => {
    const input = {
        model: "rerank-v5.0-fast",
        billing: tokenBilling,
        currentQuery: "q".repeat(2_049),
    };
    assert.deepEqual(prepareMemorySemanticInput(input), {
        ok: false,
        reason: "query_token_count_unavailable",
    });
    assert.deepEqual(prepareMemorySemanticInput({ ...input, countTokens: () => 2_049 }), {
        ok: false,
        reason: "query_token_limit_exceeded",
    });
});

test("499/500/501 token upper bounds make the search-unit boundary finite or explicit", () => {
    const options = (value) => ({ queryPolicy: "memory-v3", queryTokensUpperBound: value });
    assert.equal(rerankWorstCaseSearchUnits("q".repeat(499), ["document"], options(499)), 1);
    assert.equal(rerankWorstCaseSearchUnits("q".repeat(500), ["document"], options(500)), null);
    assert.equal(rerankWorstCaseSearchUnits("q".repeat(501), ["document"], options(501)), null);
});

test("Memory v3 cache and wire use the same uncut effective query", () => {
    const query = `${"a".repeat(650)}MIDDLE${"z".repeat(650)}`;
    const input = {
        feature: "memoryRerank",
        userId: "user-1",
        model: "rerank-v5.0-fast",
        query,
        queryPolicy: "memory-v3",
        documents: [{ id: "m1", text: "memory" }],
    };
    const body = rerankRequestBody({
        model: input.model,
        query,
        queryPolicy: "memory-v3",
        documents: ["memory"],
    });
    assert.equal(body.query, query);
    assert.match(body.query, /MIDDLE/);
    assert.notEqual(
        rerankCacheKey(input),
        rerankCacheKey({ ...input, query: `${query} changed` })
    );
});
