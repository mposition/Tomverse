// Semantic retrieval core: configuration, cost bounds, wire shapes, vector maths
// and cache keys. Everything under test is pure, so each case feeds fixed input
// and asserts the exact output. Nothing here calls a provider.
//
// The properties worth pinning are the ones that protect money and determinism:
// a feature stays off unless model, price and budget are all valid; the
// reservation is never below what the provider could bill; a malformed provider
// answer is discarded rather than partly trusted; and ordering never depends on
// the order rows arrive in.

import assert from "node:assert/strict";
import test from "node:test";

import {
    SEMANTIC_RETRIEVAL_ENV,
    SEMANTIC_RETRIEVAL_FEATURES,
    SEMANTIC_RETRIEVAL_LIMITS,
    cosineSimilarity,
    decodeVector,
    embedCostMicroUsd,
    embedRequestBody,
    embedTextWorstCaseTokens,
    embeddingModelLabel,
    encodeVector,
    nearestByCosine,
    parseEmbedResponse,
    parseRerankResponse,
    parseSemanticCacheValue,
    queryEmbeddingCacheKey,
    rerankCacheKey,
    rerankCostMicroUsd,
    rerankRequestBody,
    rerankWorstCaseSearchUnits,
    boundRerankQuery,
    rerankWorstCaseTokens,
    rerankWorstCaseMicroUsd,
    rerankBilledMicroUsd,
    resolveSemanticRetrievalConfig,
    retrievalBudgetPeriods,
    roundSemanticScore,
    semanticRetrievalFeatureConfigured,
} from "../lib/semanticRetrievalCore.ts";

const ENV = SEMANTIC_RETRIEVAL_ENV;

const BUDGET_ENV = {
    [ENV.budgetDay]: "1000",
    [ENV.budgetMonth]: "20000",
};
const RERANK_ENV = {
    [ENV.rerankModel]: "rerank-v3.5",
    [ENV.rerankPrice]: "2000",
};
const EMBED_ENV = {
    [ENV.embedModel]: "embed-v4.0",
    [ENV.embedTextPrice]: "120000",
};

/* ------------------------------------------------------------------ config */

test("an empty environment configures nothing and reports no problems", () => {
    const config = resolveSemanticRetrievalConfig({});
    assert.equal(config.rerank, null);
    assert.equal(config.embed, null);
    assert.equal(config.budget, null);
    assert.deepEqual(config.problems, []);
});

test("blank values count as unset, not as a problem", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.rerankModel]: "   ",
        [ENV.rerankPrice]: "",
        [ENV.budgetDay]: "  ",
    });
    assert.equal(config.rerank, null);
    assert.deepEqual(config.problems, []);
});

test("a rerank model without a price is not configured", () => {
    const config = resolveSemanticRetrievalConfig({ [ENV.rerankModel]: "rerank-v3.5" });
    assert.equal(config.rerank, null);
    assert.deepEqual(config.problems, []);
});

test("a rerank price without a model is not configured", () => {
    const config = resolveSemanticRetrievalConfig({ [ENV.rerankPrice]: "2000" });
    assert.equal(config.rerank, null);
});

test("a model and a positive integer price configure rerank", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.rerankModel]: " rerank-v3.5 ",
        [ENV.rerankPrice]: " 2000 ",
    });
    assert.deepEqual(config.rerank, {
        model: "rerank-v3.5",
        billing: { unit: "search_unit", microUsdPerSearchUnit: 2000 },
    });
    assert.deepEqual(config.problems, []);
});

for (const bad of ["0", "-1", "1.5", "abc", "1e3x", "NaN", "9007199254740993"]) {
    test(`a price of ${JSON.stringify(bad)} is rejected and named in problems`, () => {
        const config = resolveSemanticRetrievalConfig({
            [ENV.rerankModel]: "rerank-v3.5",
            [ENV.rerankPrice]: bad,
        });
        assert.equal(config.rerank, null);
        assert.deepEqual(config.problems, [ENV.rerankPrice]);
    });
}

test("problems name variables and never echo their values", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.embedModel]: "embed-v4.0",
        [ENV.embedTextPrice]: "sk-not-a-number-secret",
    });
    assert.equal(config.embed, null);
    assert.deepEqual(config.problems, [ENV.embedTextPrice]);
    assert.ok(!JSON.stringify(config).includes("sk-not-a-number-secret"));
});

for (const bad of ["embed v4", "bad/model", "x", "-embed", "embed$", `a${"b".repeat(80)}`]) {
    test(`a model name of ${JSON.stringify(bad)} is rejected`, () => {
        const config = resolveSemanticRetrievalConfig({
            [ENV.rerankModel]: bad,
            [ENV.rerankPrice]: "2000",
        });
        assert.equal(config.rerank, null);
        assert.deepEqual(config.problems, [ENV.rerankModel]);
    });
}

for (const good of ["rerank-v3.5", "embed-english-v3.0", "ab", "Model_1:beta"]) {
    test(`a model name of ${JSON.stringify(good)} is accepted`, () => {
        const config = resolveSemanticRetrievalConfig({
            [ENV.rerankModel]: good,
            [ENV.rerankPrice]: "1",
        });
        assert.equal(config.rerank?.model, good);
        assert.deepEqual(config.problems, []);
    });
}

