// The docs/ops/memory-extraction-eval-dataset.md §7.1a conditions, exercised
// against records that are deliberately wrong.
//
// A checker only ever run against the one document that happens to pass says
// nothing about what it would do with one that does not. Conditions 4 and 5
// are the whole point of the clause -- they are the cells a person fills --
// so the cases that matter most here are the ones where a plausible-looking
// record is missing them.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
    parseSucc4AdoptionRecord,
    readSucc4AdoptionRecord,
    succ4AdoptionConditions,
    isUnfilled,
} from "../lib/memoryEvalSucc4AdoptionRecord.ts";
import { MEMORY_EVAL_SUCC4_MANIFEST } from "../lib/memoryEvalSucc4Manifest.ts";
import {
    MEMORY_EVAL_SUCC4_DATASET_FROZEN,
    MEMORY_EVAL_SUCC4_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC4_REPLACEMENT_CASES,
} from "../lib/memoryEvalSucc4Dataset.ts";

const RECORD = path.resolve(
    import.meta.dirname,
    "../docs/ops/memory-extraction-eval-succ4-adoption.md"
);
const live = MEMORY_EVAL_SUCC4_MANIFEST.composition;
const sourceBatchIds = live.inheritedComponents.map((c) => c.sourceBatchId);

const run = (record, overrides = {}) =>
    succ4AdoptionConditions({
        record,
        inherited: live.inheritedComponents,
        sourceBatchIdsWithRecord: sourceBatchIds,
        liveTranches: live.replacementTranches,
        replacementCount: MEMORY_EVAL_SUCC4_REPLACEMENT_CASES.length,
        ...overrides,
    });

const byName = (results, fragment) =>
    results.find((result) => result.condition.includes(fragment));

/** The record as it stands, plus whatever a test wants filled in. */
const filled = () => {
    const record = readSucc4AdoptionRecord(RECORD);
    const verdicts = {};
    for (const tranche of record.tranches) verdicts[tranche.trancheId] = "adopted";
    return {
        ...record,
        verdicts,
        reviewer: "@someone",
        disagreement: {
            judged: "103",
            rejected: "0",
            rate: "0%",
            unresolved: "0",
        },
        signature: {
            reviewer: "@someone",
            approvedAt: "2026-08-28",
            signature: "@someone",
        },
    };
};

test("the drafted record parses into five tranches and their digests", () => {
    const record = readSucc4AdoptionRecord(RECORD);
    assert.equal(record.tranches.length, 5);
    assert.deepEqual(
        record.tranches.map((t) => t.trancheId),
        live.replacementTranches.map((t) => t.trancheId)
    );
    assert.deepEqual(
        record.tranches.map((t) => t.componentDigest),
        live.replacementTranches.map((t) => t.componentDigest)
    );
    assert.equal(
        record.tranches.reduce((total, t) => total + t.caseCount, 0),
        103
    );
});

test("conditions 1 to 3 hold on the drafted record", () => {
    const results = run(readSucc4AdoptionRecord(RECORD));
    assert.equal(byName(results, "inherited cases covered").ok, true);
    assert.equal(byName(results, "exactly the replacements").ok, true);
    assert.equal(byName(results, "digest matches the tree").ok, true);
});

test("the record as adopted satisfies all five", () => {
    const results = run(readSucc4AdoptionRecord(RECORD));
    assert.deepEqual(
        results.filter((result) => !result.ok),
        []
    );
});

test("the record carries the operator's judgement, not a placeholder", () => {
    const record = readSucc4AdoptionRecord(RECORD);
    assert.equal(record.reviewer, "@mposition");
    assert.equal(record.signature.reviewer, "@mposition");
    assert.equal(record.signature.approvedAt, "2026-08-28");
    assert.equal(record.signature.signature, "@mposition");
    for (const tranche of record.tranches) {
        assert.equal(record.verdicts[tranche.trancheId], "adopted");
    }
});

test("blanking any judgement cell puts conditions 4 and 5 back", () => {
    // The clause's point is that an agent can make 1 to 3 true and cannot make
    // these true. Now that a person has filled them, the way to keep saying so
    // is to show the conditions come back the moment a cell is emptied.
    const record = readSucc4AdoptionRecord(RECORD);
    const blanked = {
        ...record,
        reviewer: "*(사람이 기입)*",
        verdicts: Object.fromEntries(
            Object.keys(record.verdicts).map((id) => [id, "*(사람이 기입)*"])
        ),
        signature: {
            reviewer: "*(사람이 기입)*",
            approvedAt: "*(사람이 기입)*",
            signature: "*(사람이 기입)*",
        },
    };
    const results = run(blanked);
    assert.equal(byName(results, "reviewer, disagreement and verdicts").ok, false);
    assert.equal(byName(results, "recorded and adopted").ok, false);
    // And 1 to 3 are untouched by that, which is the split the clause draws.
    assert.equal(byName(results, "inherited cases covered").ok, true);
    assert.equal(byName(results, "exactly the replacements").ok, true);
    assert.equal(byName(results, "digest matches the tree").ok, true);
});

test("the two disagreement figures are read from their own subsections", () => {
    // docs/ops/memory-extraction-eval-succ4-adoption.md §5 splits in two:
    // the reviewer's figure, 0 of 103, and the contract checks', 21 of 103. A
    // reader that stopped at the first subsection heading found no rows and
    // called every cell unfilled.
    const record = readSucc4AdoptionRecord(RECORD);
    assert.match(record.disagreement.judged, /103/);
    assert.equal(record.disagreement.rejected, "0");
    assert.equal(record.disagreement.rate, "0%");
    assert.equal(record.disagreement.unresolved, "0");
});

