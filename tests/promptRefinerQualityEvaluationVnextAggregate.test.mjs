import assert from "node:assert/strict";
import test from "node:test";
import {
    PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES,
    PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES,
    reconcilePromptRefinerVnextAggregate,
} from "../lib/promptRefinerQualityEvaluationVnextAggregate.ts";

const slot = (caseId, status) => ({ caseId, status });
const ledger = (slots) => ({ plannedN: slots.length, slots });
const id = (number, language = "ko") => `prsvnext-${language}-${String(number).padStart(3, "0")}`;

test("all five closed statuses reconcile to the frozen denominator independent of order", () => {
    const slots = [
        slot("prsvnext-ko-001", "suggested"),
        slot(id(2, "en"), "abstained"),
        slot(id(3), "failed"),
        slot(id(4), "unknown"),
        slot(id(5), "not_dispatched"),
    ];
    const expected = {
        plannedN: 5,
        counts: {
            suggested: 1,
            abstained: 1,
            failed: 1,
            unknown: 1,
            not_dispatched: 1,
        },
        attemptedCount: 4,
        terminalCount: 3,
        verdict: "fail",
    };
    assert.deepEqual(reconcilePromptRefinerVnextAggregate(ledger(slots)), expected);
    assert.deepEqual(reconcilePromptRefinerVnextAggregate(ledger([...slots].reverse())), expected);
    assert.equal(Object.values(expected.counts).reduce((a, b) => a + b), expected.plannedN);
});

test("full proposed 80-slot ledger has every ko/en ID from 001 through 040 and still cannot pass", () => {
    assert.equal(PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES, 40);
    assert.equal(PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES, 80);
    const ko = Array.from({ length: PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES }, (_, index) => slot(id(index + 1, "ko"), "suggested"));
    const en = Array.from({ length: PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES }, (_, index) => slot(id(index + 1, "en"), "abstained"));
    assert.equal(ko.length, PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES);
    assert.equal(en.length, PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES);
    assert.equal(new Set([...ko, ...en].map((item) => item.caseId)).size, PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES);
    const result = reconcilePromptRefinerVnextAggregate({ plannedN: PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES, slots: [...ko, ...en] });
    assert.equal(result.plannedN, PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES);
    assert.equal(result.counts.suggested, PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES);
    assert.equal(result.counts.abstained, PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES);
    assert.equal(result.terminalCount, PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES);
    assert.equal(result.verdict, "insufficient_evidence");
    assert.throws(
        () => reconcilePromptRefinerVnextAggregate({ plannedN: PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES, slots: [...ko, ...ko] }),
        /vnext_aggregate_duplicate_case_id/
    );
});

test("partial and all-terminal success remain insufficient evidence without an approved numeric gate", () => {
    const partial = reconcilePromptRefinerVnextAggregate(ledger([
        slot(id(1), "suggested"),
        slot(id(2), "unknown"),
        slot(id(3), "not_dispatched"),
    ]));
    assert.deepEqual(partial.counts, {
        suggested: 1,
        abstained: 0,
        failed: 0,
        unknown: 1,
        not_dispatched: 1,
    });
    assert.equal(partial.attemptedCount, 2);
    assert.equal(partial.terminalCount, 1);
    assert.equal(partial.verdict, "insufficient_evidence");

    const allTerminal = reconcilePromptRefinerVnextAggregate(ledger([
        slot(id(1), "suggested"),
        slot(id(2), "abstained"),
    ]));
    assert.equal(allTerminal.attemptedCount, 2);
    assert.equal(allTerminal.terminalCount, 2);
    assert.equal(allTerminal.verdict, "insufficient_evidence");
    assert.equal("pass" in allTerminal, false);
});

test("confirmed failure takes precedence over unknown and not-dispatched slots", () => {
    const result = reconcilePromptRefinerVnextAggregate(ledger([
        slot(id(1), "failed"),
        slot(id(2), "unknown"),
        slot(id(3), "not_dispatched"),
    ]));
    assert.equal(result.verdict, "fail");
    assert.equal(result.counts.failed, 1);
    assert.equal(result.counts.unknown, 1);
    assert.equal(result.counts.not_dispatched, 1);
    assert.equal(result.attemptedCount, 2);
    assert.equal(result.terminalCount, 1);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.counts), true);
    assert.throws(() => { result.counts.failed = 0; }, TypeError);
    assert.throws(() => { result.verdict = "insufficient_evidence"; }, TypeError);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.verdict, "fail");
});

