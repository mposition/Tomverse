import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/index.js";

const sum = (values) => values.reduce((a, b) => a + b, 0);

test("an even split", () => {
    assert.deepEqual(allocate(100, [1, 1]), [50, 50]);
    assert.deepEqual(allocate(100, [0.5, 0.5]), [50, 50]);
    assert.deepEqual(allocate(90, [1, 1, 1]), [30, 30, 30]);
});

test("left-over cents go to the first shares", () => {
    assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(allocate(5, [1, 1]), [3, 2]);
    assert.deepEqual(allocate(10, [1, 2]), [4, 6]);
    assert.deepEqual(allocate(2, [1, 1, 1, 1]), [1, 1, 0, 0]);
});

test("shares are floored first, never rounded", () => {
    assert.deepEqual(allocate(200, [1, 1, 1]), [67, 67, 66]);
    assert.deepEqual(allocate(1000, [1, 1, 1, 1, 1, 1, 1]), [143, 143, 143, 143, 143, 143, 142]);
});

test("uneven ratios", () => {
    assert.deepEqual(allocate(1000, [70, 20, 10]), [700, 200, 100]);
    assert.deepEqual(allocate(1, [1, 3]), [1, 0]);
});

test("zero ratios always get zero", () => {
    assert.deepEqual(allocate(100, [0, 1, 1, 1]), [0, 34, 33, 33]);
    assert.deepEqual(allocate(100, [1, 0, 1]), [50, 0, 50]);
    assert.deepEqual(allocate(101, [1, 0, 1]), [51, 0, 50]);
    assert.deepEqual(allocate(7, [0, 0, 5]), [0, 0, 7]);
});

test("negative totals are split and negated", () => {
    assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
    assert.deepEqual(allocate(-100, [1, 1]), [-50, -50]);
});

test("no share is ever negative zero", () => {
    assert.deepEqual(allocate(-100, [1, 0, 1]), [-50, 0, -50]);
    assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
    assert.deepEqual(allocate(-1, [1, 1]), [-1, 0]);
});

test("a single share takes everything", () => {
    assert.deepEqual(allocate(123, [5]), [123]);
    assert.deepEqual(allocate(-123, [5]), [-123]);
});

test("the shares always add up to the total", () => {
    for (const total of [0, 1, 7, 99, 100, 101, 12345, -1, -99, -12345]) {
        for (const ratios of [[1, 1, 1], [3, 7], [1, 0, 2, 0, 3], [0.1, 0.2, 0.7], [5]]) {
            assert.equal(sum(allocate(total, ratios)), total, `${total} ${ratios}`);
        }
    }
});

test("the total must be an integer", () => {
    for (const bad of [100.5, "100", NaN, undefined, Infinity]) assert.throws(() => allocate(bad, [1, 1]), TypeError, String(bad));
});

test("invalid ratios throw RangeError", () => {
    for (const bad of [[], [0, 0], [-1, 2], [1, NaN], [1, Infinity], "12", undefined]) {
        assert.throws(() => allocate(10, bad), RangeError, String(bad));
    }
});
