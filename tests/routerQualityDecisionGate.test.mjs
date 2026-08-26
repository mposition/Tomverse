import assert from "node:assert/strict";
import test from "node:test";

import { decisionRunRefusals } from "../lib/routerQualityEvalSet.ts";

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

const set = (overrides = {}) => ({
    version: "fixture",
    purpose: "decision",
    cellTargets: CELLS.map(([stratum, cell]) => ({ stratum, cell, target: 14 })),
    baseline: { modelId: "gpt-5-6-luna" },
    pilotReady: true,
    items: items(14),
    ...overrides,
});

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
