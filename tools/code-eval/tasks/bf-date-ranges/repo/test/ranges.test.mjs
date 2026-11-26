import { test } from "node:test";
import assert from "node:assert/strict";
import { contains, freeSlots, mergeRanges, overlaps } from "../src/index.js";

test("overlapping ranges overlap", () => {
    assert.equal(overlaps({ start: 1, end: 5 }, { start: 4, end: 8 }), true);
    assert.equal(overlaps({ start: 1, end: 3 }, { start: 5, end: 8 }), false);
});

test("merges overlapping ranges", () => {
    assert.deepEqual(mergeRanges([{ start: 1, end: 5 }, { start: 3, end: 8 }]), [{ start: 1, end: 8 }]);
});

test("free slots between bookings", () => {
    assert.deepEqual(freeSlots([{ start: 2, end: 4 }], { start: 0, end: 10 }), [
        { start: 0, end: 2 },
        { start: 4, end: 10 },
    ]);
    assert.equal(contains({ start: 1, end: 5 }, 3), true);
});