test("embed needs a model and a text price; dimension and image price are optional", () => {
    const minimal = resolveSemanticRetrievalConfig(EMBED_ENV);
    assert.deepEqual(minimal.embed, {
        model: "embed-v4.0",
        dimension: null,
        microUsdPerMillionTextTokens: 120000,
        microUsdPerMillionImageTokens: null,
    });

    const full = resolveSemanticRetrievalConfig({
        ...EMBED_ENV,
        [ENV.embedDimension]: "256",
        [ENV.embedImagePrice]: "47000",
    });
    assert.equal(full.embed?.dimension, 256);
    assert.equal(full.embed?.microUsdPerMillionImageTokens, 47000);

    assert.equal(
        resolveSemanticRetrievalConfig({ [ENV.embedModel]: "embed-v4.0" }).embed,
        null
    );
});

test("an invalid image price leaves text embedding on and image inputs unpriced", () => {
    const config = resolveSemanticRetrievalConfig({
        ...EMBED_ENV,
        [ENV.embedImagePrice]: "0",
    });
    assert.equal(config.embed?.microUsdPerMillionImageTokens, null);
    assert.deepEqual(config.problems, [ENV.embedImagePrice]);
});

test("an invalid dimension is reported and turns embedding off", () => {
    // Not the provider default: vectors of a size nobody chose would be
    // stored, and then thrown away when the typo is fixed.
    const config = resolveSemanticRetrievalConfig({
        ...EMBED_ENV,
        [ENV.embedDimension]: "-4",
    });
    assert.equal(config.embed, null);
    assert.deepEqual(config.problems, [ENV.embedDimension]);
});

test("the budget needs both windows", () => {
    assert.equal(resolveSemanticRetrievalConfig({ [ENV.budgetDay]: "100" }).budget, null);
    assert.equal(resolveSemanticRetrievalConfig({ [ENV.budgetMonth]: "100" }).budget, null);
    assert.deepEqual(resolveSemanticRetrievalConfig(BUDGET_ENV).budget, {
        day: 1000,
        month: 20000,
    });
});

test("a daily budget above the monthly one is rejected", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.budgetDay]: "5000",
        [ENV.budgetMonth]: "1000",
    });
    assert.equal(config.budget, null);
    assert.deepEqual(config.problems, [ENV.budgetDay]);
});

test("equal daily and monthly budgets are allowed", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.budgetDay]: "1000",
        [ENV.budgetMonth]: "1000",
    });
    assert.deepEqual(config.budget, { day: 1000, month: 1000 });
    assert.deepEqual(config.problems, []);
});

test("an invalid budget value is named and leaves the budget unset", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.budgetDay]: "abc",
        [ENV.budgetMonth]: "1000",
    });
    assert.equal(config.budget, null);
    assert.deepEqual(config.problems, [ENV.budgetDay]);
});

/* ------------------------------------------------------- feature readiness */

test("without a budget no feature is configured, whatever else is set", () => {
    const config = resolveSemanticRetrievalConfig({
        ...RERANK_ENV,
        ...EMBED_ENV,
        [ENV.embedImagePrice]: "47000",
    });
    assert.notEqual(config.rerank, null);
    assert.notEqual(config.embed, null);
    for (const feature of SEMANTIC_RETRIEVAL_FEATURES) {
        assert.equal(semanticRetrievalFeatureConfigured(feature, config), false, feature);
    }
});

test("rerank features need the rerank configuration", () => {
    const rerankOnly = resolveSemanticRetrievalConfig({ ...BUDGET_ENV, ...RERANK_ENV });
    assert.equal(semanticRetrievalFeatureConfigured("knowledgeRerank", rerankOnly), true);
    assert.equal(semanticRetrievalFeatureConfigured("memoryRerank", rerankOnly), true);
    assert.equal(semanticRetrievalFeatureConfigured("knowledgeEmbed", rerankOnly), false);
    assert.equal(semanticRetrievalFeatureConfigured("memoryDuplicates", rerankOnly), false);
    assert.equal(semanticRetrievalFeatureConfigured("knowledgeImagePages", rerankOnly), false);
});

test("embed features need the embed configuration", () => {
    const embedOnly = resolveSemanticRetrievalConfig({ ...BUDGET_ENV, ...EMBED_ENV });
    assert.equal(semanticRetrievalFeatureConfigured("knowledgeEmbed", embedOnly), true);
    assert.equal(semanticRetrievalFeatureConfigured("memoryDuplicates", embedOnly), true);
    assert.equal(semanticRetrievalFeatureConfigured("knowledgeRerank", embedOnly), false);
    assert.equal(semanticRetrievalFeatureConfigured("memoryRerank", embedOnly), false);
});

test("image pages also need an image price", () => {
    const withoutImagePrice = resolveSemanticRetrievalConfig({ ...BUDGET_ENV, ...EMBED_ENV });
    assert.equal(
        semanticRetrievalFeatureConfigured("knowledgeImagePages", withoutImagePrice),
        false
    );
    const withImagePrice = resolveSemanticRetrievalConfig({
        ...BUDGET_ENV,
        ...EMBED_ENV,
        [ENV.embedImagePrice]: "47000",
    });
    assert.equal(semanticRetrievalFeatureConfigured("knowledgeImagePages", withImagePrice), true);
});

/* ------------------------------------------------------------- cost bounds */

const Q = "refund window";

test("rerank search units are at least one, even for no documents", () => {
    assert.equal(rerankWorstCaseSearchUnits(Q, []), 1);
});

test("a hundred short documents are one search unit and a hundred and one are two", () => {
    const short = Array.from({ length: 100 }, () => "short passage");
    assert.equal(rerankWorstCaseSearchUnits(Q, short), 1);
    assert.equal(rerankWorstCaseSearchUnits(Q, [...short, "one more"]), 2);
});

