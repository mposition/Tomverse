// Semantic knowledge selection: which chunks reach the prompt once an external
// model has scored them, and how a lexical list and a neighbour list are fused
// when nothing reranked them.
//
// The selection keeps the lexical selector's caps and presentation order on
// purpose, so most of these cases are comparisons with `selectKnowledgeContext`
// on the same input: turning a switch on may change which chunks are relevant,
// and must not change how many fit or in what order they are shown.

import assert from "node:assert/strict";
import test from "node:test";

import {
    KNOWLEDGE_CONTEXT_DEFAULTS,
    KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION,
    KNOWLEDGE_SEMANTIC_DEFAULTS,
    KNOWLEDGE_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION,
    fuseKnowledgeScores,
    selectKnowledgeContext,
    selectKnowledgeContextRanked,
} from "../lib/assistantKnowledgeRetrievalScoring.ts";
import { memoryRetrievalTerms } from "../lib/memoryRetrievalTerms.ts";

const QUERY = ["refunds", "days"];

const chunk = (overrides) => ({
    id: `c-${overrides.fileId ?? "f-a"}-${overrides.ordinal ?? 0}`,
    fileId: "f-a",
    fileName: "handbook.pdf",
    ordinal: 0,
    content: "Refunds are processed within thirty days of the request.",
    searchTerms: ["refunds", "processed", "within", "thirty", "days"],
    ...overrides,
});

/** A chunk that shares no term with QUERY, so only an external score can admit it. */
const unrelated = (overrides) =>
    chunk({
        content: "Quarterly figures are reconciled by finance.",
        searchTerms: ["quarterly", "figures", "reconciled", "finance"],
        ...overrides,
    });

const scoresOf = (...entries) => new Map(entries);
const idsOf = (selection) => selection.chunks.map((entry) => entry.id);

/* ------------------------------------------------------------------ constants */

test("the semantic selection has its own algorithm version", () => {
    assert.equal(KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION, 1);
    assert.equal(KNOWLEDGE_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION, 2);
});

test("the semantic defaults are usable numbers", () => {
    const defaults = KNOWLEDGE_SEMANTIC_DEFAULTS;
    assert.ok(defaults.neighbourLimit > 0);
    assert.ok(defaults.minSimilarity > 0 && defaults.minSimilarity < 1);
    assert.ok(defaults.minRerankScore > 0 && defaults.minRerankScore < 1);
    assert.equal(defaults.maxImagePages, 2);
    assert.ok(defaults.fusionK > 0);
});

/* ------------------------------------------------------------- ranked selection */

test("a chunk with no shared word is selected when the model scored it", () => {
    const candidate = unrelated({ id: "far" });
    const lexical = selectKnowledgeContext({ chunks: [candidate], query: QUERY });
    assert.equal(lexical.chunks.length, 0, "lexical selection would not have chosen it");

    const ranked = selectKnowledgeContextRanked({
        chunks: [candidate],
        scores: scoresOf(["far", 0.8]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["far"]);
    assert.equal(ranked.chunks[0].score, 0.8);
    assert.equal(ranked.chunks[0].termHits, 0);
});

test("a chunk without a score is below relevance", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [chunk({ id: "scored" }), chunk({ id: "unscored", ordinal: 1 })],
        scores: scoresOf(["scored", 0.5]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["scored"]);
    assert.equal(ranked.omitted.below_relevance, 1);
});

test("a chunk below minScore is below relevance and one at minScore is kept", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [
            chunk({ id: "low", ordinal: 0 }),
            chunk({ id: "edge", ordinal: 1 }),
            chunk({ id: "high", ordinal: 2 }),
        ],
        scores: scoresOf(["low", 0.0999], ["edge", 0.1], ["high", 0.7]),
        minScore: 0.1,
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["edge", "high"]);
    assert.equal(ranked.omitted.below_relevance, 1);
});

test("without minScore any scored chunk is eligible, even at zero", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [chunk({ id: "zero" })],
        scores: scoresOf(["zero", 0]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["zero"]);
});

test("the versions on the two selections differ", () => {
    const lexical = selectKnowledgeContext({ chunks: [chunk({})], query: QUERY });
    const ranked = selectKnowledgeContextRanked({
        chunks: [chunk({ id: "x" })],
        scores: scoresOf(["x", 0.5]),
        query: QUERY,
    });
    assert.equal(lexical.retrievalVersion, 1);
    assert.equal(ranked.retrievalVersion, 2);
});

