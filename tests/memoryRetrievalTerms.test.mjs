import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_RETRIEVAL_MAX_TERMS,
    MEMORY_RETRIEVAL_VERSION,
    memoryRetrievalTerms,
    memoryTermsAreCurrent,
} from "../lib/memoryRetrievalTerms.ts";

/**
 * Retrieval v1 tokenizer (§9).
 *
 * The property that matters most is not any single token list — it is that
 * indexing and querying agree. A test that only checked "커피 produces 커피"
 * would pass while retrieval returned nothing, so the assertions below are
 * mostly about a query term appearing in the terms of a statement that should
 * match it.
 */

/* ----------------------------------------------------------------- latin -- */

test("Latin text tokenizes into lowercase words", () => {
    assert.deepEqual(memoryRetrievalTerms("Prefers concise answers"), [
        "prefers",
        "concise",
        "answers",
    ]);
});

test("case folding is invariant, not locale-sensitive", () => {
    // The Turkish trap: a locale fold would map this "I" to "ı" on a tr-TR
    // server and to "i" everywhere else, so the same row would index two ways.
    assert.deepEqual(memoryRetrievalTerms("INDEX"), ["index"]);
    assert.deepEqual(
        memoryRetrievalTerms("index"),
        memoryRetrievalTerms("INDEX")
    );
});

test("one-letter words are dropped but numbers of any length are kept", () => {
    const terms = memoryRetrievalTerms("a GPT-5 user in 2026");
    assert.ok(!terms.includes("a"), "a single letter is noise");
    assert.ok(terms.includes("5"), "a version number is the distinguishing part");
    assert.ok(terms.includes("2026"));
    assert.ok(terms.includes("gpt"));
});

test("punctuation is a boundary, not a character", () => {
    assert.deepEqual(memoryRetrievalTerms("react-router, v7!"), [
        "react",
        "router",
        "v7",
    ]);
});

test("accents survive normalization rather than being stripped", () => {
    // Composed and decomposed forms must land on the same token, or a French
    // statement indexes differently depending on how it was typed.
    assert.deepEqual(
        memoryRetrievalTerms("café"),
        memoryRetrievalTerms("café")
    );
});

/* ------------------------------------------------------------------- cjk -- */

test("Korean is indexed as bigrams", () => {
    assert.deepEqual(memoryRetrievalTerms("한국어"), ["한국", "국어"]);
});

test("a Korean particle does not hide the word", () => {
    // The whole point of bigrams: "커피를" and a query for "커피" must meet.
    const stored = memoryRetrievalTerms("사용자는 커피를 좋아한다");
    const query = memoryRetrievalTerms("커피");
    assert.ok(
        query.every((term) => stored.includes(term)),
        `query ${query.join(",")} not covered by ${stored.join(",")}`
    );
});

test("Chinese and Japanese runs are bigrammed too", () => {
    assert.deepEqual(memoryRetrievalTerms("中文文档"), ["中文", "文文", "文档"]);
    assert.ok(memoryRetrievalTerms("東京に住む").includes("東京"));
});

test("a single CJK character is kept as itself", () => {
    assert.deepEqual(memoryRetrievalTerms("茶"), ["茶"]);
});

test("a script change ends a run", () => {
    // "GPT" and "모델" must not be glued into one nonsense token.
    const terms = memoryRetrievalTerms("GPT모델");
    assert.ok(terms.includes("gpt"));
    assert.ok(terms.includes("모델"));
    assert.ok(!terms.some((term) => term.includes("t모")));
});

test("Cyrillic is treated as word-delimited, not bigrammed", () => {
    assert.deepEqual(memoryRetrievalTerms("привет мир"), ["привет", "мир"]);
});

/* ------------------------------------------------------------ determinism -- */

test("terms are deduped in first-seen order", () => {
    assert.deepEqual(memoryRetrievalTerms("tea tea coffee tea"), [
        "tea",
        "coffee",
    ]);
});

test("the same input always produces the same array", () => {
    const text = "사용자는 간결한 답변과 concise English 를 선호한다";
    assert.deepEqual(memoryRetrievalTerms(text), memoryRetrievalTerms(text));
});

test("truncation keeps the first N in emission order", () => {
    const text = Array.from({ length: 200 }, (_, index) => `word${index}`).join(
        " "
    );
    const terms = memoryRetrievalTerms(text);
    assert.equal(terms.length, MEMORY_RETRIEVAL_MAX_TERMS);
    assert.equal(terms[0], "word0");
    assert.deepEqual(
        terms,
        memoryRetrievalTerms(text, { maxTerms: MEMORY_RETRIEVAL_MAX_TERMS })
    );
});

test("an absurdly long token is dropped rather than stored", () => {
    const terms = memoryRetrievalTerms(`ok ${"x".repeat(200)}`);
    assert.deepEqual(terms, ["ok"]);
});

test("empty and punctuation-only text produce no terms", () => {
    assert.deepEqual(memoryRetrievalTerms(""), []);
    assert.deepEqual(memoryRetrievalTerms("   —  !!  "), []);
});

/* --------------------------------------------------------------- currency -- */

test("a row tokenized by the current algorithm reads as current", () => {
    const statement = "사용자는 간결한 답변을 선호한다";
    assert.equal(
        memoryTermsAreCurrent({
            statement,
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        }),
        true
    );
});

test("an older retrieval version is never current, even with matching terms", () => {
    const statement = "prefers concise answers";
    assert.equal(
        memoryTermsAreCurrent({
            statement,
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: MEMORY_RETRIEVAL_VERSION - 1,
        }),
        false
    );
});

test("an empty index on a non-empty statement is not current", () => {
    // The state every pre-B4 row is in: the backfill must see it as work.
    assert.equal(
        memoryTermsAreCurrent({
            statement: "prefers concise answers",
            searchTerms: [],
            retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        }),
        false
    );
});

test("a permutation of the right terms is not current", () => {
    const statement = "prefers concise answers";
    const shuffled = [...memoryRetrievalTerms(statement)].reverse();
    assert.equal(
        memoryTermsAreCurrent({
            statement,
            searchTerms: shuffled,
            retrievalVersion: MEMORY_RETRIEVAL_VERSION,
        }),
        false,
        "written by something other than this tokenizer"
    );
});