test("a long document is counted as several pieces", () => {
    const long = "x".repeat(3_600);
    // Capped at 1,024 tokens; a 13-byte query leaves 487 per piece: three pieces.
    assert.equal(rerankWorstCaseSearchUnits(Q, Array.from({ length: 33 }, () => long)), 1);
    assert.equal(rerankWorstCaseSearchUnits(Q, Array.from({ length: 34 }, () => long)), 2);
    assert.equal(rerankWorstCaseSearchUnits(Q, Array.from({ length: 100 }, () => long)), 3);
});

test("the query's length is part of the bound", () => {
    // The provider counts the query inside each 500-token piece, so a longer
    // question splits the same documents into more pieces.
    const documents = Array.from({ length: 100 }, () => "x".repeat(450));
    const short = rerankWorstCaseSearchUnits("q", documents);
    const long = rerankWorstCaseSearchUnits("q".repeat(400), documents);
    assert.equal(short, 1);
    assert.equal(long, 5);
});

test("a query past the byte bound reserves as the bounded query it is sent as", () => {
    const documents = Array.from({ length: 100 }, () => "x".repeat(1_024));
    const atBound = "q".repeat(SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes);
    const wayOver = "q".repeat(SEMANTIC_RETRIEVAL_LIMITS.maxQueryCharacters);
    assert.equal(
        rerankWorstCaseSearchUnits(wayOver, documents),
        rerankWorstCaseSearchUnits(atBound, documents)
    );
    // And the bound always leaves room for document text in every piece.
    assert.equal(rerankWorstCaseSearchUnits(wayOver, documents), 11);
});

test("pieces per document are capped by rerankMaxTokensPerDocument", () => {
    const cap = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxTokensPerDocument;
    const atCap = "x".repeat(cap);
    const wayOver = "x".repeat(cap * 50);
    const docs = (text) => Array.from({ length: 100 }, () => text);
    assert.equal(rerankWorstCaseSearchUnits(Q, docs(wayOver)), rerankWorstCaseSearchUnits(Q, docs(atCap)));
});

test("bytes, not characters, bound a document's tokens", () => {
    // 600 Hangul characters are 1,800 bytes, so more pieces than 600 ASCII ones.
    const ascii = Array.from({ length: 100 }, () => "a".repeat(600));
    const hangul = Array.from({ length: 100 }, () => "한".repeat(600));
    assert.ok(rerankWorstCaseSearchUnits(Q, hangul) > rerankWorstCaseSearchUnits(Q, ascii));
});

test("the reservation never falls below ceil(documents / 100)", () => {
    for (const count of [1, 7, 99, 100, 101, 250, 1000]) {
        const documents = Array.from({ length: count }, () => "tiny");
        assert.ok(
            rerankWorstCaseSearchUnits(Q, documents) >= Math.ceil(count / 100),
            `count ${count}`
        );
    }
});

test("the rerank query is cut in bytes without splitting a character", () => {
    const limit = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes;
    assert.equal(boundRerankQuery("short"), "short");
    assert.equal(Buffer.byteLength(boundRerankQuery("q".repeat(limit + 10))), limit);
    // Three-byte Hangul: the cut lands on a character boundary at or below the limit.
    const hangul = boundRerankQuery("한".repeat(limit));
    assert.equal(Buffer.byteLength(hangul), Math.floor(limit / 3) * 3);
    assert.ok(!hangul.includes("\uFFFD"));
    // Four-byte emoji are never halved.
    const emoji = boundRerankQuery("😀".repeat(limit));
    assert.equal(Buffer.byteLength(emoji) % 4, 0);
    assert.equal(boundRerankQuery("café"), "café");
});

test("rerank cost is search units times the unit price, rounded up", () => {
    assert.equal(rerankCostMicroUsd(0, 2000), 0);
    assert.equal(rerankCostMicroUsd(3, 7), 21);
    assert.equal(rerankCostMicroUsd(1.2, 5), 6);
});

test("embed cost rounds up to a whole micro-USD", () => {
    assert.equal(embedCostMicroUsd(0, 120000), 0);
    assert.equal(embedCostMicroUsd(1, 1), 1);
    assert.equal(embedCostMicroUsd(1_000_000, 120000), 120000);
    assert.equal(embedCostMicroUsd(1_000_001, 120000), 120001);
    assert.equal(embedCostMicroUsd(10, 120000), 2);
});

test("embed token bound is the sum of UTF-8 bytes, at least one per text", () => {
    assert.equal(embedTextWorstCaseTokens([]), 0);
    assert.equal(embedTextWorstCaseTokens([""]), 1);
    assert.equal(embedTextWorstCaseTokens(["", "abc"]), 4);
    assert.equal(embedTextWorstCaseTokens(["한글"]), 6);
    assert.equal(embedTextWorstCaseTokens(["abc", "한", "😀"]), 3 + 3 + 4);
});

/* --------------------------------------------------------------- wire shapes */

test("rerank body carries model, bounded query, documents and the per-document cap", () => {
    const documents = ["one", "two"];
    const body = rerankRequestBody({ model: "rerank-v3.5", query: "refund policy", documents });
    assert.deepEqual(body, {
        model: "rerank-v3.5",
        query: "refund policy",
        documents: ["one", "two"],
        max_tokens_per_doc: SEMANTIC_RETRIEVAL_LIMITS.rerankMaxTokensPerDocument,
    });
    assert.notEqual(body.documents, documents, "the documents are copied");
});

