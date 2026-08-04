import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_MEMORY_CONTEXT_BUDGET,
    MEMORY_RETRIEVAL_VERSION,
    MEMORY_SEARCH_TERM_LIMIT,
    isStyleMemoryKind,
    memoryContextTokens,
    memorySearchTerms,
    retrievalResultMaterial,
    scoreMemory,
    selectMemoryContext,
    tokenizeMemoryText,
} from "../lib/memoryRetrievalCore.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §9.
 *
 * Retrieval v1 is lexical and deterministic on purpose, so it can be pinned
 * exactly: same store, same request, same selection. These tests pin both the
 * tokenizer's two writing-system behaviours and the budget's reduction order.
 */

const NOW = new Date("2026-08-04T00:00:00.000Z");

const memory = (overrides = {}) => ({
    id: overrides.id ?? "mem-1",
    kind: overrides.kind ?? "preference",
    statement: overrides.statement ?? "The user prefers short answers",
    searchTerms:
        overrides.searchTerms ??
        memorySearchTerms({
            kind: overrides.kind ?? "preference",
            statement: overrides.statement ?? "The user prefers short answers",
        }),
    confidence: overrides.confidence ?? 0.9,
    importance: overrides.importance ?? 0,
    pinned: overrides.pinned ?? false,
    updatedAt: overrides.updatedAt ?? NOW,
    sourceKeys: overrides.sourceKeys ?? ["conv-1"],
});

const score = (item, query) =>
    scoreMemory(item, new Set(tokenizeMemoryText(query)), NOW);

// --- tokenizer ---

test("Latin text is tokenized by word, dropping single characters", () => {
    const terms = tokenizeMemoryText("The user prefers a short answer");
    assert.ok(terms.includes("prefers"));
    assert.ok(terms.includes("short"));
    // "a" discriminates nothing and would match almost every request.
    assert.ok(!terms.includes("a"));
});

test("case and Unicode form never decide a match", () => {
    assert.deepEqual(
        tokenizeMemoryText("Postgres MIGRATION"),
        tokenizeMemoryText("postgres migration")
    );
    // NFD Hangul must produce the same terms as NFC.
    assert.deepEqual(
        tokenizeMemoryText("한국어"),
        tokenizeMemoryText("한국어".normalize("NFD"))
    );
});

test("Hangul is indexed as bigrams, so spacing does not split a phrase", () => {
    const spaced = tokenizeMemoryText("코드 리뷰");
    const joined = tokenizeMemoryText("코드리뷰");
    // Korean does not put spaces inside a noun phrase consistently; whole-token
    // matching would make these two unrelated.
    assert.ok(spaced.some((term) => joined.includes(term)));
    assert.ok(joined.includes("코드"));
    assert.ok(joined.includes("드리"));
    assert.ok(joined.includes("리뷰"));
});

test("a single CJK character is kept as its own term", () => {
    assert.deepEqual(tokenizeMemoryText("음"), ["음"]);
});

test("a mixed-script token is split into per-script runs", () => {
    const terms = tokenizeMemoryText("gpt5모델");
    assert.ok(terms.includes("gpt5"));
    assert.ok(terms.includes("모델"));
});

test("terms are deduplicated and bounded", () => {
    const terms = tokenizeMemoryText("repeat repeat repeat");
    assert.deepEqual(terms, ["repeat"]);
    const long = tokenizeMemoryText(
        Array.from({ length: 400 }, (_, index) => `token${index}`).join(" ")
    );
    assert.ok(long.length <= MEMORY_SEARCH_TERM_LIMIT);
});

test("the kind is indexed alongside the statement", () => {
    const terms = memorySearchTerms({
        kind: "citation_preference",
        statement: "The user wants sources inline",
    });
    assert.ok(terms.includes("citation"));
    assert.ok(terms.includes("preference"));
    assert.ok(terms.includes("inline"));
});

// --- scoring ---

test("coverage of the request dominates the score", () => {
    const relevant = memory({
        id: "a",
        statement: "The user prefers Postgres migrations reviewed carefully",
    });
    const unrelated = memory({
        id: "b",
        statement: "The user enjoys hiking on weekends",
        confidence: 1,
        importance: 10,
    });
    const query = "how should I review this postgres migration";
    assert.ok(score(relevant, query).score > score(unrelated, query).score);
});

test("an older memory scores below an identical newer one", () => {
    const query = "short answers";
    const fresh = score(memory({ id: "a" }), query);
    const stale = score(
        memory({ id: "b", updatedAt: new Date("2025-01-01T00:00:00.000Z") }),
        query
    );
    assert.ok(fresh.score > stale.score);
});

test("coverage is a fraction of the request, never above 1", () => {
    const entry = score(memory(), "short");
    assert.ok(entry.coverage <= 1);
    assert.ok(entry.matchedTerms > 0);
});

test("a request with no terms leaves coverage at zero", () => {
    assert.equal(score(memory(), "!!!").coverage, 0);
});

// --- selection and budget ---

