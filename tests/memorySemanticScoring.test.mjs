// Memory selection with an external relevance map (policy 9a).
//
// An outside reranker may decide which ordinary ("relevant" tier) memories are
// worth the prompt space. It must never be able to remove a core, pinned or
// style memory, and passing no map must leave the existing selection byte for
// byte as it was. The assertions below are the ones a plausible-looking change
// gets wrong: a score of 0 on a core memory dropping it, a map silently
// changing the lexical fallback, and the signature failing to say which
// algorithm produced the selection.

import assert from "node:assert/strict";
import test from "node:test";

import {
    CORE_MEMORY_KINDS,
    MEMORY_RETRIEVAL_ALGORITHM_VERSION,
    MEMORY_SEMANTIC_DEFAULTS,
    MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION,
    memoryTier,
    selectMemoryContext,
} from "../lib/memoryRetrievalScoring.ts";
import { STYLE_MEMORY_KINDS } from "../lib/memoryValidatorCore.ts";

const NOW = new Date("2026-08-04T00:00:00.000Z");

const memory = (id, overrides = {}) => ({
    id,
    kind: "preference",
    statement: `statement ${id}`,
    conflictKey: null,
    confidence: 0.9,
    importance: 0,
    pinned: false,
    // Matches nothing in QUERY unless a test says otherwise.
    searchTerms: ["tea"],
    effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: null,
    sourceIds: [],
    ...overrides,
});

const QUERY = ["coffee"];
const MATCHING = { searchTerms: ["coffee"] };

const select = (memories, extra = {}) =>
    selectMemoryContext({ memories, query: QUERY, now: NOW, ...extra });
const idsOf = (selection) => selection.selected.map((row) => row.memory.id);
const byId = (selection, id) => selection.selected.find((row) => row.memory.id === id);

/* ------------------------------------------------------- versions and defaults */

test("the algorithm versions are 2 for lexical and 3 for reranked", () => {
    assert.equal(MEMORY_RETRIEVAL_ALGORITHM_VERSION, 2);
    assert.equal(MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION, 3);
});

test("the semantic defaults are usable numbers", () => {
    assert.ok(MEMORY_SEMANTIC_DEFAULTS.minRerankScore > 0);
    assert.ok(MEMORY_SEMANTIC_DEFAULTS.minRerankScore < 1);
    assert.ok(MEMORY_SEMANTIC_DEFAULTS.maxRerankCandidates >= 1);
});

/* -------------------------------------------------------------- the signature */

test("without externalRelevance the signature carries the lexical version and nothing changes", () => {
    const memories = [
        memory("m1", MATCHING),
        memory("m2", { ...MATCHING, importance: 5 }),
        memory("m3"),
    ];
    const before = select(memories);
    assert.ok(before.signature.startsWith("v2 "), before.signature);
    assert.deepEqual(idsOf(before), ["m2", "m1"]);

    // Passing the key explicitly as undefined is the same as leaving it out.
    const explicit = select(memories, { externalRelevance: undefined });
    assert.deepEqual(explicit, before);
});

test("an empty selection without a map is just the lexical version", () => {
    assert.equal(select([memory("m1")]).signature, "v2");
});

test("any map, even an empty one, moves the signature to the semantic version", () => {
    const memories = [memory("m1", MATCHING)];
    const empty = select(memories, { externalRelevance: new Map() });
    assert.ok(empty.signature.startsWith("v3 "), empty.signature);

    const populated = select(memories, { externalRelevance: new Map([["m1", 0.7]]) });
    assert.ok(populated.signature.startsWith("v3 "), populated.signature);
    assert.equal(select([], { externalRelevance: new Map() }).signature, "v3");
});

test("an empty map leaves the selection itself as the lexical one", () => {
    const memories = [
        memory("m1", MATCHING),
        memory("m2", { ...MATCHING, importance: 5 }),
        memory("m3"),
        memory("core", { kind: "identity" }),
    ];
    const lexical = select(memories);
    const withEmptyMap = select(memories, { externalRelevance: new Map() });
    assert.deepEqual(withEmptyMap.selected, lexical.selected);
    assert.equal(withEmptyMap.tokens, lexical.tokens);
    assert.deepEqual(withEmptyMap.omitted, lexical.omitted);
    assert.equal(
        withEmptyMap.signature.replace(/^v3/, "v2"),
        lexical.signature
    );
});

/* ----------------------------------------------------------- the relevant tier */

test("a memory sharing no term is selected when its external score is above the floor", () => {
    const memories = [memory("far")];
    assert.deepEqual(idsOf(select(memories)), [], "lexically it is out");

    const reranked = select(memories, { externalRelevance: new Map([["far", 0.6]]) });
    assert.deepEqual(idsOf(reranked), ["far"]);
    const row = byId(reranked, "far");
    assert.equal(row.termHits, 0);
    assert.equal(row.relevance, 0.6);
});

test("the external score replaces term overlap in the score", () => {
    const base = byId(select([memory("m", MATCHING)]), "m");
    assert.equal(base.relevance, 1);
    const lowered = byId(
        select([memory("m", MATCHING)], { externalRelevance: new Map([["m", 0.4]]) }),
        "m"
    );
    assert.equal(lowered.relevance, 0.4);
    assert.ok(Math.abs(lowered.score - (base.score - 0.45 * (1 - 0.4))) < 1e-12);
});