test("the rerank query is cut at rerankMaxQueryBytes", () => {
    const body = rerankRequestBody({
        model: "rerank-v3.5",
        query: "q".repeat(SEMANTIC_RETRIEVAL_LIMITS.maxQueryCharacters + 500),
        documents: ["d"],
    });
    assert.equal(Buffer.byteLength(body.query), SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes);
});

test("the query is normalised to NFC", () => {
    const body = rerankRequestBody({
        model: "rerank-v3.5",
        query: "café",
        documents: ["d"],
    });
    assert.equal(body.query, "café");
});

test("embed body for texts asks for int8 and omits a null dimension", () => {
    const body = embedRequestBody({
        model: "embed-v4.0",
        dimension: null,
        inputType: "search_document",
        texts: ["a", "b"],
    });
    assert.equal(body.model, "embed-v4.0");
    assert.equal(body.input_type, "search_document");
    assert.deepEqual(body.embedding_types, ["int8"]);
    assert.equal(body.truncate, "END");
    assert.deepEqual(body.texts, ["a", "b"]);
    assert.ok(!("output_dimension" in body));
    assert.ok(!("inputs" in body));
});

test("embed body includes output_dimension when one is configured", () => {
    const body = embedRequestBody({
        model: "embed-v4.0",
        dimension: 256,
        inputType: "search_query",
        texts: ["q"],
    });
    assert.equal(body.output_dimension, 256);
    assert.equal(body.input_type, "search_query");
});

test("embed body for images uses inputs and has no texts key", () => {
    const url = "data:image/jpeg;base64,AAAA";
    const body = embedRequestBody({
        model: "embed-v4.0",
        dimension: null,
        inputType: "search_document",
        images: [url, url],
    });
    assert.ok(!("texts" in body));
    assert.equal(body.inputs.length, 2);
    assert.equal(body.inputs[0].content[0].type, "image_url");
    assert.deepEqual(body.inputs[0].content[0].image_url, { url });
});

test("embed body without texts or images sends an empty texts list", () => {
    const body = embedRequestBody({
        model: "embed-v4.0",
        dimension: null,
        inputType: "search_query",
    });
    assert.deepEqual(body.texts, []);
});

/* ----------------------------------------------------------- score rounding */

test("scores are clamped to [0, 1] and rounded to four places", () => {
    assert.equal(roundSemanticScore(-0.5), 0);
    assert.equal(roundSemanticScore(1.7), 1);
    assert.equal(roundSemanticScore(0.123456), 0.1235);
    assert.equal(roundSemanticScore(0.12344), 0.1234);
    assert.equal(roundSemanticScore(0), 0);
    assert.equal(roundSemanticScore(1), 1);
});

/* ------------------------------------------------------------ rerank parsing */

const rerankBody = (results, extra = {}) => ({
    results,
    meta: { billed_units: { search_units: 1 } },
    ...extra,
});

test("a complete rerank answer becomes scores in submitted order", () => {
    const parsed = parseRerankResponse(
        rerankBody([
            { index: 2, relevance_score: 0.123456 },
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.5 },
        ]),
        3
    );
    assert.deepEqual(parsed, { scores: [0.9, 0.5, 0.1235], searchUnits: 1, inputTokens: null });
});

test("a missing billed search_units leaves searchUnits null but the scores valid", () => {
    const parsed = parseRerankResponse(
        { results: [{ index: 0, relevance_score: 0.4 }] },
        1
    );
    assert.deepEqual(parsed, { scores: [0.4], searchUnits: null, inputTokens: null });
});

test("a negative or non-numeric billed figure is treated as missing", () => {
    for (const searchUnits of [-1, "1", null, Number.NaN]) {
        const parsed = parseRerankResponse(
            {
                results: [{ index: 0, relevance_score: 0.4 }],
                meta: { billed_units: { search_units: searchUnits } },
            },
            1
        );
        assert.equal(parsed?.searchUnits, null, String(searchUnits));
    }
});

test("rerank scores above one are clamped", () => {
    const parsed = parseRerankResponse(rerankBody([{ index: 0, relevance_score: 4 }]), 1);
    assert.deepEqual(parsed?.scores, [1]);
});

test("a rerank answer is discarded whenever it does not score every document once", () => {
    const ok = (index) => ({ index, relevance_score: 0.5 });
    const cases = {
        "too few results": [rerankBody([ok(0)]), 2],
        "too many results": [rerankBody([ok(0), ok(1), ok(2)]), 2],
        "duplicate index": [rerankBody([ok(0), ok(0)]), 2],
        "index past the end": [rerankBody([ok(0), ok(2)]), 2],
        "negative index": [rerankBody([ok(0), ok(-1)]), 2],
        "fractional index": [rerankBody([ok(0), ok(1.5)]), 2],
        "string index": [rerankBody([ok(0), { index: "1", relevance_score: 0.5 }]), 2],
        "missing index": [rerankBody([ok(0), { relevance_score: 0.5 }]), 2],
        "string score": [rerankBody([ok(0), { index: 1, relevance_score: "0.5" }]), 2],
        "missing score": [rerankBody([ok(0), { index: 1 }]), 2],
        "NaN score": [rerankBody([ok(0), { index: 1, relevance_score: Number.NaN }]), 2],
        "infinite score": [
            rerankBody([ok(0), { index: 1, relevance_score: Number.POSITIVE_INFINITY }]),
            2,
        ],
        "null entry": [rerankBody([ok(0), null]), 2],
        "results is not an array": [{ results: { 0: ok(0) } }, 1],
        "results is missing": [{}, 1],
        "body is null": [null, 1],
        "body is a string": ["results", 1],
        "body is an array": [[ok(0)], 1],
    };
    for (const [name, [body, count]] of Object.entries(cases)) {
        assert.equal(parseRerankResponse(body, count), null, name);
    }
});