test("an empty candidate list selects nothing", () => {
    const ranked = selectKnowledgeContextRanked({ chunks: [], scores: new Map(), query: QUERY });
    assert.deepEqual(ranked.chunks, []);
    assert.deepEqual(ranked.fileIds, []);
    assert.equal(ranked.estimatedTokens, 0);
    assert.equal(ranked.retrievalVersion, 2);
});

/* ------------------------------------------------------------------- the caps */

test("maxChunks caps the selection and counts the rest as chunk_cap", () => {
    const chunks = Array.from({ length: 8 }, (_, index) =>
        chunk({ fileId: `f-${index}`, id: `c-${index}` })
    );
    const scores = new Map(chunks.map((entry, index) => [entry.id, 0.9 - index * 0.05]));
    const ranked = selectKnowledgeContextRanked({ chunks, scores, query: QUERY });
    assert.equal(ranked.chunks.length, KNOWLEDGE_CONTEXT_DEFAULTS.maxChunks);
    assert.equal(ranked.omitted.chunk_cap, 2);
    // The two weakest are the ones dropped.
    assert.ok(!idsOf(ranked).includes("c-7"));
    assert.ok(!idsOf(ranked).includes("c-6"));

    const narrower = selectKnowledgeContextRanked({
        chunks,
        scores,
        query: QUERY,
        budget: { maxChunks: 2 },
    });
    assert.deepEqual(idsOf(narrower), ["c-0", "c-1"]);
});

test("maxChunksPerFile stops one document taking every slot", () => {
    const many = Array.from({ length: 6 }, (_, ordinal) =>
        chunk({ fileId: "f-long", ordinal, id: `long-${ordinal}` })
    );
    const other = chunk({ fileId: "f-other", id: "other-0", fileName: "policy.pdf" });
    const scores = new Map([...many, other].map((entry) => [entry.id, 0.9]));
    scores.set("other-0", 0.2);
    const ranked = selectKnowledgeContextRanked({ chunks: [...many, other], scores, query: QUERY });
    assert.equal(
        ranked.chunks.filter((entry) => entry.fileId === "f-long").length,
        KNOWLEDGE_CONTEXT_DEFAULTS.maxChunksPerFile
    );
    assert.ok(idsOf(ranked).includes("other-0"));
    assert.equal(ranked.omitted.file_cap, 3);
});

