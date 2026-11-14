import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryQueryPlan, MEMORY_QUERY_VERSION } from "../lib/memoryQueryPlan.ts";
import {
    MEMORY_RETRIEVAL_MAX_TERMS,
    MEMORY_RETRIEVAL_VERSION,
    memoryRetrievalTerms,
    memoryTermsAreCurrent,
} from "../lib/memoryRetrievalTerms.ts";
import { selectMemoryContext } from "../lib/memoryRetrievalScoring.ts";
import { boundRerankQuery, SEMANTIC_RETRIEVAL_LIMITS } from "../lib/semanticRetrievalCore.ts";

const padding = (count, prefix = "topic") => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, "0")}`).join(" ");
const now = new Date("2026-11-14T00:00:00Z");
const row = (id, statement) => ({
    id, statement, kind: "preference", conflictKey: null, confidence: 0.9, importance: 0,
    pinned: false, effectiveAt: now, expiresAt: null, sourceIds: [], searchTerms: memoryRetrievalTerms(statement),
});

test("short queries keep the tokenizer and semantic query behavior", () => {
    for (const query of ["Coffee in Brisbane?", "브리즈번에서 커피를 마실까요?", "東京の旅行", "", "  ", "☕🙂"]) {
        const plan = buildMemoryQueryPlan(query);
        assert.equal(plan.version, MEMORY_QUERY_VERSION);
        assert.deepEqual(plan.terms, memoryRetrievalTerms(query));
        assert.equal(plan.semanticQuery, boundRerankQuery(query));
    }
});

test("query budgeting does not change stored terms, the default 64-term index cap or its version", () => {
    const query = padding(150);
    const expectedIndex = Array.from({ length: 64 }, (_, index) => `topic${String(index).padStart(3, "0")}`);
    const before = memoryRetrievalTerms(query);
    assert.deepEqual(before, expectedIndex);
    assert.equal(MEMORY_RETRIEVAL_VERSION, 1, "the storage index shape is unchanged and needs no reindex");
    const plan = buildMemoryQueryPlan(query);
    assert.equal(plan.terms.length, MEMORY_RETRIEVAL_MAX_TERMS);
    assert.ok(plan.terms.includes("topic149"));
    assert.deepEqual(memoryRetrievalTerms(query), before);
    assert.equal(memoryTermsAreCurrent({ statement: query, searchTerms: before, retrievalVersion: MEMORY_RETRIEVAL_VERSION }), true);
});

for (const [language, head, tail, headTerm, tailTerm] of [
    ["English", "departure morning", "return November", "departure", "november"],
    ["Korean", "출발시각은 오전입니다", "귀국날짜는 십일월입니다", "출발", "귀국"],
]) {
    test(`${language}: long questions retain both ends within 64 terms and 400 bytes`, () => {
        const query = `${head} ${padding(180)} ${tail}`;
        const plan = buildMemoryQueryPlan(query);
        assert.equal(plan.terms.length, 64);
        assert.equal(new Set(plan.terms).size, plan.terms.length);
        assert.ok(plan.terms.includes(headTerm));
        assert.ok(plan.terms.includes(tailTerm));
        assert.ok(plan.semanticQuery.startsWith(head));
        assert.ok(plan.semanticQuery.endsWith(tail));
        assert.ok(Buffer.byteLength(plan.semanticQuery, "utf8") <= SEMANTIC_RETRIEVAL_LIMITS.rerankMaxQueryBytes);
        assert.deepEqual(buildMemoryQueryPlan(query), plan, "same raw input produces the same plan");

        const memories = [row("head", head), row("tail", tail)];
        const raw = selectMemoryContext({ memories, query, now });
        const prepared = selectMemoryContext({ memories, query: plan.terms, now });
        assert.deepEqual(raw, prepared, "the pure scorer and DB query use the same term plan");
        assert.deepEqual(new Set(raw.selected.map(candidate => candidate.memory.id)), new Set(["head", "tail"]));
    });
}

test("long-query normalization is NFC and never splits a Unicode code point", () => {
    const decomposed = `e\u0301\u1100\u1161🙂${"🚀e\u0301한글".repeat(130)}끝🙂`;
    const normalized = decomposed.normalize("NFC");
    const plan = buildMemoryQueryPlan(decomposed);
    assert.deepEqual(plan, buildMemoryQueryPlan(normalized));
    assert.ok(plan.semanticQuery.startsWith("é가🙂"));
    assert.ok(plan.semanticQuery.endsWith("끝🙂"));
    assert.ok(Buffer.byteLength(plan.semanticQuery, "utf8") <= 400);
    assert.equal(Buffer.from(plan.semanticQuery, "utf8").toString("utf8"), plan.semanticQuery);
    for (const point of plan.semanticQuery) {
        const code = point.codePointAt(0);
        assert.ok(code < 0xD800 || code > 0xDFFF, "no lone surrogate");
    }
});

test("exactly 400 bytes keeps the whole normalized semantic query", () => {
    for (const query of ["x".repeat(400), `${"한".repeat(132)}🙂`]) {
        assert.equal(Buffer.byteLength(query, "utf8"), 400);
        assert.equal(buildMemoryQueryPlan(query).semanticQuery, query);
    }
});

test("middle-only evidence remains an observed limitation of bounded head-tail selection", () => {
    const query = `departure ${padding(100, "before")} midpointtarget ${padding(100, "after")} return`;
    const plan = buildMemoryQueryPlan(query);
    assert.equal(plan.terms.includes("midpointtarget"), false);
    assert.equal(plan.semanticQuery.includes("midpointtarget"), false);
    const selected = selectMemoryContext({ memories: [row("middle", "midpointtarget")], query, now });
    assert.equal(selected.selected.length, 0, "this fixture observes input loss; it is not a semantic accuracy pass");
});

test("Memory head-tail budgeting does not alter the shared knowledge prefix bound", () => {
    const query = `begin ${padding(120)} terminalcondition`;
    const knowledge = boundRerankQuery(query);
    const memory = buildMemoryQueryPlan(query).semanticQuery;
    assert.equal(knowledge, query.slice(0, 400));
    assert.equal(knowledge.includes("terminalcondition"), false);
    assert.ok(memory.endsWith("terminalcondition"));
    assert.notEqual(memory, knowledge);
});