/* ------------------------------------------------------------- embed parsing */

const embedBody = (int8, meta) => ({
    embeddings: { int8 },
    ...(meta ? { meta } : {}),
});

test("a complete embed answer becomes one Int8Array per input", () => {
    const parsed = parseEmbedResponse(
        embedBody(
            [
                [1, -2, 3],
                [-128, 127, 0],
            ],
            { billed_units: { input_tokens: 12, image_tokens: 5 } }
        ),
        2
    );
    assert.ok(parsed);
    assert.equal(parsed.vectors.length, 2);
    assert.ok(parsed.vectors[0] instanceof Int8Array);
    assert.deepEqual(Array.from(parsed.vectors[0]), [1, -2, 3]);
    assert.deepEqual(Array.from(parsed.vectors[1]), [-128, 127, 0]);
    assert.equal(parsed.inputTokens, 12);
    assert.equal(parsed.imageTokens, 5);
});

test("missing billed units come back as null without invalidating the vectors", () => {
    const parsed = parseEmbedResponse(embedBody([[1, 2]]), 1);
    assert.ok(parsed);
    assert.equal(parsed.inputTokens, null);
    assert.equal(parsed.imageTokens, null);
});

test("an embed answer is discarded whenever it is not one clean int8 vector per input", () => {
    const cases = {
        "too few vectors": [embedBody([[1, 2]]), 2],
        "too many vectors": [embedBody([[1, 2], [3, 4]]), 1],
        "vectors of different length": [embedBody([[1, 2], [3]]), 2],
        "value above 127": [embedBody([[1, 128]]), 1],
        "value below -128": [embedBody([[1, -129]]), 1],
        "fractional value": [embedBody([[1, 1.5]]), 1],
        "string value": [embedBody([[1, "2"]]), 1],
        "NaN value": [embedBody([[1, Number.NaN]]), 1],
        "null value": [embedBody([[1, null]]), 1],
        "empty vector": [embedBody([[]]), 1],
        "vector is not an array": [embedBody(["12"]), 1],
        "vector is too long": [embedBody([new Array(4_097).fill(0)]), 1],
        "int8 missing": [{ embeddings: { float: [[0.1, 0.2]] } }, 1],
        "embeddings missing": [{}, 1],
        "int8 is not an array": [embedBody({ 0: [1] }), 1],
        "body is null": [null, 1],
        "body is a string": ["embeddings", 1],
    };
    for (const [name, [body, count]] of Object.entries(cases)) {
        assert.equal(parseEmbedResponse(body, count), null, name);
    }
});

test("a vector of exactly 4096 values is accepted", () => {
    const parsed = parseEmbedResponse(embedBody([new Array(4_096).fill(1)]), 1);
    assert.equal(parsed?.vectors[0].length, 4_096);
});

/* ------------------------------------------------------------------- vectors */

test("encodeVector and decodeVector round-trip, negative values included", () => {
    const vector = Int8Array.from([-128, -1, 0, 1, 127]);
    const decoded = decodeVector(encodeVector(vector));
    assert.ok(decoded instanceof Int8Array);
    assert.deepEqual(Array.from(decoded), [-128, -1, 0, 1, 127]);
});

