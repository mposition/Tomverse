import assert from "node:assert/strict";
import test from "node:test";

import {
    decisionRunRefusals,
    evalSampleDigest,
    freezeDrift,
    runParameterMismatches,
} from "../lib/routerQualityEvalSet.ts";

const CELLS = [
    ["general_question_answering", "ko"], ["general_question_answering", "en"],
    ["writing_and_rewriting", "ko"], ["writing_and_rewriting", "en"],
    ["coding", "ko"], ["coding", "en"],
    ["analysis_and_reasoning", "ko"], ["analysis_and_reasoning", "en"],
    ["translation_cross_language", "ko-en"],
    ["current_information", "ko"], ["current_information", "en"],
    ["document_and_attachment", "ko"], ["document_and_attachment", "en"],
    ["long_context_conversation", "ko"], ["long_context_conversation", "en"],
];

const items = (perCell) =>
    CELLS.flatMap(([stratum, cell]) =>
        Array.from({ length: perCell }, (unused, index) => ({
            id: `${stratum}-${cell}-${index}`,
            stratum,
            cell,
            status: "adopted",
            prompt: "…",
        }))
    );

// The digest is computed from whatever the fixture ends up holding, so a test
// that changes the items is testing the thing it changed rather than tripping
// the freeze check by accident. A drift test overrides frozenDigest by hand.
const set = (overrides = {}) => {
    const base = {
        version: "fixture",
        purpose: "decision",
        frozenAt: "2026-08-26T08:00:00Z",
        frozenBy: "mposition",
        cellTargets: CELLS.map(([stratum, cell]) => ({ stratum, cell, target: 14 })),
        baseline: { modelId: "gpt-5-6-luna" },
        judge: { modelId: "gpt-5-6-luna" },
        seed: { value: 20260826 },
        pilotReady: true,
        items: items(14),
        ...overrides,
    };
    return { frozenDigest: evalSampleDigest(base), ...base };
};

test("a set that is ready, exact and pre-registered is not refused", () => {
    assert.deepEqual(decisionRunRefusals(set()), []);
});

// The flag a person sets to mean "measure this now" had no effect on whether
// it was measured: the runner never read it.
test("pilotReady must be true, not merely absent", () => {
    for (const value of [undefined, null, false, "true"]) {
        const refusals = decisionRunRefusals(set({ pilotReady: value }));
        assert.equal(refusals.length, 1, `pilotReady ${JSON.stringify(value)}`);
        assert.match(refusals[0], /does not say it is ready/);
    }
});

// Collection overshoots on purpose -- spare candidates cover the items a
// reviewer rejects. A run that swept them in would reweight the strata and
// resize an n that is fixed in advance, so more is refused exactly as less is.
test("a cell holding more than its target is refused, not just a short one", () => {
    const over = decisionRunRefusals(set({ items: items(16) }));
    assert.equal(over.length, CELLS.length);
    assert.match(over[0], /holds 16 adopted against a target of 14/);

    const short = decisionRunRefusals(set({ items: items(13) }));
    assert.equal(short.length, CELLS.length);
    assert.match(short[0], /holds 13 adopted against a target of 14/);
});

test("one wrong cell is named, and the others are not", () => {
    const mixed = [...items(14), { id: "extra", stratum: "coding", cell: "ko", status: "adopted", prompt: "…" }];
    const refusals = decisionRunRefusals(set({ items: mixed }));
    assert.deepEqual(refusals, ["coding/ko holds 15 adopted against a target of 14"]);
});

// Candidates are what the spare items are; they must not count towards a
// target that is about adopted work.
test("candidates do not count towards a cell's target", () => {
    const withSpares = [
        ...items(14),
        { id: "spare", stratum: "coding", cell: "en", status: "candidate", prompt: "…" },
    ];
    assert.deepEqual(decisionRunRefusals(set({ items: withSpares })), []);
});

test("an empty cellTargets is refused before any cell is compared", () => {
    const refusals = decisionRunRefusals(set({ cellTargets: [] }));
    assert.ok(refusals.some((reason) => /cellTargets is empty/.test(reason)));
});

test("a set with no pre-registered baseline is refused", () => {
    for (const baseline of [undefined, null, {}, { modelId: "" }]) {
        const refusals = decisionRunRefusals(set({ baseline }));
        assert.ok(refusals.some((reason) => /no baseline is pre-registered/.test(reason)));
    }
});

// --- the freeze record ------------------------------------------------------

// The other four refusals all read the set as it stands, so all four can be
// satisfied by a set edited this morning. This is the only one that asks
// whether it is still the set that was frozen.
test("a set edited after its freeze is refused", () => {
    const edited = set();
    edited.items = [{ ...edited.items[0], prompt: "a different question" }, ...edited.items.slice(1)];
    const refusals = decisionRunRefusals(edited);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /has changed since it was frozen/);
});