test("the token budget skips an oversized chunk and keeps going", () => {
    const huge = chunk({
        fileId: "f-huge",
        id: "huge",
        content: "x".repeat(KNOWLEDGE_CONTEXT_DEFAULTS.maxTokens * 4),
    });
    const small = chunk({ fileId: "f-small", id: "small" });
    const ranked = selectKnowledgeContextRanked({
        chunks: [huge, small],
        scores: scoresOf(["huge", 0.99], ["small", 0.4]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["small"]);
    assert.equal(ranked.omitted.token_budget, 1);
});

test("caps and omissions match the lexical selection when the scores agree with it", () => {
    // Every candidate matches both query terms, so the lexical gate drops
    // nothing and the two selections differ only in how they score.
    const chunks = [
        ...Array.from({ length: 5 }, (_, ordinal) =>
            chunk({ fileId: "f-a", ordinal, id: `a-${ordinal}` })
        ),
        ...Array.from({ length: 4 }, (_, ordinal) =>
            chunk({ fileId: "f-b", ordinal, id: `b-${ordinal}` })
        ),
        chunk({
            fileId: "f-0",
            id: "huge",
            content: "x".repeat(KNOWLEDGE_CONTEXT_DEFAULTS.maxTokens * 4),
        }),
    ];
    const lexical = selectKnowledgeContext({ chunks, query: QUERY });
    const scores = new Map(chunks.map((entry) => [entry.id, 1]));
    const ranked = selectKnowledgeContextRanked({ chunks, scores, query: QUERY });
    assert.deepEqual(idsOf(ranked), idsOf(lexical));
    assert.deepEqual(ranked.omitted, lexical.omitted);
    assert.equal(ranked.estimatedTokens, lexical.estimatedTokens);
    assert.deepEqual(ranked.fileIds, lexical.fileIds);
});

/* --------------------------------------------------------------------- order */

test("selected chunks are shown by file and ordinal, not by score", () => {
    const chunks = [
        chunk({ fileId: "f-b", ordinal: 0, id: "b0" }),
        chunk({ fileId: "f-a", ordinal: 5, id: "a5" }),
        chunk({ fileId: "f-a", ordinal: 2, id: "a2" }),
    ];
    const ranked = selectKnowledgeContextRanked({
        chunks,
        scores: scoresOf(["b0", 0.9], ["a5", 0.8], ["a2", 0.3]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["a2", "a5", "b0"]);
    assert.deepEqual(ranked.fileIds, ["f-a", "f-b"]);
});

test("equal scores break toward the earlier passage whatever the input order", () => {
    const chunks = [
        chunk({ fileId: "f-b", ordinal: 0, id: "b0" }),
        chunk({ fileId: "f-a", ordinal: 3, id: "a3" }),
        chunk({ fileId: "f-a", ordinal: 1, id: "a1" }),
        chunk({ fileId: "f-a", ordinal: 2, id: "a2" }),
    ];
    const scores = new Map(chunks.map((entry) => [entry.id, 0.5]));
    const run = (list) =>
        selectKnowledgeContextRanked({
            chunks: list,
            scores,
            query: QUERY,
            budget: { maxChunks: 2 },
        });
    const expected = run(chunks);
    assert.deepEqual(idsOf(expected), ["a1", "a2"]);
    const permutations = [
        [...chunks].reverse(),
        [chunks[2], chunks[0], chunks[3], chunks[1]],
        [chunks[1], chunks[3], chunks[2], chunks[0]],
    ];
    for (const list of permutations) {
        const selection = run(list);
        assert.deepEqual(idsOf(selection), idsOf(expected));
        assert.deepEqual(selection.omitted, expected.omitted);
    }
});

test("scores that differ only past six decimals count as equal", () => {
    const chunks = [
        chunk({ fileId: "f-a", ordinal: 2, id: "later" }),
        chunk({ fileId: "f-a", ordinal: 1, id: "earlier" }),
    ];
    const ranked = selectKnowledgeContextRanked({
        chunks,
        scores: scoresOf(["later", 0.5000000001], ["earlier", 0.5]),
        query: QUERY,
        budget: { maxChunks: 1 },
    });
    assert.deepEqual(idsOf(ranked), ["earlier"]);
});

/* ---------------------------------------------------------------- image pages */

const page = (ordinal, overrides = {}) =>
    chunk({
        fileId: "f-scan",
        ordinal,
        id: `page-${ordinal}`,
        content: `Scanned page ${ordinal + 1}`,
        searchTerms: [],
        imagePage: true,
        ...overrides,
    });

test("an image page is judged by its image similarity, not by scores", () => {
    const scanned = page(0);
    const withSimilarity = selectKnowledgeContextRanked({
        chunks: [scanned],
        scores: new Map(),
        imagePageSimilarities: scoresOf(["page-0", 0.62]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(withSimilarity), ["page-0"]);
    assert.equal(withSimilarity.chunks[0].score, 0.62);

    const scoreOnly = selectKnowledgeContextRanked({
        chunks: [scanned],
        scores: scoresOf(["page-0", 0.99]),
        query: QUERY,
    });
    assert.deepEqual(scoreOnly.chunks, [], "a text score cannot admit a scanned page");
    assert.equal(scoreOnly.omitted.below_relevance, 1);
});

test("an image page without a similarity is left out", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [page(0), page(1)],
        scores: new Map(),
        imagePageSimilarities: scoresOf(["page-1", 0.5]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["page-1"]);
    assert.equal(ranked.omitted.below_relevance, 1);
});

test("an image similarity cannot admit an ordinary passage", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [chunk({ id: "text" })],
        scores: new Map(),
        imagePageSimilarities: scoresOf(["text", 0.9]),
        query: QUERY,
    });
    assert.deepEqual(ranked.chunks, []);
    assert.equal(ranked.omitted.below_relevance, 1);
});

test("at most maxImagePages pages are taken, best first, and the rest are chunk_cap", () => {
    const pages = [page(0), page(1), page(2), page(3)];
    const ranked = selectKnowledgeContextRanked({
        chunks: pages,
        scores: new Map(),
        imagePageSimilarities: scoresOf(
            ["page-0", 0.4],
            ["page-1", 0.9],
            ["page-2", 0.7],
            ["page-3", 0.5]
        ),
        query: QUERY,
    });
    assert.equal(KNOWLEDGE_SEMANTIC_DEFAULTS.maxImagePages, 2);
    assert.deepEqual(idsOf(ranked), ["page-1", "page-2"]);
    assert.equal(ranked.omitted.chunk_cap, 2);
});

test("image pages take their slots before passages do", () => {
    const passages = [
        chunk({ fileId: "f-a", ordinal: 0, id: "p0" }),
        chunk({ fileId: "f-a", ordinal: 1, id: "p1" }),
        chunk({ fileId: "f-a", ordinal: 2, id: "p2" }),
    ];
    const scanned = [page(0), page(1)];
    const ranked = selectKnowledgeContextRanked({
        chunks: [...passages, ...scanned],
        scores: scoresOf(["p0", 0.99], ["p1", 0.98], ["p2", 0.97]),
        imagePageSimilarities: scoresOf(["page-0", 0.31], ["page-1", 0.32]),
        query: QUERY,
        budget: { maxChunks: 3 },
    });
    // Both pages despite weaker numbers, then the single best passage.
    assert.deepEqual(new Set(idsOf(ranked)), new Set(["page-0", "page-1", "p0"]));
    assert.equal(ranked.omitted.chunk_cap, 2);
});

test("with room for only the pages, no passage is selected", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [chunk({ id: "p0" }), page(0), page(1)],
        scores: scoresOf(["p0", 0.99]),
        imagePageSimilarities: scoresOf(["page-0", 0.31], ["page-1", 0.32]),
        query: QUERY,
        budget: { maxChunks: 2 },
    });
    assert.deepEqual(new Set(idsOf(ranked)), new Set(["page-0", "page-1"]));
    assert.equal(ranked.omitted.chunk_cap, 1);
});

