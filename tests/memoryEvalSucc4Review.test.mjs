// The succ-4 review's arithmetic, pinned.
//
// `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12. These are the
// numbers a later reader will cite without recomputing them, and every one of
// them is a claim about which cases may still measure the rules they were read
// against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { MEMORY_EVAL_REGRESSION_PROVENANCE } from "../lib/memoryEvalRegressionCorpus/provenance.ts";
import {
    SUCC4_B_PLUS_MOVES,
    SUCC4_REVIEWED_AND_KEPT,
} from "../lib/memoryEvalSucc4Review/bPlusMoves.ts";
import { SUCC4_BATCHES } from "../lib/memoryEvalSucc4Review/batches.ts";
import {
    SUCC4_AFFIRMED,
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

test("polarity has no default: both lists are written out", () => {
    // §12 condition 6. A fallback to `affirmed` would make a gold nobody read
    // indistinguishable from one a person read and called affirmed, and every
    // gold on the affirmed list got there through the absence of a negation
    // marker -- a routing signal that decides nothing.
    assert.equal(SUCC4_AFFIRMED.length, 74);
    assert.equal(SUCC4_NEGATED.length, 47);
    assert.equal(SUCC4_AFFIRMED.length + SUCC4_NEGATED.length, 121);

    const both = SUCC4_AFFIRMED.filter((key) => SUCC4_NEGATED.includes(key));
    assert.deepEqual(both, [], "a gold cannot be both");
    assert.equal(new Set(SUCC4_AFFIRMED).size, SUCC4_AFFIRMED.length);
    assert.equal(new Set(SUCC4_NEGATED).size, SUCC4_NEGATED.length);
});

test("no assignment rests on the marker scan alone", () => {
    // The scan is a closed list of four Korean and five English markers, and
    // negation is not. `lack`, `avoid`, `exclude`, `싫다`, `피하다`, `제외하다`
    // negate without appearing in it. This test cannot check a reading; what
    // it can check is that the lists are data a person wrote rather than a
    // predicate a scan computes, which is why both are enumerated.
    const source = readFileSync(
        new URL("../lib/memoryEvalSucc4Review/readings.ts", import.meta.url),
        "utf8"
    );
    // Prose may name the scan -- the record explains why it did not decide
    // anything. What it may not do is import it.
    const imports = source
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"));
    for (const derived of ["POLARITY_MARKERS", "polarityGap", "polarityMatches"]) {
        assert.ok(
            !imports.some((line) => line.includes(derived)),
            `${derived} must not decide a polarity in the reading record`
        );
    }
    assert.ok(!source.includes("memoryEvalPolarityCalibration"));
});

test("every rewritten gold names why, and every reading names a polarity", () => {
    for (const reading of SUCC4_READINGS) {
        assert.ok(
            reading.polarity === "affirmed" || reading.polarity === "negated",
            `${reading.caseId}:${reading.goldId} has no polarity`
        );
        const rewritten =
            reading.factValueAll || reading.factValueAny || reading.evidenceQuote;
        if (rewritten) {
            assert.ok(reading.note, `${reading.caseId} was rewritten with no reason`);
        }
    }
});

test("batch keys are generated, and cover their slice exactly", () => {
    // An identifier is not a judgement. Two earlier slips were a hand-copied
    // gold id, so both sides of this comparison are built from the fixtures.
    const read = new Set([...SUCC4_AFFIRMED, ...SUCC4_NEGATED]);
    for (const batch of SUCC4_BATCHES) {
        const [category, language] = batch.cell.split(":");
        const slice = MEMORY_EVAL_SUCC3_CASES.filter(
            (testCase) =>
                testCase.category === category && testCase.language === language
        )
            .flatMap((testCase) =>
                testCase.expected.map((gold) => `${testCase.id}:${gold.id}`)
            )
            .filter((key) => !read.has(key))
            .sort();
        const expected = slice.slice(batch.from, batch.from + batch.golds.length);
        const keys = batch.golds.map((gold) => gold.key);
        assert.deepEqual(keys, expected, `${batch.id} does not cover its slice`);
        assert.equal(new Set(keys).size, keys.length, `${batch.id} has a duplicate`);
        for (const gold of batch.golds) {
            assert.ok(
                gold.polarity === "affirmed" || gold.polarity === "negated",
                `${gold.key} has no polarity`
            );
        }
    }
});

test("batches do not re-label a gold the 121 already settled", () => {
    const read = new Set([...SUCC4_AFFIRMED, ...SUCC4_NEGATED]);
    const seen = new Set();
    for (const batch of SUCC4_BATCHES) {
        for (const gold of batch.golds) {
            assert.ok(!read.has(gold.key), `${gold.key} was already settled`);
            assert.ok(!seen.has(gold.key), `${gold.key} appears in two batches`);
            seen.add(gold.key);
        }
    }
});