test("a placeholder is not a filled cell", () => {
    assert.equal(isUnfilled(""), true);
    assert.equal(isUnfilled("   "), true);
    assert.equal(isUnfilled("*(사람이 기입)*"), true);
    assert.equal(isUnfilled("*(anything at all)*"), true);
    assert.equal(isUnfilled("adopted"), false);
    assert.equal(isUnfilled("@mposition"), false);
});

test("a tranche marked anything but adopted refuses the freeze", () => {
    for (const verdict of ["rejected", "conditional", "pending", "ADOPTED", ""]) {
        const record = filled();
        const results = run({
            ...record,
            verdicts: { ...record.verdicts, "succ4-tranche-3": verdict },
        });
        assert.equal(
            byName(results, "recorded and adopted").ok,
            false,
            `a verdict of "${verdict}" was accepted as adoption`
        );
    }
});

test("a tranche the record never mentions refuses the freeze", () => {
    const record = filled();
    const results = run({
        ...record,
        tranches: record.tranches.filter((t) => t.trancheId !== "succ4-tranche-5"),
        verdicts: Object.fromEntries(
            Object.entries(record.verdicts).filter(
                ([id]) => id !== "succ4-tranche-5"
            )
        ),
    });
    assert.equal(byName(results, "exactly the replacements").ok, false);
    assert.equal(byName(results, "recorded and adopted").ok, false);
    assert.match(
        byName(results, "recorded and adopted").detail,
        /unrecorded: succ4-tranche-5/
    );
});

test("a recorded digest that no longer matches the tree refuses the freeze", () => {
    const record = filled();
    const results = run({
        ...record,
        tranches: record.tranches.map((tranche, index) =>
            index === 0 ? { ...tranche, componentDigest: "0".repeat(64) } : tranche
        ),
    });
    assert.equal(byName(results, "digest matches the tree").ok, false);
});

test("a case count that does not add up to the replacements refuses the freeze", () => {
    const record = filled();
    const results = run({
        ...record,
        tranches: record.tranches.map((tranche, index) =>
            index === 0 ? { ...tranche, caseCount: tranche.caseCount + 1 } : tranche
        ),
    });
    assert.equal(byName(results, "exactly the replacements").ok, false);
});

test("a source batch with no adoption record refuses the freeze", () => {
    const results = run(filled(), {
        sourceBatchIdsWithRecord: sourceBatchIds.slice(1),
    });
    const condition = byName(results, "inherited cases covered");
    assert.equal(condition.ok, false);
    assert.match(condition.detail, new RegExp(sourceBatchIds[0]));
});

test("a drafting source that is not tool/model/version refuses the freeze", () => {
    for (const drafted of ["", "claude", "ai-draft:claude-code", "by hand"]) {
        const record = filled();
        const results = run({
            ...record,
            draftedBy: { ...record.draftedBy, "succ4-tranche-2": drafted },
        });
        assert.equal(
            byName(results, "reviewer, disagreement and verdicts").ok,
            false,
            `a drafting source of "${drafted}" was accepted`
        );
    }
});

test("an unfilled disagreement cell refuses the freeze", () => {
    for (const key of ["judged", "rejected", "rate", "unresolved"]) {
        const record = filled();
        const results = run({
            ...record,
            disagreement: { ...record.disagreement, [key]: "*(사람이 기입)*" },
        });
        assert.equal(
            byName(results, "reviewer, disagreement and verdicts").ok,
            false,
            `an unfilled ${key} was accepted`
        );
    }
});

test("an empty record fails every condition it can", () => {
    const results = run(
        parseSucc4AdoptionRecord("# nothing here\n\nno tables at all.\n")
    );
    assert.equal(byName(results, "exactly the replacements").ok, false);
    assert.equal(byName(results, "reviewer, disagreement and verdicts").ok, false);
    assert.equal(byName(results, "recorded and adopted").ok, false);
});

test("succ-4 is frozen, and the two constants moved together", () => {
    // docs/ops/memory-extraction-eval-dataset.md §7.2 is one act, not two. A
    // frozen dataset still marked `development` would refuse to be cited by
    // one reader and accept it from another.
    assert.equal(MEMORY_EVAL_SUCC4_DATASET_FROZEN, true);
    assert.equal(MEMORY_EVAL_SUCC4_DATASET_PURPOSE, "decision");
});

test("the freeze rests on an adoption the record actually carries", () => {
    // The constant claims the conditions were met, so the check is a gate now
    // rather than a progress report. This is the half of it a test can hold:
    // the record's judgement cells are filled, so blanking one would fail the
    // build rather than lowering a count.
    const record = readSucc4AdoptionRecord(RECORD);
    assert.equal(MEMORY_EVAL_SUCC4_DATASET_FROZEN, true);
    assert.ok(!isUnfilled(record.reviewer));
    assert.ok(!isUnfilled(record.signature.signature));
    assert.ok(!isUnfilled(record.signature.approvedAt));
    for (const tranche of record.tranches) {
        assert.equal(record.verdicts[tranche.trancheId], "adopted");
    }
    assert.deepEqual(
        run(record).filter((result) => !result.ok),
        []
    );
});