test("selected pages and passages are presented in document order together", () => {
    const ranked = selectKnowledgeContextRanked({
        chunks: [
            chunk({ fileId: "f-scan", ordinal: 5, id: "text-5" }),
            page(2),
            page(0),
        ],
        scores: scoresOf(["text-5", 0.9]),
        imagePageSimilarities: scoresOf(["page-2", 0.5], ["page-0", 0.6]),
        query: QUERY,
    });
    assert.deepEqual(idsOf(ranked), ["page-0", "page-2", "text-5"]);
});

/* ---------------------------------------------------------------------- fusion */

// QUERY = refunds, days.
const A = () => chunk({ id: "A", ordinal: 0, searchTerms: ["refunds", "days", "policy"] });
const B = () => chunk({ id: "B", ordinal: 1, searchTerms: ["refunds", "days"] });
const ONE_HIT = () => chunk({ id: "ONE", ordinal: 2, searchTerms: ["refunds"] });
const FAR = (id, ordinal) => unrelated({ id, ordinal });

const RRF_K = KNOWLEDGE_SEMANTIC_DEFAULTS.fusionK;
const BEST = 2 / (RRF_K + 1);
const fused = (...ranks) =>
    ranks.reduce((total, rank) => total + 1 / (RRF_K + rank), 0) / BEST;