test("a set with no freeze record at all is refused", () => {
    const refusals = decisionRunRefusals(set({ frozenAt: null, frozenBy: null }));
    assert.deepEqual(refusals, [
        "the set carries no freeze record, so there is no moment its contents are pinned to",
    ]);
});

// A date with nothing behind it is the state this check exists to reject: it
// reads as a freeze and pins nothing.
test("a freeze date without a digest is refused", () => {
    const refusals = decisionRunRefusals({ ...set(), frozenDigest: null });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /carries no digest/);
});

test("reordering the file is not a change to the sample", () => {
    const reordered = set();
    reordered.items = [...reordered.items].reverse();
    assert.equal(freezeDrift(reordered), null);
});

// Anything a digest flags that a reviewer considers routine gets the digest
// turned off, so review bookkeeping is deliberately outside it.
test("a reviewer note, an adopter and a drafter are outside the digest", () => {
    const annotated = set();
    annotated.items = annotated.items.map((item) => ({
        ...item,
        notes: "reads a little formal",
        adoptedBy: "somebody-else",
        adoptedAt: "2026-09-01",
        draftProvenance: { provider: "unrecorded" },
    }));
    assert.equal(freezeDrift(annotated), null);
});

// The reserve exists to be drafted into after the freeze. If that moved the
// digest, the freeze and the reserve could not coexist in one file.
test("drafting into the reserve does not disturb the freeze", () => {
    const withReserve = set();
    withReserve.items = [
        ...withReserve.items,
        { id: "reserve-1", stratum: "coding", cell: "ko", status: "candidate", prompt: "held back" },
    ];
    assert.equal(freezeDrift(withReserve), null);
});

// Membership is part of the fingerprint without status being hashed: a
// promoted reserve item is a different sample, and must read as one.
test("promoting a reserve item into the sample is drift", () => {
    const promoted = set();
    promoted.items = [
        ...promoted.items,
        { id: "reserve-1", stratum: "coding", cell: "ko", status: "adopted", prompt: "held back" },
    ];
    assert.match(freezeDrift(promoted) ?? "", /has changed since it was frozen/);
});

test("the digest survives a malformed attachment rather than throwing", () => {
    const malformed = set();
    malformed.items = [{ ...malformed.items[0], attachments: "image/png" }, ...malformed.items.slice(1)];
    assert.doesNotThrow(() => evalSampleDigest(malformed));
});

// --- judge and seed --------------------------------------------------------

test("a set with no judge or seed pre-registered is refused", () => {
    const refusals = decisionRunRefusals(set({ judge: null, seed: null }));
    assert.deepEqual(refusals, [
        "no judge is pre-registered, so nothing fixes who grades the pairs",
        "no seed is pre-registered, so the arm ordering was not fixed in advance",
    ]);
});

const run = (overrides = {}) => ({
    mode: "pilot",
    baselineModelId: "gpt-5-6-luna",
    judgeModelId: "gpt-5-6-luna",
    seed: 20260826,
    ...overrides,
});

test("the pre-registered configuration passes", () => {
    assert.deepEqual(runParameterMismatches(set(), run()), []);
});

// The report copies the set's pre-registration provenance in beside whatever
// was passed on the command line, so an unchecked argument produces a record
// naming a person and a date for a choice they never made.
test("each run argument is checked against what the set registered", () => {
    assert.deepEqual(runParameterMismatches(set(), run({ seed: 20260812 })), [
        "--seed=20260812, but the set pre-registered 20260826",
    ]);
    assert.deepEqual(runParameterMismatches(set(), run({ judgeModelId: "claude-sonnet-5" })), [
        "--judge=claude-sonnet-5, but the set pre-registered gpt-5-6-luna",
    ]);
    assert.deepEqual(runParameterMismatches(set(), run({ baselineModelId: "gpt-5-4-mini" })), [
        "--baseline=gpt-5-4-mini, but the set pre-registered gpt-5-6-luna",
    ]);
    assert.equal(
        runParameterMismatches(set(), run({ baselineModelId: "x", judgeModelId: "y", seed: 1 })).length,
        3
    );
});

// The bias run of docs/ops/tomverse-chat-router-evaluation-set.md §5 puts a
// different model in the baseline arm on purpose: a judge
// compared against itself measures nothing. Its judge and seed are still the
// pre-registered ones.
test("a bias run may differ in baseline, but not in judge or seed", () => {
    const bias = run({ mode: "judge-bias", baselineModelId: "deepseek-v4-flash" });
    assert.deepEqual(runParameterMismatches(set(), bias), []);
    assert.deepEqual(runParameterMismatches(set(), { ...bias, seed: 7 }), [
        "--seed=7, but the set pre-registered 20260826",
    ]);
});

// A set that registered nothing cannot contradict anything. The refusal for
// that state is decisionRunRefusals'; this function only reports disagreement.
test("nothing registered is not a mismatch", () => {
    assert.deepEqual(
        runParameterMismatches(set({ baseline: null, judge: null, seed: null }), run({ seed: 1 })),
        []
    );
});
