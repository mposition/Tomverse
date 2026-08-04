import assert from "node:assert/strict";
import test from "node:test";
import { memoryRetrievalTerms } from "../lib/memoryRetrievalTerms.ts";
import {
    MEMORY_CONTEXT_DEFAULTS,
    MEMORY_RETRIEVAL_ALGORITHM_VERSION,
    estimateMemoryTokens,
    scoreMemory,
    selectMemoryContext,
    termRelevance,
} from "../lib/memoryRetrievalScoring.ts";

/**
 * Retrieval v1 scoring and the context budget (§9).
 *
 * The assertions that matter are the ones a plausible-looking implementation
 * gets wrong: core and pinned memories surviving an unrelated request, the
 * reduction order when the budget binds, one source not filling the whole
 * context, and two identical calls producing byte-identical selections.
 */

const NOW = new Date("2026-08-04T00:00:00.000Z");

const memory = (id, overrides = {}) => {
    const statement = overrides.statement ?? `statement ${id}`;
    return {
        id,
        kind: "preference",
        statement,
        conflictKey: null,
        confidence: 0.9,
        importance: 0,
        pinned: false,
        searchTerms: memoryRetrievalTerms(statement),
        effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
        expiresAt: null,
        sourceIds: [],
        ...overrides,
    };
};

const idsOf = (selection) => selection.selected.map((row) => row.memory.id);

/* --------------------------------------------------------------- relevance */

test("relevance measures how much of the request a memory covers", () => {
    assert.equal(termRelevance(["coffee", "tea"], ["coffee"]), 0.5);
    assert.equal(termRelevance(["coffee"], ["coffee", "tea", "milk"]), 1);
    assert.equal(termRelevance([], ["coffee"]), 0);
    assert.equal(termRelevance(["coffee"], []), 0);
});

test("a short memory is not rewarded for covering little", () => {
    // Dividing by the memory's own term count would make "tea" beat a fuller
    // statement that answers the same query.
    const query = ["tea"];
    assert.equal(
        termRelevance(query, ["tea"]),
        termRelevance(query, ["tea", "and", "coffee", "daily"])
    );
});

test("duplicate query terms do not inflate relevance", () => {
    assert.equal(termRelevance(["tea", "tea", "tea"], ["tea"]), 1);
});

/* ------------------------------------------------------------------ tokens */

test("token estimates include the framing cost of a rendered line", () => {
    assert.ok(estimateMemoryTokens("") > 0, "an empty statement still costs");
    assert.ok(
        estimateMemoryTokens("a".repeat(300)) >
            estimateMemoryTokens("a".repeat(30))
    );
    // Korean is three UTF-8 bytes per character, so it must cost more than the
    // same number of ASCII characters — a char-count estimate would under-book
    // it and blow the budget it was supposed to enforce.
    assert.ok(
        estimateMemoryTokens("사용자는 커피를 좋아한다") >
            estimateMemoryTokens("abcdefghijkl")
    );
});

/* ------------------------------------------------------------------ tiers  */

test("core memories are kept even when the request is unrelated", () => {
    const selection = selectMemoryContext({
        memories: [
            memory("core", {
                kind: "occupation",
                statement: "사용자는 백엔드 엔지니어로 일한다",
            }),
            memory("chatty", { statement: "사용자는 아침에 산책을 한다" }),
        ],
        query: "quantum computing",
        now: NOW,
    });
    assert.deepEqual(idsOf(selection), ["core"]);
    assert.equal(selection.omitted.below_relevance, 1);
});

test("one shared term is enough, however long the request", () => {
    // Guards against gating on the overlap *ratio*: in a thirty-term request a
    // genuinely relevant memory covers a tiny fraction of it, and a ratio
    // threshold would discard exactly the long questions memory helps most.
    const selection = selectMemoryContext({
        memories: [memory("hit", { statement: "사용자는 커피를 좋아한다" })],
        query: `커피 ${Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ")}`,
        now: NOW,
    });
    assert.deepEqual(idsOf(selection), ["hit"]);
});

test("a pinned memory is kept whatever its kind and relevance", () => {
    const selection = selectMemoryContext({
        memories: [memory("pinned", { pinned: true })],
        query: "unrelated request",
        now: NOW,
    });
    assert.deepEqual(idsOf(selection), ["pinned"]);
});