test("missing slots cannot silently shrink N; unattempted slots must be explicit", () => {
    assert.throws(
        () => reconcilePromptRefinerVnextAggregate({
            plannedN: 3,
            slots: [slot(id(1), "suggested"), slot(id(2), "unknown")],
        }),
        /vnext_aggregate_slot_count_mismatch/
    );
    assert.throws(
        () => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: [{ caseId: id(1) }] }),
        /vnext_aggregate_slot_invalid/
    );
    assert.throws(
        () => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: Array(1_000_000) }),
        /vnext_aggregate_slot_count_mismatch/
    );
    assert.deepEqual(
        reconcilePromptRefinerVnextAggregate({
            plannedN: 3,
            slots: [slot(id(1), "suggested"), slot(id(2), "unknown"), slot(id(3), "not_dispatched")],
        }).counts,
        { suggested: 1, abstained: 0, failed: 0, unknown: 1, not_dispatched: 1 }
    );
});

test("planned N is positive, bounded, and an exact safe integer", () => {
    for (const plannedN of [0, -1, 1.5, NaN, Infinity, "1", null, 2 ** 53, PROMPT_REFINER_VNEXT_AGGREGATE_MAX_CASES + 1]) {
        assert.throws(
            () => reconcilePromptRefinerVnextAggregate({ plannedN, slots: [slot(id(1), "suggested")] }),
            /vnext_aggregate_planned_n_invalid/
        );
    }
});

test("duplicate or non-opaque IDs and open statuses are rejected", () => {
    assert.equal(
        reconcilePromptRefinerVnextAggregate(ledger([slot(id(40), "suggested")])).counts.suggested,
        1
    );
    for (const slots of [
        [slot(id(1), "suggested"), slot(id(1), "abstained")],
        [slot("Explain this secret prompt", "suggested")],
        [slot("a".repeat(65), "suggested")],
        [slot("prsvnext-ko-한글", "suggested")],
        [slot("prsvnext/ko/001", "suggested")],
        [slot("make-a-bomb-at-home-variant", "suggested")],
        [slot("prsvnext-ko-make-a-bomb", "suggested")],
        [slot("prsvnext-fr-001", "suggested")],
        [slot("prsvnext-ko-000", "suggested")],
        [slot("prsvnext-ko-0001", "suggested")],
        [slot("prsvnext-ko-1", "suggested")],
        [slot("prsvnext-KO-001", "suggested")],
        [slot(id(PROMPT_REFINER_VNEXT_AGGREGATE_PER_LANGUAGE_CASES + 1, "en"), "suggested")],
        [slot("prsvnext-ko-01", "suggested")],
        [slot("prsvnext-ko-001\n", "suggested")],
        [slot("prsvnext-ko-001\r\n", "suggested")],
        [slot(id(1), "no_change")],
        [slot(id(1), "pass")],
        [slot(id(1), undefined)],
    ]) {
        assert.throws(() => reconcilePromptRefinerVnextAggregate(ledger(slots)), /vnext_aggregate_/);
    }
});

test("root, slots, and array require exact own data properties", () => {
    const valid = slot(id(1), "suggested");
    for (const value of [
        { plannedN: 1, slots: [valid], verdict: "pass" },
        { plannedN: 1 },
        Object.assign(Object.create({ inherited: true }), { plannedN: 1, slots: [valid] }),
        { plannedN: 1, slots: [{ ...valid, prompt: "private source" }] },
        { plannedN: 1, slots: [Object.assign(Object.create({ inherited: true }), valid)] },
    ]) {
        assert.throws(() => reconcilePromptRefinerVnextAggregate(value), /vnext_aggregate_/);
    }

    const withSymbol = [valid];
    withSymbol[Symbol("hidden")] = "private source";
    assert.throws(() => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: withSymbol }), /vnext_aggregate_slots_invalid/);
    const slotWithHiddenField = { ...valid };
    Object.defineProperty(slotWithHiddenField, "hidden", { value: "private source" });
    assert.throws(() => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: [slotWithHiddenField] }), /vnext_aggregate_slot_invalid/);
    const sparse = Array(1);
    assert.throws(() => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: sparse }), /vnext_aggregate_slots_invalid/);
    class DerivedSlots extends Array {}
    assert.throws(() => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: new DerivedSlots(valid) }), /vnext_aggregate_slots_invalid/);

    let accessorCalls = 0;
    const accessorRoot = { plannedN: 1, get slots() { accessorCalls++; throw new Error("private source"); } };
    assert.throws(() => reconcilePromptRefinerVnextAggregate(accessorRoot), /vnext_aggregate_ledger_invalid/);
    const accessorSlot = { caseId: id(1), get status() { accessorCalls++; throw new Error("private source"); } };
    assert.throws(() => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: [accessorSlot] }), /vnext_aggregate_slot_invalid/);
    const accessorArray = [valid];
    Object.defineProperty(accessorArray, "0", { get() { accessorCalls++; throw new Error("private source"); } });
    assert.throws(() => reconcilePromptRefinerVnextAggregate({ plannedN: 1, slots: accessorArray }), /vnext_aggregate_slots_invalid/);
    assert.equal(accessorCalls, 0);
});