test("encodeVector copies and respects a view's offset and length", () => {
    const backing = Int8Array.from([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const bytes = encodeVector(view);
    assert.equal(bytes.byteLength, 3);
    assert.deepEqual(Array.from(decodeVector(bytes)), [1, 2, 3]);
    backing[2] = 100;
    assert.deepEqual(Array.from(decodeVector(bytes)), [1, 2, 3], "the bytes are a copy");
});

test("decodeVector reads a Buffer, which is what a database driver returns", () => {
    const decoded = decodeVector(Buffer.from([255, 1, 128]));
    assert.deepEqual(Array.from(decoded), [-1, 1, -128]);
});

test("decodeVector returns null for null, undefined and empty input", () => {
    assert.equal(decodeVector(null), null);
    assert.equal(decodeVector(undefined), null);
    assert.equal(decodeVector(new Uint8Array(0)), null);
});

test("cosine similarity: identical, opposite, orthogonal", () => {
    const v = Int8Array.from([1, 2, 3]);
    assert.equal(cosineSimilarity(v, v), 1);
    assert.equal(cosineSimilarity(v, Int8Array.from([-1, -2, -3])), -1);
    assert.equal(cosineSimilarity(Int8Array.from([1, 0]), Int8Array.from([0, 1])), 0);
});

test("cosine similarity is rounded to four places", () => {
    const value = cosineSimilarity(Int8Array.from([1, 0]), Int8Array.from([1, 1]));
    assert.equal(value, 0.7071);
});

test("cosine similarity is 0 for vectors that cannot be compared", () => {
    assert.equal(cosineSimilarity(Int8Array.from([1, 2]), Int8Array.from([1, 2, 3])), 0);
    assert.equal(cosineSimilarity(Int8Array.from([0, 0]), Int8Array.from([1, 2])), 0);
    assert.equal(cosineSimilarity(Int8Array.from([1, 2]), Int8Array.from([0, 0])), 0);
    assert.equal(cosineSimilarity(new Int8Array(0), new Int8Array(0)), 0);
});

/* ----------------------------------------------------------- nearest neighbours */

const row = (id, ...values) => ({ id, vector: Int8Array.from(values) });
const NEIGHBOUR_ROWS = [
    row("c", 1, 1),
    row("b", 1, 0),
    row("e", -1, 0),
    row("a", 1, 0),
    row("d", 0, 1),
];
const QUERY = Int8Array.from([1, 0]);

test("nearest neighbours are ordered by similarity, then by id", () => {
    const result = nearestByCosine(QUERY, NEIGHBOUR_ROWS, { limit: 10, minSimilarity: -1 });
    assert.deepEqual(
        result.map((entry) => entry.id),
        ["a", "b", "c", "d", "e"]
    );
    assert.deepEqual(
        result.map((entry) => entry.similarity),
        [1, 1, 0.7071, 0, -1]
    );
});

test("rows below minSimilarity are dropped and the boundary is inclusive", () => {
    const excluded = nearestByCosine(QUERY, NEIGHBOUR_ROWS, { limit: 10, minSimilarity: 0.8 });
    assert.deepEqual(
        excluded.map((entry) => entry.id),
        ["a", "b"]
    );
    const boundary = nearestByCosine(QUERY, NEIGHBOUR_ROWS, { limit: 10, minSimilarity: 0.7071 });
    assert.deepEqual(
        boundary.map((entry) => entry.id),
        ["a", "b", "c"]
    );
});

test("limit keeps the best rows", () => {
    const result = nearestByCosine(QUERY, NEIGHBOUR_ROWS, { limit: 3, minSimilarity: -1 });
    assert.deepEqual(
        result.map((entry) => entry.id),
        ["a", "b", "c"]
    );
    assert.deepEqual(nearestByCosine(QUERY, NEIGHBOUR_ROWS, { limit: 0, minSimilarity: -1 }), []);
});

test("the neighbours do not depend on the order the rows arrived in", () => {
    const options = { limit: 4, minSimilarity: 0 };
    const expected = nearestByCosine(QUERY, NEIGHBOUR_ROWS, options);
    const permutations = [
        [...NEIGHBOUR_ROWS].reverse(),
        [NEIGHBOUR_ROWS[3], NEIGHBOUR_ROWS[0], NEIGHBOUR_ROWS[4], NEIGHBOUR_ROWS[1], NEIGHBOUR_ROWS[2]],
        [NEIGHBOUR_ROWS[1], NEIGHBOUR_ROWS[3], NEIGHBOUR_ROWS[2], NEIGHBOUR_ROWS[4], NEIGHBOUR_ROWS[0]],
    ];
    for (const rows of permutations) {
        assert.deepEqual(nearestByCosine(QUERY, rows, options), expected);
    }
});

test("rows of a different dimension score 0 and fall to the bottom", () => {
    const result = nearestByCosine(
        QUERY,
        [row("short", 1), row("same", 1, 0)],
        { limit: 5, minSimilarity: 0 }
    );
    assert.deepEqual(
        result.map((entry) => [entry.id, entry.similarity]),
        [
            ["same", 1],
            ["short", 0],
        ]
    );
});

/* ---------------------------------------------------------------- cache keys */

const rerankInput = (overrides = {}) => ({
    feature: "memoryRerank",
    userId: "user-1",
    model: "rerank-v3.5",
    query: "what coffee do I like",
    documents: [
        { id: "m1", text: "likes flat white" },
        { id: "m2", text: "works as an engineer" },
    ],
    ...overrides,
});

test("the same rerank input gives the same key", () => {
    const first = rerankCacheKey(rerankInput());
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(rerankCacheKey(rerankInput()), first);
});

test("an edited document text changes the key although its id is the same", () => {
    const base = rerankCacheKey(rerankInput());
    const edited = rerankCacheKey(
        rerankInput({
            documents: [
                { id: "m1", text: "likes long black" },
                { id: "m2", text: "works as an engineer" },
            ],
        })
    );
    assert.notEqual(edited, base);
});

test("a different document id changes the key", () => {
    const base = rerankCacheKey(rerankInput());
    const renamed = rerankCacheKey(
        rerankInput({
            documents: [
                { id: "m9", text: "likes flat white" },
                { id: "m2", text: "works as an engineer" },
            ],
        })
    );
    assert.notEqual(renamed, base);
});

test("userId, model, feature and query each change the rerank key", () => {
    const base = rerankCacheKey(rerankInput());
    const variants = [
        rerankInput({ userId: "user-2" }),
        rerankInput({ model: "rerank-v4.0" }),
        rerankInput({ feature: "knowledgeRerank" }),
        rerankInput({ query: "what tea do I like" }),
    ];
    const keys = variants.map(rerankCacheKey);
    for (const key of keys) assert.notEqual(key, base);
    assert.equal(new Set(keys).size, keys.length, "the variants differ from each other too");
});

test("queries that differ only past the length bound share a rerank key", () => {
    const bound = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes;
    const a = rerankCacheKey(rerankInput({ query: "q".repeat(bound) + "A" }));
    const b = rerankCacheKey(rerankInput({ query: "q".repeat(bound) + "B" }));
    assert.equal(a, b, "only the bounded query is ever sent, so only it is keyed");
});

test("the query embedding key changes with user, model label and query", () => {
    const input = { userId: "user-1", modelLabel: "cohere:embed-v4.0:default:int8", query: "refunds" };
    const base = queryEmbeddingCacheKey(input);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(queryEmbeddingCacheKey({ ...input }), base);
    const keys = [
        queryEmbeddingCacheKey({ ...input, userId: "user-2" }),
        queryEmbeddingCacheKey({ ...input, modelLabel: "cohere:embed-v4.0:256:int8" }),
        queryEmbeddingCacheKey({ ...input, query: "refund deadline" }),
    ];
    for (const key of keys) assert.notEqual(key, base);
    assert.equal(new Set(keys).size, keys.length);
});

test("a rerank key and a query embedding key never coincide for related input", () => {
    assert.notEqual(
        rerankCacheKey(rerankInput({ documents: [] })),
        queryEmbeddingCacheKey({
            userId: "user-1",
            modelLabel: "rerank-v3.5",
            query: "what coffee do I like",
        })
    );
});

/* ---------------------------------------------------------------- cache values */

test("the three cache value kinds pass through", () => {
    assert.deepEqual(parseSemanticCacheValue({ kind: "failed" }), { kind: "failed" });
    assert.deepEqual(parseSemanticCacheValue({ kind: "embedding", vector: "AQID" }), {
        kind: "embedding",
        vector: "AQID",
    });
    assert.deepEqual(
        parseSemanticCacheValue({
            kind: "rerank",
            scores: [
                ["a", 0.5],
                ["b", 0],
            ],
        }),
        {
            kind: "rerank",
            scores: [
                ["a", 0.5],
                ["b", 0],
            ],
        }
    );
    assert.deepEqual(parseSemanticCacheValue({ kind: "rerank", scores: [] }), {
        kind: "rerank",
        scores: [],
    });
});

test("a malformed cache value is null", () => {
    const bad = [
        null,
        undefined,
        "failed",
        42,
        [],
        {},
        { kind: "unknown" },
        { kind: "embedding" },
        { kind: "embedding", vector: "" },
        { kind: "embedding", vector: 12 },
        { kind: "rerank" },
        { kind: "rerank", scores: "a" },
        { kind: "rerank", scores: [["a"]] },
        { kind: "rerank", scores: [["a", 0.5, 1]] },
        { kind: "rerank", scores: [[1, 0.5]] },
        { kind: "rerank", scores: [["a", "0.5"]] },
        { kind: "rerank", scores: [["a", Number.NaN]] },
        { kind: "rerank", scores: [["a", Number.POSITIVE_INFINITY]] },
        { kind: "rerank", scores: [{ id: "a", score: 0.5 }] },
        { kind: "rerank", scores: [["a", 0.5], null] },
    ];
    for (const value of bad) {
        assert.equal(parseSemanticCacheValue(value), null, JSON.stringify(value));
    }
});

/* --------------------------------------------------------------- labels, periods */

test("the embedding label names provider, model, dimension and type", () => {
    assert.equal(
        embeddingModelLabel({
            model: "embed-v4.0",
            dimension: 256,
            microUsdPerMillionTextTokens: 1,
            microUsdPerMillionImageTokens: null,
        }),
        "cohere:embed-v4.0:256:int8"
    );
});

test("the embedding label says default when no dimension is configured", () => {
    assert.equal(
        embeddingModelLabel({
            model: "embed-v4.0",
            dimension: null,
            microUsdPerMillionTextTokens: 1,
            microUsdPerMillionImageTokens: null,
        }),
        "cohere:embed-v4.0:default:int8"
    );
});

test("budget periods start at UTC midnight and the UTC first of the month", () => {
    const periods = retrievalBudgetPeriods(new Date("2026-11-12T23:59:59.999Z"));
    assert.deepEqual(
        periods.map((entry) => [entry.period, entry.start.toISOString()]),
        [
            ["retrieval-cost-day", "2026-11-12T00:00:00.000Z"],
            ["retrieval-cost-month", "2026-11-01T00:00:00.000Z"],
        ]
    );
});

test("budget periods roll over at the UTC boundary, not the local one", () => {
    const monthStart = retrievalBudgetPeriods(new Date("2026-12-01T00:00:00.000Z"));
    assert.equal(monthStart[0].start.toISOString(), "2026-12-01T00:00:00.000Z");
    assert.equal(monthStart[1].start.toISOString(), "2026-12-01T00:00:00.000Z");

    const lastInstant = retrievalBudgetPeriods(new Date("2026-11-30T23:59:59.999Z"));
    assert.equal(lastInstant[0].start.toISOString(), "2026-11-30T00:00:00.000Z");
    assert.equal(lastInstant[1].start.toISOString(), "2026-11-01T00:00:00.000Z");

    const newYear = retrievalBudgetPeriods(new Date("2027-01-01T00:30:00.000Z"));
    assert.equal(newYear[0].start.toISOString(), "2027-01-01T00:00:00.000Z");
    assert.equal(newYear[1].start.toISOString(), "2027-01-01T00:00:00.000Z");
});

/* --------------------------------------------------- rerank billing units */

test("a per-token rerank price configures token billing", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.rerankModel]: "rerank-v5.0-fast",
        [ENV.rerankTokenPrice]: "50000",
    });
    assert.deepEqual(config.rerank, {
        model: "rerank-v5.0-fast",
        billing: { unit: "token", microUsdPerMillionTokens: 50000 },
    });
    assert.deepEqual(config.problems, []);
});