test("the floor is inclusive and a score under it is below relevance", () => {
    const floor = MEMORY_SEMANTIC_DEFAULTS.minRerankScore;
    const memories = [memory("at"), memory("under")];
    const selection = select(memories, {
        externalRelevance: new Map([
            ["at", floor],
            ["under", floor - 0.0001],
        ]),
    });
    assert.deepEqual(idsOf(selection), ["at"]);
    assert.equal(selection.omitted.below_relevance, 1);
});

test("a low external score excludes a memory even though its terms overlap", () => {
    const memories = [memory("overlapping", MATCHING)];
    assert.deepEqual(idsOf(select(memories)), ["overlapping"], "lexically it is in");

    const reranked = select(memories, { externalRelevance: new Map([["overlapping", 0.02]]) });
    assert.deepEqual(idsOf(reranked), []);
    assert.equal(reranked.omitted.below_relevance, 1);
});

test("a memory missing from the map is judged by the lexical rule", () => {
    const memories = [
        memory("overlapping", MATCHING),
        memory("unrelated"),
        memory("scored"),
    ];
    const selection = select(memories, { externalRelevance: new Map([["scored", 0.5]]) });
    assert.deepEqual(new Set(idsOf(selection)), new Set(["overlapping", "scored"]));
    assert.equal(selection.omitted.below_relevance, 1);
    // The uncovered memory keeps its term-overlap relevance, untouched.
    assert.equal(byId(selection, "overlapping").relevance, 1);
});

test("ids in the map that match no memory change nothing but the version", () => {
    const memories = [memory("m1", MATCHING)];
    const lexical = select(memories);
    const withStranger = select(memories, { externalRelevance: new Map([["ghost", 0.9]]) });
    assert.deepEqual(withStranger.selected, lexical.selected);
    assert.deepEqual(withStranger.omitted, lexical.omitted);
});

test("a higher external score is selected ahead of a lower one", () => {
    // "a" would win the id tie-break, so only the score can put "b" first.
    const memories = [memory("a", { statement: "first statement" }), memory("b", { statement: "second statement" })];
    const selection = select(memories, {
        externalRelevance: new Map([
            ["a", 0.3],
            ["b", 0.9],
        ]),
    });
    assert.deepEqual(idsOf(selection), ["b", "a"]);
    const gap = byId(selection, "b").score - byId(selection, "a").score;
    assert.ok(Math.abs(gap - 0.45 * (0.9 - 0.3)) < 1e-12, `gap ${gap}`);
});

test("the item cap keeps the higher-scored memory", () => {
    const memories = [memory("a", { statement: "first statement" }), memory("b", { statement: "second statement" })];
    const selection = select(memories, {
        externalRelevance: new Map([
            ["a", 0.3],
            ["b", 0.9],
        ]),
        budget: { maxItems: 1 },
    });
    assert.deepEqual(idsOf(selection), ["b"]);
    assert.equal(selection.omitted.item_cap, 1);
});

test("an expired memory stays expired whatever the reranker says", () => {
    const selection = select(
        [memory("old", { expiresAt: new Date("2026-08-03T00:00:00.000Z") })],
        { externalRelevance: new Map([["old", 1]]) }
    );
    assert.deepEqual(idsOf(selection), []);
    assert.equal(selection.omitted.expired, 1);
});

/* ------------------------------------------------- tiers a reranker cannot touch */

test("core, pinned and style memories survive a zero score in the map", () => {
    const memories = [
        memory("core", { kind: "identity" }),
        memory("pinned", { pinned: true }),
        memory("style", { kind: "tone" }),
    ];
    const zeros = new Map(memories.map((entry) => [entry.id, 0]));

    const lexical = select(memories);
    const reranked = select(memories, { externalRelevance: zeros });

    assert.deepEqual(new Set(idsOf(reranked)), new Set(["core", "pinned", "style"]));
    assert.equal(reranked.omitted.below_relevance, 0);
    for (const id of ["core", "pinned", "style"]) {
        // The map did not touch the row: same relevance, same score.
        assert.equal(byId(reranked, id).relevance, byId(lexical, id).relevance, id);
        assert.equal(byId(reranked, id).score, byId(lexical, id).score, id);
    }
});

test("a high score in the map does not raise a core memory either", () => {
    const memories = [memory("core", { kind: "occupation" })];
    const lexical = byId(select(memories), "core");
    const reranked = byId(
        select(memories, { externalRelevance: new Map([["core", 1]]) }),
        "core"
    );
    assert.equal(reranked.score, lexical.score);
    assert.equal(reranked.relevance, 0);
});

test("every core kind is exempt from the external gate", () => {
    for (const kind of CORE_MEMORY_KINDS) {
        const selection = select([memory("m", { kind })], {
            externalRelevance: new Map([["m", 0]]),
        });
        assert.deepEqual(idsOf(selection), ["m"], kind);
    }
});

/* ------------------------------------------------------------------ memoryTier */

test("a style kind is the style tier, even when pinned", () => {
    for (const kind of STYLE_MEMORY_KINDS) {
        assert.equal(memoryTier(memory("m", { kind })), "style", kind);
    }
    assert.equal(memoryTier(memory("m", { kind: "tone", pinned: true })), "style");
});

test("pinned memories and core kinds are the core tier", () => {
    assert.equal(memoryTier(memory("m", { pinned: true })), "core");
    for (const kind of CORE_MEMORY_KINDS) {
        assert.equal(memoryTier(memory("m", { kind })), "core", kind);
    }
});

test("every other memory is the relevant tier", () => {
    for (const kind of ["preference", "project", "decision", "relationship", "recurring_context"]) {
        assert.equal(memoryTier(memory("m", { kind })), "relevant", kind);
    }
});