test("style memories are dropped entirely when the style toggle is off", () => {
    const memories = [
        memory("tone", { kind: "tone", statement: "사용자는 존댓말을 선호한다" }),
        memory("fact", { kind: "identity", statement: "사용자는 서울에 산다" }),
    ];
    const on = selectMemoryContext({ memories, query: "존댓말", now: NOW });
    const off = selectMemoryContext({
        memories,
        query: "존댓말",
        now: NOW,
        styleEnabled: false,
    });
    assert.ok(idsOf(on).includes("tone"));
    assert.ok(!idsOf(off).includes("tone"));
    assert.ok(idsOf(off).includes("fact"), "facts are unaffected");
});

test("core is placed before relevant, and relevant before style", () => {
    const selection = selectMemoryContext({
        memories: [
            memory("style", { kind: "verbosity", statement: "짧은 답변 선호" }),
            memory("relevant", { statement: "커피를 좋아한다" }),
            memory("core", { kind: "identity", statement: "커피 로스터로 일한다" }),
        ],
        query: "커피 짧은",
        now: NOW,
    });
    assert.deepEqual(idsOf(selection), ["core", "relevant", "style"]);
});

/* ------------------------------------------------------------- reductions  */

test("an expired memory is never selected", () => {
    const selection = selectMemoryContext({
        memories: [
            memory("gone", {
                pinned: true,
                expiresAt: new Date("2026-08-03T00:00:00.000Z"),
            }),
        ],
        query: "anything",
        now: NOW,
    });
    assert.deepEqual(idsOf(selection), []);
    assert.equal(selection.omitted.expired, 1);
});

test("memories sharing a conflict key are included once", () => {
    const selection = selectMemoryContext({
        memories: [
            memory("weak", {
                pinned: true,
                confidence: 0.5,
                conflictKey: "preference:theme",
            }),
            memory("strong", {
                pinned: true,
                confidence: 1,
                conflictKey: "preference:theme",
            }),
        ],
        query: "theme",
        now: NOW,
    });
    assert.deepEqual(idsOf(selection), ["strong"], "the better-scored one wins");
    assert.equal(selection.omitted.duplicate, 1);
});

test("one source conversation cannot supply the whole context", () => {
    const memories = Array.from({ length: 6 }, (_, index) =>
        memory(`m-${index}`, {
            pinned: true,
            sourceIds: ["conversation-1"],
            statement: `사용자는 주제 ${index} 에 관심이 있다`,
        })
    );
    const selection = selectMemoryContext({
        memories,
        query: "주제",
        now: NOW,
    });
    assert.equal(selection.selected.length, MEMORY_CONTEXT_DEFAULTS.maxPerSource);
    assert.equal(
        selection.omitted.source_cap,
        6 - MEMORY_CONTEXT_DEFAULTS.maxPerSource
    );
});

test("user-authored memories have no source and are never source-capped", () => {
    const memories = Array.from({ length: 6 }, (_, index) =>
        memory(`m-${index}`, { pinned: true, sourceIds: [] })
    );
    const selection = selectMemoryContext({ memories, query: "x", now: NOW });
    assert.equal(selection.selected.length, 6);
    assert.equal(selection.omitted.source_cap, 0);
});

test("the token budget is a hard cap, and items are never truncated", () => {
    const long = "가".repeat(300);
    const memories = Array.from({ length: 10 }, (_, index) =>
        memory(`m-${index}`, { pinned: true, statement: `${index}${long}` })
    );
    const selection = selectMemoryContext({
        memories,
        query: "x",
        now: NOW,
        budget: { maxTokens: 400 },
    });
    assert.ok(selection.tokens <= 400, `${selection.tokens} exceeded the cap`);
    assert.ok(selection.omitted.token_budget > 0);
    for (const row of selection.selected) {
        assert.equal(
            row.tokens,
            estimateMemoryTokens(row.memory.statement),
            "a selected memory is booked whole"
        );
    }
});

test("style cannot spend the factual budget", () => {
    const styleMemories = Array.from({ length: 12 }, (_, index) =>
        memory(`s-${index}`, {
            kind: "tone",
            statement: `사용자는 어조 ${index} 를 선호한다`,
        })
    );
    const selection = selectMemoryContext({
        memories: styleMemories,
        query: "어조",
        now: NOW,
    });
    const styleTokens = selection.selected.reduce(
        (total, row) => total + row.tokens,
        0
    );
    assert.ok(
        selection.selected.length <= MEMORY_CONTEXT_DEFAULTS.maxStyleItems,
        "style item cap"
    );
    assert.ok(
        styleTokens <= MEMORY_CONTEXT_DEFAULTS.maxStyleTokens,
        "style token cap"
    );
});