const assertClose = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} vs ${expected}`);

test("a chunk first in both lists scores exactly 1", () => {
    const scores = fuseKnowledgeScores({
        chunks: [A(), B()],
        query: QUERY,
        similarities: scoresOf(["A", 0.9], ["B", 0.4]),
    });
    // A and B have the same lexical relevance (both cover the whole query), so
    // lexical order is the document order; A leads both lists.
    assertClose(scores.get("A"), 1, "A");
    assertClose(scores.get("B"), fused(2, 2), "B");
});

test("a chunk in one list scores below a chunk in both", () => {
    const both = A();
    const lexicalOnly = B();
    const neighbourOnly = FAR("NEIGH", 3);
    const scores = fuseKnowledgeScores({
        chunks: [both, lexicalOnly, neighbourOnly],
        query: QUERY,
        similarities: scoresOf(["A", 0.9], ["NEIGH", 0.8]),
    });
    assertClose(scores.get("A"), 1, "both");
    assertClose(scores.get("B"), fused(2), "lexical only");
    assertClose(scores.get("NEIGH"), fused(2), "neighbour only");
    assert.ok(scores.get("A") > scores.get("B"));
    assert.ok(scores.get("A") > scores.get("NEIGH"));
});

test("only gate-passing or neighbouring chunks get a score", () => {
    const scores = fuseKnowledgeScores({
        chunks: [A(), ONE_HIT(), FAR("FAR", 3), FAR("NEIGH", 4)],
        query: QUERY,
        similarities: scoresOf(["NEIGH", 0.5]),
    });
    assert.deepEqual([...scores.keys()].sort(), ["A", "NEIGH"]);
});

test("with no similarities only the lexical rank counts", () => {
    const scores = fuseKnowledgeScores({
        chunks: [A(), B(), ONE_HIT()],
        query: QUERY,
        similarities: new Map(),
    });
    assert.deepEqual([...scores.keys()].sort(), ["A", "B"]);
    assertClose(scores.get("A"), fused(1), "first");
    assertClose(scores.get("B"), fused(2), "second");
    assert.ok(scores.get("A") > scores.get("B"));
    assert.ok(scores.get("A") <= 0.5 + 1e-12, "one list alone can never reach 1");
});

test("a similarity for an id that is not a candidate is ignored", () => {
    const scores = fuseKnowledgeScores({
        chunks: [A()],
        query: QUERY,
        similarities: scoresOf(["ghost", 0.99], ["A", 0.4]),
    });
    assert.deepEqual([...scores.keys()], ["A"]);
    assertClose(scores.get("A"), 1, "A");
});

test("a stronger neighbour outranks a weaker one", () => {
    const scores = fuseKnowledgeScores({
        chunks: [FAR("X", 0), FAR("Y", 1)],
        query: QUERY,
        similarities: scoresOf(["X", 0.31], ["Y", 0.77]),
    });
    assert.ok(scores.get("Y") > scores.get("X"));
});

test("minTermHits can widen the lexical gate", () => {
    const strict = fuseKnowledgeScores({
        chunks: [A(), ONE_HIT()],
        query: QUERY,
        similarities: new Map(),
    });
    assert.ok(!strict.has("ONE"));
    const loose = fuseKnowledgeScores({
        chunks: [A(), ONE_HIT()],
        query: QUERY,
        similarities: new Map(),
        minTermHits: 1,
    });
    assert.ok(loose.has("ONE"));
});

test("fusion does not depend on the order the candidates arrived in", () => {
    const chunks = [
        A(),
        B(),
        chunk({ id: "C", fileId: "f-b", ordinal: 0, searchTerms: ["refunds", "days"] }),
        FAR("NEIGH-1", 5),
        FAR("NEIGH-2", 6),
    ];
    const similarities = scoresOf(["B", 0.6], ["NEIGH-1", 0.6], ["NEIGH-2", 0.6], ["C", 0.6]);
    const expected = fuseKnowledgeScores({ chunks, query: QUERY, similarities });
    const permutations = [
        [...chunks].reverse(),
        [chunks[3], chunks[1], chunks[4], chunks[0], chunks[2]],
        [chunks[2], chunks[4], chunks[0], chunks[3], chunks[1]],
    ];
    for (const list of permutations) {
        const actual = fuseKnowledgeScores({ chunks: list, query: QUERY, similarities });
        assert.deepEqual(
            [...actual.entries()].sort(),
            [...expected.entries()].sort()
        );
    }
});

test("a raw string query is tokenised like a token list", () => {
    const text = "refunds days";
    const chunks = [A(), B()];
    const similarities = scoresOf(["B", 0.5]);
    assert.deepEqual(
        [...fuseKnowledgeScores({ chunks, query: text, similarities })],
        [...fuseKnowledgeScores({ chunks, query: memoryRetrievalTerms(text), similarities })]
    );
});

test("fused scores feed the ranked selection", () => {
    const chunks = [A(), B(), ONE_HIT(), FAR("NEIGH", 3)];
    const scores = fuseKnowledgeScores({
        chunks,
        query: QUERY,
        similarities: scoresOf(["A", 0.9], ["NEIGH", 0.5]),
    });
    const ranked = selectKnowledgeContextRanked({ chunks, scores, query: QUERY });
    assert.deepEqual(idsOf(ranked), ["A", "B", "NEIGH"]);
    assert.equal(ranked.omitted.below_relevance, 1, "the single-term chunk was never a candidate");
});

/* ------------------------------------------------------------------ regression */

test("the lexical selection is unchanged by the shared budget code", () => {
    const chunks = [
        chunk({ ordinal: 4, id: "d", searchTerms: ["refunds", "days", "policy"] }),
        chunk({ ordinal: 1, id: "b", searchTerms: ["refunds", "days"] }),
        chunk({ ordinal: 2, id: "c", searchTerms: ["refunds"] }),
        chunk({ fileId: "f-b", ordinal: 0, id: "e", searchTerms: ["days", "refunds"] }),
    ];
    const selection = selectKnowledgeContext({
        chunks,
        query: ["refunds", "days", "policy"],
    });
    assert.deepEqual(idsOf(selection), ["b", "d", "e"]);
    assert.equal(selection.omitted.below_relevance, 1);
    assert.equal(selection.retrievalVersion, KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION);
    assert.deepEqual(selection.fileIds, ["f-a", "f-b"]);
    assert.deepEqual(
        selection.chunks.map((entry) => entry.termHits),
        [2, 3, 2]
    );
});