test("both rerank prices at once is not a configuration", () => {
    const config = resolveSemanticRetrievalConfig({
        [ENV.rerankModel]: "rerank-v5.0-fast",
        [ENV.rerankPrice]: "2000",
        [ENV.rerankTokenPrice]: "50000",
    });
    assert.equal(config.rerank, null);
    assert.deepEqual([...config.problems].sort(), [ENV.rerankPrice, ENV.rerankTokenPrice].sort());
});

test("the token bound counts the question beside every document", () => {
    const documents = ["a".repeat(100), "b".repeat(2_000)];
    const cap = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxTokensPerDocument;
    // 3-byte query: once on its own, once per document, plus each document capped.
    assert.equal(rerankWorstCaseTokens("abc", documents), 3 + (3 + 100) + (3 + cap));
    assert.equal(rerankWorstCaseTokens("", []), 1);
    // The question is bounded the way the request bounds it.
    const long = "q".repeat(SEMANTIC_RETRIEVAL_LIMITS.maxQueryCharacters);
    const bounded = SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes;
    assert.equal(rerankWorstCaseTokens(long, ["x"]), bounded + bounded + 1);
});

test("the reservation is bounded in the configured unit", () => {
    const documents = Array.from({ length: 100 }, () => "x".repeat(1_024));
    const perUnit = { unit: "search_unit", microUsdPerSearchUnit: 2000 };
    const perToken = { unit: "token", microUsdPerMillionTokens: 1_000_000 };
    assert.equal(
        rerankWorstCaseMicroUsd(perUnit, "q", documents),
        rerankCostMicroUsd(rerankWorstCaseSearchUnits("q", documents), 2000)
    );
    assert.equal(
        rerankWorstCaseMicroUsd(perToken, "q", documents),
        rerankWorstCaseTokens("q", documents)
    );
});

