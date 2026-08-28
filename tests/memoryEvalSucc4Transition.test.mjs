// The transition manifest, held against the records it was made from.
//
// The manifest is the source of truth for what `succ-4` excludes, what it must
// contain, and what the supersession history says. That only holds while it
// still agrees with the reviews -- so every field is re-derived here from
// `SUCC4_B_PLUS_MOVES`, `readings.ts` and the replacement tranches, and any
// difference fails. A manifest nobody checks is a fourth copy of the contract.

import test from "node:test";
import assert from "node:assert/strict";

import {
    SUCC4_TRANSITIONS,
    SUCC4_SUPERSEDED_CASE_IDS,
    SUCC4_REPLACEMENT_CASE_IDS,
    SUCC4_SUPERSESSIONS,
    succ4TransitionFor,
    succ4TransitionCounts,
} from "../lib/memoryEvalSucc4Transition.ts";
import { SUCC4_B_PLUS_MOVES } from "../lib/memoryEvalSucc4Review/bPlusMoves.ts";
import { SUCC4_READINGS } from "../lib/memoryEvalSucc4Review/readings.ts";
import { SUCC4_TRANCHE_1 } from "../lib/memoryEvalSucc4Replacements/tranche1.ts";
import { SUCC4_TRANCHE_2 } from "../lib/memoryEvalSucc4Replacements/tranche2.ts";
import { SUCC4_TRANCHE_3 } from "../lib/memoryEvalSucc4Replacements/tranche3.ts";
import { SUCC4_TRANCHE_4 } from "../lib/memoryEvalSucc4Replacements/tranche4.ts";
import { SUCC4_TRANCHE_5 } from "../lib/memoryEvalSucc4Replacements/tranche5.ts";
import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";

const TRANCHES = [
    SUCC4_TRANCHE_1,
    SUCC4_TRANCHE_2,
    SUCC4_TRANCHE_3,
    SUCC4_TRANCHE_4,
    SUCC4_TRANCHE_5,
];
const replacements = TRANCHES.flat();
const succ3 = new Map(MEMORY_EVAL_SUCC3_CASES.map((c) => [c.id, c]));

test("one transition per move, and no move without one", () => {
    assert.deepEqual(
        SUCC4_TRANSITIONS.map((t) => t.originalId).sort(),
        SUCC4_B_PLUS_MOVES.map((m) => m.originalId).sort()
    );
});

test("103 originals and 103 replacements, all distinct", () => {
    assert.equal(SUCC4_TRANSITIONS.length, 103);
    assert.equal(SUCC4_SUPERSEDED_CASE_IDS.size, 103);
    assert.equal(SUCC4_REPLACEMENT_CASE_IDS.size, 103);
});

test("every original is a succ-3 case and every replacement is not", () => {
    for (const transition of SUCC4_TRANSITIONS) {
        assert.ok(
            succ3.has(transition.originalId),
            `${transition.originalId} is not a succ-3 case`
        );
        assert.ok(
            !succ3.has(transition.replacementId),
            `${transition.replacementId} already exists in succ-3`
        );
    }
});

test("the replacement id is the one the tranche actually wrote", () => {
    const written = new Map(
        replacements.map((r) => [r.originalId, r.replacement.id])
    );
    assert.equal(written.size, 103);
    for (const transition of SUCC4_TRANSITIONS) {
        assert.equal(
            transition.replacementId,
            written.get(transition.originalId),
            `${transition.originalId} names the wrong replacement`
        );
    }
});

test("a replacement stays in its original's cell", () => {
    const byOriginal = new Map(replacements.map((r) => [r.originalId, r]));
    for (const transition of SUCC4_TRANSITIONS) {
        const original = succ3.get(transition.originalId);
        const built = byOriginal.get(transition.originalId).replacement;
        assert.equal(built.category, original.category);
        assert.equal(built.language, original.language);
    }
});

test("`from` is the move record's own, never inferred from grounds", () => {
    const moves = new Map(SUCC4_B_PLUS_MOVES.map((m) => [m.originalId, m]));
    for (const transition of SUCC4_TRANSITIONS) {
        assert.equal(transition.from, moves.get(transition.originalId).from);
    }
});