test("facts take the shared budget before style does", () => {
    // The failure this guards: a chatty style set arriving first in the input
    // and leaving no room for the facts the request actually needs. Style may
    // use what is left over — a tone preference applies to every answer, so it
    // is not relevance-gated — but only what is left.
    const memories = [
        ...Array.from({ length: 8 }, (_, index) =>
            memory(`s-${index}`, { kind: "tone", statement: `어조 ${index}` })
        ),
        memory("fact", { kind: "identity", statement: "사용자는 서울에 산다" }),
    ];
    const tight = selectMemoryContext({
        memories,
        query: "서울",
        now: NOW,
        budget: { maxTokens: 20 },
    });
    assert.deepEqual(idsOf(tight), ["fact"], "the fact is placed first");

    const roomy = selectMemoryContext({ memories, query: "서울", now: NOW });
    assert.equal(idsOf(roomy)[0], "fact");
    assert.ok(idsOf(roomy).length > 1, "style fills the remaining room");
});

/* ----------------------------------------------------------- determinism  */

test("input order does not change the selection", () => {
    const memories = [
        memory("a", { pinned: true }),
        memory("b", { pinned: true }),
        memory("c", { pinned: true }),
    ];
    const forward = selectMemoryContext({ memories, query: "x", now: NOW });
    const reversed = selectMemoryContext({
        memories: [...memories].reverse(),
        query: "x",
        now: NOW,
    });
    assert.deepEqual(idsOf(forward), idsOf(reversed));
    assert.equal(forward.signature, reversed.signature);
});

test("equal scores break on id, not on arrival", () => {
    const tied = [memory("z", { pinned: true }), memory("a", { pinned: true })];
    const selection = selectMemoryContext({ memories: tied, query: "x", now: NOW });
    assert.deepEqual(idsOf(selection), ["a", "z"]);
});

test("the signature names the algorithm and carries no statement text", () => {
    const selection = selectMemoryContext({
        memories: [memory("m-1", { pinned: true, statement: "비밀스러운 문장" })],
        query: "x",
        now: NOW,
    });
    assert.ok(
        selection.signature.startsWith(`v${MEMORY_RETRIEVAL_ALGORITHM_VERSION} `)
    );
    assert.ok(selection.signature.includes("m-1"));
    assert.ok(
        !selection.signature.includes("비밀"),
        "a bundle binding must not carry memory content"
    );
});

test("a changed selection changes the signature", () => {
    const base = [memory("a", { pinned: true }), memory("b", { pinned: true })];
    const before = selectMemoryContext({ memories: base, query: "x", now: NOW });
    const after = selectMemoryContext({
        memories: [base[0]],
        query: "x",
        now: NOW,
    });
    assert.notEqual(before.signature, after.signature);
});

/* -------------------------------------------------------------- scoring   */

test("recency decays by half-life and never goes negative", () => {
    const fresh = scoreMemory(
        memory("fresh", { effectiveAt: NOW }),
        ["x"],
        NOW
    );
    const old = scoreMemory(
        memory("old", { effectiveAt: new Date("2020-01-01T00:00:00.000Z") }),
        ["x"],
        NOW
    );
    assert.ok(fresh.score > old.score);
    assert.ok(old.score >= 0);
});

test("a memory dated in the future is not scored above a fresh one", () => {
    // Clock skew must not create a memory that is more recent than "now".
    const future = scoreMemory(
        memory("future", { effectiveAt: new Date("2030-01-01T00:00:00.000Z") }),
        ["x"],
        NOW
    );
    const fresh = scoreMemory(memory("fresh", { effectiveAt: NOW }), ["x"], NOW);
    assert.equal(future.score, fresh.score);
});

test("relevance outweighs a confidence difference", () => {
    const relevant = scoreMemory(
        memory("relevant", { confidence: 0.6, statement: "커피를 좋아한다" }),
        memoryRetrievalTerms("커피"),
        NOW
    );
    const confident = scoreMemory(
        memory("confident", { confidence: 1, statement: "등산을 좋아한다" }),
        memoryRetrievalTerms("커피"),
        NOW
    );
    assert.ok(relevant.score > confident.score);
});

test("an empty memory set selects nothing without throwing", () => {
    const selection = selectMemoryContext({ memories: [], query: "x", now: NOW });
    assert.deepEqual(selection.selected, []);
    assert.equal(selection.tokens, 0);
});
