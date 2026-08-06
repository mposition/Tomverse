import assert from "node:assert/strict";
import test from "node:test";
import {
    SOURCE_DELETE_DEFAULTS,
    SOURCE_DELETE_SUSPENDED_STATUS,
    classifyMemoryForSourceDelete,
    planSourceDeletion,
    summarizeSourceDeletionImpact,
} from "../lib/memorySourceDeletion.ts";
import { MEMORY_STATUSES } from "../lib/memoryValidatorCore.ts";

/**
 * §13.1 — what a source delete does to the memories derived from it.
 *
 * The failure this guards against is the quiet one: the evidence cascades
 * away and the memory keeps being retrieved with nothing behind it.
 */

const facts = (id, overrides = {}) => ({
    id,
    hasSurvivingEvidence: false,
    userEdited: false,
    ...overrides,
});

/* -------------------------------------------------------- classification -- */

test("a memory with surviving evidence is untouched", () => {
    assert.equal(
        classifyMemoryForSourceDelete({
            hasSurvivingEvidence: true,
            userEdited: false,
        }),
        "keep"
    );
});

test("a hand-written memory is untouched, because its grounds survive", () => {
    // Manual evidence is surviving evidence, so deleting an import cannot
    // reach a memory the user typed themselves.
    assert.equal(
        classifyMemoryForSourceDelete({
            hasSurvivingEvidence: true,
            userEdited: true,
        }),
        "keep"
    );
});

test("an extracted memory left with nothing behind it is derived", () => {
    assert.equal(
        classifyMemoryForSourceDelete({
            hasSurvivingEvidence: false,
            userEdited: false,
        }),
        "derived"
    );
});

test("an edited memory left with nothing behind it is the user's, not the extractor's", () => {
    assert.equal(
        classifyMemoryForSourceDelete({
            hasSurvivingEvidence: false,
            userEdited: true,
        }),
        "user_touched"
    );
});

/* --------------------------------------------------------------- planning -- */

test("the defaults delete derived memories and suspend edited ones", () => {
    const plan = planSourceDeletion({
        memories: [
            facts("kept", { hasSurvivingEvidence: true }),
            facts("derived"),
            facts("edited", { userEdited: true }),
        ],
    });
    assert.deepEqual(plan.deleteIds, ["derived"]);
    assert.deepEqual(plan.suspendIds, ["edited"]);
    assert.deepEqual(plan.keepIds, ["kept"]);
});

test("choosing to keep derived memories suspends them instead of deleting", () => {
    const plan = planSourceDeletion({
        memories: [facts("derived")],
        derivedDisposition: "suspend",
    });
    assert.deepEqual(plan.deleteIds, []);
    assert.deepEqual(plan.suspendIds, ["derived"]);
});

test("an edited memory can be deleted, but only by asking for it", () => {
    const kept = planSourceDeletion({ memories: [facts("edited", { userEdited: true })] });
    assert.deepEqual(kept.deleteIds, [], "never by default");

    const asked = planSourceDeletion({
        memories: [facts("edited", { userEdited: true })],
        userTouchedDisposition: "delete",
    });
    assert.deepEqual(asked.deleteIds, ["edited"]);
});

test("a disposition never reaches a memory that still has evidence", () => {
    const plan = planSourceDeletion({
        memories: [facts("kept", { hasSurvivingEvidence: true, userEdited: true })],
        derivedDisposition: "delete",
        userTouchedDisposition: "delete",
    });
    assert.deepEqual(plan.deleteIds, []);
    assert.deepEqual(plan.keepIds, ["kept"]);
});

test("every memory lands in exactly one bucket", () => {
    const memories = [
        facts("a"),
        facts("b", { userEdited: true }),
        facts("c", { hasSurvivingEvidence: true }),
        facts("d"),
    ];
    const plan = planSourceDeletion({ memories });
    const all = [...plan.deleteIds, ...plan.suspendIds, ...plan.keepIds];
    assert.equal(all.length, memories.length);
    assert.equal(new Set(all).size, memories.length);
});

test("an empty source plans nothing", () => {
    assert.deepEqual(planSourceDeletion({ memories: [] }), {
        deleteIds: [],
        suspendIds: [],
        keepIds: [],
    });
});

/* ---------------------------------------------------------------- preview -- */

test("the impact summary counts what the confirmation has to state", () => {
    const impact = summarizeSourceDeletionImpact([
        facts("a"),
        facts("b"),
        facts("c", { userEdited: true }),
        facts("d", { hasSurvivingEvidence: true }),
    ]);
    assert.deepEqual(impact, {
        derivedCount: 2,
        userTouchedCount: 1,
        keptCount: 1,
    });
});

test("the summary agrees with the plan it previews", () => {
    // The confirmation shows one number and the delete applies another only if
    // these two drift apart.
    const memories = [
        facts("a"),
        facts("b", { userEdited: true }),
        facts("c", { hasSurvivingEvidence: true }),
    ];
    const impact = summarizeSourceDeletionImpact(memories);
    const plan = planSourceDeletion({ memories });
    assert.equal(impact.derivedCount, plan.deleteIds.length);
    assert.equal(impact.userTouchedCount, plan.suspendIds.length);
    assert.equal(impact.keptCount, plan.keepIds.length);
});

/* ---------------------------------------------------------------- statuses */

test("the suspended status is one the state machine knows", () => {
    assert.ok(
        MEMORY_STATUSES.includes(SOURCE_DELETE_SUSPENDED_STATUS),
        "the status must exist in the §8.3 allowlist"
    );
    assert.notEqual(
        SOURCE_DELETE_SUSPENDED_STATUS,
        "manual_review_required",
        "that status belongs to the validator, not to source deletion"
    );
});

test("the recorded defaults are the §13.1 ones", () => {
    assert.deepEqual(SOURCE_DELETE_DEFAULTS, {
        derived: "delete",
        userTouched: "suspend",
    });
});
