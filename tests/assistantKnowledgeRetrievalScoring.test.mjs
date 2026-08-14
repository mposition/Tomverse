// Release C2: which knowledge chunks are worth the prompt space.
//
// The three properties under test are the ones that make a lexical retriever
// usable rather than merely present: a coincidental term match does not count,
// one long document cannot take every slot, and the chunks that do get in are
// presented in the order the document wrote them.

import assert from "node:assert/strict";
import test from "node:test";

import {
    KNOWLEDGE_CONTEXT_DEFAULTS,
    KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION,
    chunkTermOverlap,
    estimateChunkTokens,
    selectKnowledgeContext,
} from "../lib/assistantKnowledgeRetrievalScoring.ts";

const chunk = (overrides) => ({
    id: `c-${overrides.fileId}-${overrides.ordinal}`,
    fileId: "f-a",
    fileName: "handbook.pdf",
    ordinal: 0,
    content: "Refunds are processed within thirty days of the request.",
    searchTerms: ["refunds", "processed", "within", "thirty", "days"],
    ...overrides,
});

test("a single shared term is a coincidence, not a match", () => {
    // At 1,200 characters a chunk shares a common word with everything. A
    // retriever that fired on one token would answer every question with the
    // same passage.
    const selection = selectKnowledgeContext({
        chunks: [chunk({ searchTerms: ["refunds", "unrelated", "text"] })],
        query: ["refunds", "policy", "deadline"],
    });
    assert.equal(selection.chunks.length, 0);
    assert.equal(selection.omitted.below_relevance, 1);
});

test("two shared terms is a match", () => {
    const selection = selectKnowledgeContext({
        chunks: [chunk({})],
        query: ["refunds", "days"],
    });
    assert.equal(selection.chunks.length, 1);
    assert.equal(selection.chunks[0].termHits, 2);
});

test("relevance is measured against the question, not against the chunk", () => {
    // Dividing by the chunk's own term count would rank a heading above the
    // paragraph that answers, because the heading has fewer terms to dilute
    // the hit.
    const { relevance } = chunkTermOverlap(
        ["refunds", "days", "policy", "escalation"],
        ["refunds", "days"]
    );
    assert.equal(relevance, 0.5);
    const short = chunkTermOverlap(["refunds", "days"], ["refunds", "days"]);
    assert.equal(short.relevance, 1);
});

test("one document cannot take every slot", () => {
    // Without a per-file cap a long document wins everything and the other
    // files the owner attached are never consulted -- which reads to them as
    // the assistant having ignored the file they uploaded.
    const many = Array.from({ length: 6 }, (_, ordinal) =>
        chunk({ fileId: "f-long", ordinal, id: `long-${ordinal}` })
    );
    const other = chunk({
        fileId: "f-other",
        ordinal: 0,
        id: "other-0",
        fileName: "policy.pdf",
    });
    const selection = selectKnowledgeContext({
        chunks: [...many, other],
        query: ["refunds", "days"],
    });
    const fromLong = selection.chunks.filter((c) => c.fileId === "f-long");
    assert.equal(fromLong.length, KNOWLEDGE_CONTEXT_DEFAULTS.maxChunksPerFile);
    assert.ok(
        selection.chunks.some((c) => c.fileId === "f-other"),
        "the second file was crowded out entirely"
    );
    assert.ok(selection.omitted.file_cap > 0);
});

test("selected chunks are presented in document order, not in score order", () => {
    // Ranking decides what gets in; reading order decides whether what got in
    // makes sense. A model handed a document's passages shuffled cannot quote
    // them.
    const chunks = [
        chunk({ ordinal: 4, id: "d", searchTerms: ["refunds", "days", "policy"] }),
        chunk({ ordinal: 1, id: "b", searchTerms: ["refunds", "days"] }),
        chunk({ ordinal: 2, id: "c", searchTerms: ["refunds", "days"] }),
    ];
    const selection = selectKnowledgeContext({
        chunks,
        query: ["refunds", "days", "policy"],
    });
    assert.deepEqual(
        selection.chunks.map((c) => c.ordinal),
        [1, 2, 4]
    );
    // ...and the highest-scoring one really did score highest, so the
    // assertion above is about presentation rather than about ranking failing.
    assert.equal(
        [...selection.chunks].sort((a, b) => b.score - a.score)[0].ordinal,
        4
    );
});

test("the token budget skips an oversized chunk rather than stopping", () => {
    // Breaking at the first chunk that does not fit would drop a whole file
    // because one of its passages was long.
    const huge = chunk({
        fileId: "f-huge",
        ordinal: 0,
        id: "huge",
        content: "x".repeat(KNOWLEDGE_CONTEXT_DEFAULTS.maxTokens * 4),
        searchTerms: ["refunds", "days"],
    });
    const small = chunk({ fileId: "f-small", ordinal: 0, id: "small" });
    const selection = selectKnowledgeContext({
        chunks: [huge, small],
        query: ["refunds", "days"],
    });
    assert.deepEqual(
        selection.chunks.map((c) => c.id),
        ["small"]
    );
    assert.equal(selection.omitted.token_budget, 1);
});

test("ties break toward the earlier passage, and the order is total", () => {
    // Two chunks that score identically are usually adjacent passages. A
    // comparator that returned 0 for two different rows would make the whole
    // selection depend on how the database happened to sort them.
    const a = chunk({ fileId: "f-a", ordinal: 3, id: "a3" });
    const b = chunk({ fileId: "f-a", ordinal: 1, id: "a1" });
    const forward = selectKnowledgeContext({
        chunks: [a, b],
        query: ["refunds", "days"],
        budget: { maxChunks: 1 },
    });
    const reversed = selectKnowledgeContext({
        chunks: [b, a],
        query: ["refunds", "days"],
        budget: { maxChunks: 1 },
    });
    assert.deepEqual(
        forward.chunks.map((c) => c.id),
        reversed.chunks.map((c) => c.id)
    );
    assert.equal(forward.chunks[0].ordinal, 1);
});

test("an empty query retrieves nothing", () => {
    const selection = selectKnowledgeContext({ chunks: [chunk({})], query: [] });
    assert.equal(selection.chunks.length, 0);
    assert.deepEqual(selection.fileIds, []);
});

test("the selection reports its algorithm version", () => {
    const selection = selectKnowledgeContext({
        chunks: [chunk({})],
        query: ["refunds", "days"],
    });
    assert.equal(
        selection.retrievalVersion,
        KNOWLEDGE_RETRIEVAL_ALGORITHM_VERSION
    );
    assert.deepEqual(selection.fileIds, ["f-a"]);
});

test("token estimates count bytes, not characters", () => {
    // A Korean passage costs about three times a Latin one of the same length
    // in UTF-8. Counting characters would let a CJK document take three times
    // the prompt share the budget says it may.
    assert.ok(
        estimateChunkTokens("환불 정책 안내") > estimateChunkTokens("refund policy")
    );
});
