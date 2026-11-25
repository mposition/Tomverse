import { test } from "node:test";
import assert from "node:assert/strict";
import { contains, freeSlots, mergeRanges, overlaps } from "../src/index.js";

test("back-to-back ranges do not overlap", () => {
    assert.equal(overlaps({ start: 8, end: 10 }, { start: 10, end: 12 }), false);
    assert.equal(overlaps({ start: 10, end: 12 }, { start: 8, end: 10 }), false);
    assert.equal(overlaps({ start: 8, end: 11 }, { start: 10, end: 12 }), true);
    assert.equal(overlaps({ start: 1, end: 10 }, { start: 3, end: 4 }), true);
});

test("contains is half-open", () => {
    const r = { start: 5, end: 8 };
    assert.equal(contains(r, 5), true);
    assert.equal(contains(r, 7), true);
    assert.equal(contains(r, 8), false);
    assert.equal(contains(r, 4), false);
});

test("touching ranges are merged", () => {
    assert.deepEqual(mergeRanges([{ start: 3, end: 5 }, { start: 1, end: 3 }]), [{ start: 1, end: 5 }]);
});

test("mergeRanges returns sorted output and leaves the input alone", () => {
    const input = [
        { start: 10, end: 12 },
        { start: 1, end: 4 },
        { start: 3, end: 6 },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = mergeRanges(input);
    assert.deepEqual(result, [{ start: 1, end: 6 }, { start: 10, end: 12 }]);
    assert.deepEqual(input, snapshot);
    result[0].end = 99;
    assert.deepEqual(input, snapshot);
});

test("free slots ignore bookings after the window", () => {
    const slots = freeSlots(
        [{ start: 20, end: 22 }, { start: 30, end: 31 }],
        { start: 0, end: 10 },
    );
    assert.deepEqual(slots, [{ start: 0, end: 10 }]);
});

test("free slots are clipped to the window", () => {
    assert.deepEqual(freeSlots([{ start: -5, end: 3 }, { start: 8, end: 20 }], { start: 0, end: 10 }), [{ start: 3, end: 8 }]);
    assert.deepEqual(freeSlots([{ start: 0, end: 10 }], { start: 0, end: 10 }), []);
    assert.deepEqual(freeSlots([], { start: 2, end: 4 }), [{ start: 2, end: 4 }]);
});