test("grounds re-derive from the rule id and the reading records", () => {
    const moves = new Map(SUCC4_B_PLUS_MOVES.map((m) => [m.originalId, m]));
    const changed = new Set(SUCC4_READINGS.map((r) => r.caseId));
    for (const transition of SUCC4_TRANSITIONS) {
        const { ruleId } = moves.get(transition.originalId);
        const expected = [];
        if (ruleId.startsWith("contract-")) {
            expected.push("section-12.1-rule-exposure");
        }
        if (ruleId.startsWith("gold-corrected-") || changed.has(transition.originalId)) {
            expected.push("section-12.2-gold-change");
        }
        assert.deepEqual(
            [...transition.grounds].sort(),
            expected.sort(),
            `${transition.originalId} has the wrong grounds`
        );
    }
});

test("no transition has empty grounds", () => {
    for (const transition of SUCC4_TRANSITIONS) {
        assert.ok(
            transition.grounds.length > 0,
            `${transition.originalId} moves for no recorded reason`
        );
    }
});

// .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2.
test("every gold whose reading changed it moves on the gold-change ground", () => {
    for (const reading of SUCC4_READINGS) {
        const transition = succ4TransitionFor(reading.caseId);
        assert.ok(transition, `${reading.caseId} was corrected and does not move`);
        assert.ok(
            transition.grounds.includes("section-12.2-gold-change"),
            `${reading.caseId} was corrected and does not cite the ` +
                `gold-change ground of .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2`
        );
    }
});

test("the five cases that carry both grounds are named, not counted", () => {
    const both = SUCC4_TRANSITIONS.filter((t) => t.grounds.length === 2).map(
        (t) => t.originalId
    );
    assert.deepEqual(both.sort(), [
        "succ-assistant-en-305",
        "succ-assistant-ko-305",
        "succ-durable-en-19",
        "succ-durable-en-20",
        "succ-durable-ko-12",
    ]);
});

test("the counts match the audit's final tally", () => {
    // .github/audits/memory-eval-gold-contract-2026-08-27.md §12.10: 103 = 99
    // from the 121 readings + 2 from a batch + 2 found at assembly.
    const byFrom = new Map();
    for (const transition of SUCC4_TRANSITIONS) {
        byFrom.set(transition.from, (byFrom.get(transition.from) ?? 0) + 1);
    }
    assert.equal(byFrom.get("judgement-121"), 99);
    assert.equal(byFrom.get("batch"), 2);
    assert.equal(byFrom.get("assembly"), 2);

    assert.deepEqual(succ4TransitionCounts(), {
        total: 103,
        ruleExposureOnly: 92,
        goldChangeOnly: 6,
        bothGrounds: 5,
    });
});

test("the per-cell move counts match the audit's table", () => {
    // The table in .github/audits/memory-eval-gold-contract-2026-08-27.md §12.10. A cell
    // losing more than it replaces is how a floor is
    // breached without anyone editing the floor.
    const byCell = new Map();
    for (const transition of SUCC4_TRANSITIONS) {
        const original = succ3.get(transition.originalId);
        const cell = `${original.category}:${original.language}`;
        byCell.set(cell, (byCell.get(cell) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries([...byCell].sort()), {
        "assistant_only:en": 7,
        "assistant_only:ko": 7,
        "durable_facts:en": 55,
        "durable_facts:ko": 32,
        "injection_directives:en": 2,
    });
});

test("every auditRef names the contract document and a section it has", () => {
    // Enumerated rather than matched against a pattern: these are the four
    // sections that decide a transition, and a fifth appearing here would be a
    // reason nobody has written down.
    const allowed = [
        ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.2",
        ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
        ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.8",
        ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.9",
    ];
    for (const transition of SUCC4_TRANSITIONS) {
        assert.ok(
            allowed.includes(transition.auditRef),
            `${transition.originalId} has an unusable auditRef: ${transition.auditRef}`
        );
    }
});

test("the audit view carries ids and reasons, never case content", () => {
    assert.equal(SUCC4_SUPERSESSIONS.length, 103);
    for (const row of SUCC4_SUPERSESSIONS) {
        assert.deepEqual(Object.keys(row).sort(), [
            "auditRef",
            "foundAt",
            "grounds",
            "superseded",
            "supersededBy",
        ]);
        for (const value of Object.values(row)) {
            assert.ok(
                typeof value === "string" || Array.isArray(value),
                "a supersession row carries something that is not an id or a reason"
            );
        }
    }
});
