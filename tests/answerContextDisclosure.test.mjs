import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeExcerptCountToShow } from "../lib/answerContextDisclosure.ts";

/**
 * Profile knowledge is stated per answer
 * (docs/policy/external-conversation-import-and-memory.md §14.3); account memory no
 * longer is. The failure that matters is saying something when the answer
 * had nothing: neither `null` nor `0` may become "0 used".
 */

test("nothing is said when no knowledge reached the answer", () => {
    for (const count of [undefined, null, 0]) {
        assert.equal(knowledgeExcerptCountToShow(count), null, String(count));
    }
});

test("a positive whole count is stated as it is", () => {
    assert.equal(knowledgeExcerptCountToShow(3), 3);
});

test("a count that is not a whole positive number is not stated", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "3"]) {
        assert.equal(knowledgeExcerptCountToShow(bad), null, String(bad));
    }
});