test("settlement reads only the billed figure in the configured unit", () => {
    const perUnit = { unit: "search_unit", microUsdPerSearchUnit: 2000 };
    const perToken = { unit: "token", microUsdPerMillionTokens: 1_000_000 };
    assert.equal(rerankBilledMicroUsd(perUnit, { searchUnits: 2, inputTokens: 900 }), 4000);
    assert.equal(rerankBilledMicroUsd(perToken, { searchUnits: 2, inputTokens: 900 }), 900);
    // Reported only in the other unit: no figure, so the hold stays.
    assert.equal(rerankBilledMicroUsd(perUnit, { searchUnits: null, inputTokens: 900 }), null);
    assert.equal(rerankBilledMicroUsd(perToken, { searchUnits: 2, inputTokens: null }), null);
});

test("a rerank answer reports both billed units it carries", () => {
    const parsed = parseRerankResponse(
        {
            results: [{ index: 0, relevance_score: 0.5 }],
            meta: { billed_units: { input_tokens: 812 } },
        },
        1
    );
    assert.equal(parsed.searchUnits, null);
    assert.equal(parsed.inputTokens, 812);
});

/* ---- privacy notice gate (docs/policy/external-conversation-import-and-memory.md §16) */

test("no semantic call is allowed before the privacy notice is published", async () => {
    const { SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED, semanticRetrievalNoticePublished } =
        await import("../lib/semanticRetrievalCore.ts");
    // The shipped value: the notice is not on the page yet.
    assert.equal(SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED, false);
    assert.equal(semanticRetrievalNoticePublished({}), false);
    assert.equal(semanticRetrievalNoticePublished({}, true), true);
    // The test stand-in works only in a test process.
    const standIn = { SEMANTIC_RETRIEVAL_TEST_NOTICE: "published" };
    assert.equal(semanticRetrievalNoticePublished({ ...standIn, NODE_ENV: "test" }), true);
    assert.equal(semanticRetrievalNoticePublished({ ...standIn, NODE_ENV: "production" }), false);
    assert.equal(semanticRetrievalNoticePublished({ ...standIn, NODE_ENV: "development" }), false);
    assert.equal(semanticRetrievalNoticePublished(standIn), false);
    assert.equal(semanticRetrievalNoticePublished({ NODE_ENV: "test", SEMANTIC_RETRIEVAL_TEST_NOTICE: "yes" }), false);
});

test("the notice flag is the one the /privacy page renders, inside the digest", async () => {
    const { readFileSync } = await import("node:fs");
    const { SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED } = await import("../lib/privacyNoticeStatus.ts");
    const { SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED } = await import("../lib/semanticRetrievalCore.ts");
    // One value decides both whether the page shows the notice and whether a
    // call may run, so the page can never say less than what is sent.
    assert.equal(SEMANTIC_RETRIEVAL_PRIVACY_NOTICE_PUBLISHED, SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED);
    // The flag lives in the file the /privacy digest hashes, so flipping it is
    // an owner-approved new /privacy version, not a side effect of this module.
    const verifiers = readFileSync("tests/support/amendedDocumentVerifiers.mjs", "utf8");
    assert.ok(verifiers.includes("privacyNoticeStatus"));
    assert.ok(readFileSync("lib/privacyNoticeStatus.ts", "utf8").includes("SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED"));
    assert.ok(!readFileSync("lib/semanticRetrievalCore.ts", "utf8").includes("= false as boolean"));
});

test("both rerank prices set is refused even when one of them does not parse", () => {
    for (const [unit, token] of [["2000", "-1"], ["2000", "abc"], ["oops", "50000"], ["0", "50000"]]) {
        const config = resolveSemanticRetrievalConfig({
            [ENV.rerankModel]: "rerank-v3.5",
            [ENV.rerankPrice]: unit,
            [ENV.rerankTokenPrice]: token,
        });
        assert.equal(config.rerank, null, `${unit} / ${token}`);
        assert.deepEqual([...config.problems].sort(), [ENV.rerankPrice, ENV.rerankTokenPrice].sort());
    }
});

test("a set rerank price that does not parse turns rerank off", () => {
    for (const name of [ENV.rerankPrice, ENV.rerankTokenPrice]) {
        const config = resolveSemanticRetrievalConfig({ [ENV.rerankModel]: "rerank-v3.5", [name]: "-5" });
        assert.equal(config.rerank, null, name);
        assert.deepEqual(config.problems, [name]);
    }
});
