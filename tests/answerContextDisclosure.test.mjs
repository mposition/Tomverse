import assert from "node:assert/strict";
import test from "node:test";
import { decideAnswerContextDisclosure } from "../lib/answerContextDisclosure.ts";

/**
 * The disclosure states what an answer was given (policy §13.4 for memory,
 * §14.3 for profile knowledge). Two failures matter here:
 *
 *   1. Saying something when the policy requires silence. `null` (the context
 *      was impossible) and `0` (it was possible and nothing was selected) are
 *      both forbidden indications, and neither may become "0 used".
 *   2. Merging the two counts. An answer built from the user's own uploaded
 *      files and one built from their stored memories are different claims;
 *      one number would state neither.
 */

test("nothing is said when neither context reached the answer", () => {
    const silent = [
        {},
        { memoryUsedCount: null, knowledgeChunkCount: null },
        { memoryUsedCount: 0, knowledgeChunkCount: 0 },
        { memoryUsedCount: undefined, knowledgeChunkCount: 0 },
        { memoryUsedCount: null, knowledgeChunkCount: undefined },
    ];
    for (const input of silent) {
        assert.deepEqual(
            decideAnswerContextDisclosure(input),
            { shown: false },
            `${JSON.stringify(input)} must say nothing`
        );
    }
});

test("zero is silence, not a number to render", () => {
    // The specific misreading the policy names: "0 memories used" on an
    // answer that never had any is a misleading indication, not a neutral one.
    assert.deepEqual(
        decideAnswerContextDisclosure({ memoryUsedCount: 0 }),
        { shown: false }
    );
    assert.deepEqual(
        decideAnswerContextDisclosure({ knowledgeChunkCount: 0 }),
        { shown: false }
    );
});

test("either context alone is stated alone", () => {
    assert.deepEqual(
        decideAnswerContextDisclosure({ memoryUsedCount: 2, knowledgeChunkCount: 0 }),
        { shown: true, parts: [{ kind: "memory", count: 2 }] }
    );
    assert.deepEqual(
        decideAnswerContextDisclosure({ memoryUsedCount: null, knowledgeChunkCount: 3 }),
        { shown: true, parts: [{ kind: "knowledge", count: 3 }] }
    );
});

test("both are stated separately, memory first, never summed", () => {
    const decision = decideAnswerContextDisclosure({
        memoryUsedCount: 2,
        knowledgeChunkCount: 3,
    });
    assert.deepEqual(decision, {
        shown: true,
        parts: [
            { kind: "memory", count: 2 },
            { kind: "knowledge", count: 3 },
        ],
    });
    // Stated because it is the whole point: a single part carrying 5 would be
    // a claim neither source supports.
    assert.equal(decision.shown && decision.parts.length, 2);
});

test("a count that is not a whole positive number is not stated", () => {
    // The counts arrive from a response header via Number(), so a malformed
    // one is NaN rather than absent, and a renderer that trusted it would
    // print "NaN account memories".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "3"]) {
        assert.deepEqual(
            decideAnswerContextDisclosure({ memoryUsedCount: bad }),
            { shown: false },
            `${String(bad)} must not be stated`
        );
    }
});