test("a memory sharing no term with the request is not carried", () => {
    const selection = selectMemoryContext([
        score(memory({ statement: "The user enjoys hiking" }), "postgres index"),
    ]);
    assert.equal(selection.factual.length, 0);
    assert.equal(selection.dropped.belowRelevance, 1);
});

test("a pinned memory is carried even when nothing matches (§9)", () => {
    const selection = selectMemoryContext([
        score(
            memory({ statement: "The user enjoys hiking", pinned: true }),
            "postgres index"
        ),
    ]);
    assert.equal(selection.factual.length, 1);
});

test("pinned memories come before higher-scoring unpinned ones", () => {
    const query = "short answers";
    const selection = selectMemoryContext([
        score(memory({ id: "unpinned" }), query),
        score(
            memory({
                id: "pinned",
                statement: "The user prefers answers",
                pinned: true,
                confidence: 0.1,
            }),
            query
        ),
    ]);
    assert.equal(selection.factual[0].memory.id, "pinned");
});

test("facts are carried before style, so a tight budget loses style first", () => {
    const query = "short answers in korean";
    const factual = memory({
        id: "fact",
        kind: "occupation",
        statement: "The user writes answers professionally",
    });
    const style = memory({
        id: "style",
        kind: "verbosity",
        statement: "The user prefers short answers",
    });
    assert.ok(isStyleMemoryKind("verbosity"));
    const budget = {
        ...DEFAULT_MEMORY_CONTEXT_BUDGET,
        maxTokens: memoryContextTokens(factual),
    };
    const selection = selectMemoryContext(
        [score(style, query), score(factual, query)],
        budget
    );
    assert.deepEqual(
        selection.factual.map((entry) => entry.memory.id),
        ["fact"]
    );
    assert.equal(selection.style.length, 0);
    assert.equal(selection.dropped.tokenBudget, 1);
});

test("the token cap is a hard ceiling, never rounded up to fit one more", () => {
    const query = "short answers";
    const items = Array.from({ length: 10 }, (_, index) =>
        score(
            memory({
                id: `m${index}`,
                statement: `The user prefers short answers about topic ${index}`,
                sourceKeys: [`conv-${index}`],
            }),
            query
        )
    );
    const budget = { ...DEFAULT_MEMORY_CONTEXT_BUDGET, maxTokens: 40 };
    const selection = selectMemoryContext(items, budget);
    assert.ok(selection.estimatedTokens <= 40);
    assert.ok(selection.factual.length < items.length);
    assert.ok(selection.dropped.tokenBudget > 0);
});

test("one imported conversation cannot fill the budget alone (§9)", () => {
    const query = "short answers";
    const items = Array.from({ length: 6 }, (_, index) =>
        score(
            memory({
                id: `m${index}`,
                statement: `The user prefers short answers variant ${index}`,
                sourceKeys: ["conv-shared"],
            }),
            query
        )
    );
    const selection = selectMemoryContext(items, {
        ...DEFAULT_MEMORY_CONTEXT_BUDGET,
        maxPerSource: 2,
    });
    assert.equal(selection.factual.length, 2);
    assert.equal(selection.dropped.sourceLimit, 4);
});

test("two memories asserting the same thing are carried once", () => {
    const query = "short answers";
    const first = memory({ id: "a", sourceKeys: ["conv-a"] });
    const second = memory({ id: "b", sourceKeys: ["conv-b"] });
    const selection = selectMemoryContext([
        score(first, query),
        score(second, query),
    ]);
    assert.equal(selection.factual.length, 1);
    assert.equal(selection.dropped.duplicate, 1);
});

test("the item cap applies before the token cap has to", () => {
    const query = "short answers";
    const items = Array.from({ length: 5 }, (_, index) =>
        score(
            memory({
                id: `m${index}`,
                statement: `The user prefers short answers case ${index}`,
                sourceKeys: [`conv-${index}`],
            }),
            query
        )
    );
    const selection = selectMemoryContext(items, {
        ...DEFAULT_MEMORY_CONTEXT_BUDGET,
        maxItems: 2,
    });
    assert.equal(selection.factual.length, 2);
    assert.equal(selection.dropped.itemLimit, 3);
});

// --- reproducibility, which the §10 bundle hash depends on ---

test("the same input always selects the same memories in the same order", () => {
    const query = "short answers";
    const items = [
        score(memory({ id: "b", sourceKeys: ["conv-b"] }), query),
        score(
            memory({
                id: "a",
                statement: "The user prefers short replies",
                sourceKeys: ["conv-a"],
            }),
            query
        ),
    ];
    const first = retrievalResultMaterial(selectMemoryContext(items));
    const second = retrievalResultMaterial(
        selectMemoryContext([...items].reverse())
    );
    assert.equal(first, second);
    assert.ok(first.startsWith(`v${MEMORY_RETRIEVAL_VERSION}`));
});

test("the retrieval material changes when the selection changes", () => {
    const query = "short answers";
    const one = retrievalResultMaterial(
        selectMemoryContext([score(memory({ id: "a" }), query)])
    );
    const two = retrievalResultMaterial(
        selectMemoryContext([score(memory({ id: "z" }), query)])
    );
    assert.notEqual(one, two);
});
