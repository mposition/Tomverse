// The succ-4 review's arithmetic, pinned.
//
// `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12. These are the
// numbers a later reader will cite without recomputing them, and every one of
// them is a claim about which cases may still measure the rules they were read
// against.

import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { MEMORY_EVAL_REGRESSION_PROVENANCE } from "../lib/memoryEvalRegressionCorpus/provenance.ts";
import {
    SUCC4_B_PLUS_MOVES,
    SUCC4_REVIEWED_AND_KEPT,
} from "../lib/memoryEvalSucc4Review/bPlusMoves.ts";
import {
    SUCC4_NEGATED,
    SUCC4_READINGS,
} from "../lib/memoryEvalSucc4Review/readings.ts";

const succ3ById = new Map(MEMORY_EVAL_SUCC3_CASES.map((c) => [c.id, c]));

test("every case named by the review is a succ-3 case", () => {
    // A move list naming a case the dataset does not hold moves nothing, and
    // reads as though it had.
    for (const move of SUCC4_B_PLUS_MOVES) {
        assert.ok(succ3ById.has(move.originalId), `unknown case ${move.originalId}`);
        const testCase = succ3ById.get(move.originalId);
        assert.equal(
            `${testCase.category}:${testCase.language}`,
            move.cell,
            `${move.originalId} cell`
        );
    }
    for (const id of SUCC4_REVIEWED_AND_KEPT) {
        assert.ok(succ3ById.has(id), `unknown case ${id}`);
    }
});

test("the move set and the kept set are disjoint, and both are unique", () => {
    const moving = SUCC4_B_PLUS_MOVES.map((move) => move.originalId);
    assert.equal(new Set(moving).size, moving.length, "a case moves once");
    assert.equal(
        new Set(SUCC4_REVIEWED_AND_KEPT).size,
        SUCC4_REVIEWED_AND_KEPT.length
    );
    for (const id of SUCC4_REVIEWED_AND_KEPT) {
        assert.ok(!moving.includes(id), `${id} is in both lists`);
    }
});

test("99 move, 13 stay, and together they are the reviewed cases", () => {
    assert.equal(SUCC4_B_PLUS_MOVES.length, 99);
    assert.equal(SUCC4_REVIEWED_AND_KEPT.length, 13);
    // 121 golds, 112 distinct cases: `succ-assistant-en-304` carries two of
    // the reviewed golds, and several durable_facts cases carry two.
    const reviewedCases = new Set([
        ...SUCC4_B_PLUS_MOVES.map((move) => move.originalId),
        ...SUCC4_REVIEWED_AND_KEPT,
    ]);
    assert.equal(reviewedCases.size, 112);
});

test("the union with the existing corpus is 198, not 99 + 99", () => {
    // The first 99 left succ-2, so they are not in succ-3 and cannot be in
    // this set. The union has no overlap -- which is what makes 198 right and
    // a sum wrong in general.
    const existing = MEMORY_EVAL_REGRESSION_PROVENANCE.map((p) => p.originalId);
    assert.equal(existing.length, 99);
    const moving = SUCC4_B_PLUS_MOVES.map((move) => move.originalId);
    for (const id of moving) {
        assert.ok(!existing.includes(id), `${id} is already in the corpus`);
        assert.ok(
            !succ3ById.has(id) === false,
            "a moving case must still be in succ-3 at this point"
        );
    }
    assert.equal(new Set([...existing, ...moving]).size, 198);
});

test("a seat can be replaced twice, and the record says so", () => {
    // succ-durable-ko-301 is in batch-162, written to replace one of the first
    // 99. It now leaves too. That is a fact about this corpus rather than a
    // miscount, and it is why the union is over ids and not over seats.
    const replacements = new Set(
        MEMORY_EVAL_REGRESSION_PROVENANCE.map((p) => p.replacementId).filter(Boolean)
    );
    const twiceReplaced = SUCC4_B_PLUS_MOVES.filter((move) =>
        replacements.has(move.originalId)
    );
    assert.ok(
        twiceReplaced.length > 0,
        "expected at least one case that was itself a replacement"
    );
    assert.ok(twiceReplaced.some((move) => move.originalId === "succ-durable-ko-301"));
});

test("cell counts match what succ-4 has to replace", () => {
    const counts = {};
    for (const move of SUCC4_B_PLUS_MOVES) {
        counts[move.cell] = (counts[move.cell] ?? 0) + 1;
    }
    assert.deepEqual(counts, {
        "durable_facts:en": 53,
        "durable_facts:ko": 32,
        "assistant_only:ko": 7,
        "assistant_only:en": 5,
        "injection_directives:en": 2,
    });
});

test("every gold the review rewrote belongs to a case that moves", () => {
    // §12.2: a gold whose match target or anchor changed does not stay in the
    // decision set, whether or not it formed a rule.
    const moving = new Set(SUCC4_B_PLUS_MOVES.map((move) => move.originalId));
    for (const reading of SUCC4_READINGS) {
        const rewritten =
            reading.factValueAll ||
            reading.factValueAny ||
            reading.evidenceMessageId ||
            reading.evidenceQuote;
        if (!rewritten) continue;
        assert.ok(
            moving.has(reading.caseId),
            `${reading.caseId} was rewritten and does not move`
        );
    }
});

test("the readings name real golds", () => {
    for (const key of [...SUCC4_NEGATED, ...SUCC4_READINGS.map((r) => `${r.caseId}:${r.goldId}`)]) {
        const [caseId, goldId] = key.split(":");
        const testCase = succ3ById.get(caseId);
        assert.ok(testCase, `unknown case ${caseId}`);
        assert.ok(
            testCase.expected.some((gold) => gold.id === goldId),
            `${caseId} has no gold ${goldId}`
        );
    }
});
