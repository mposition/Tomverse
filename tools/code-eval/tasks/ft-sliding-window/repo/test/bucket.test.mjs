import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedLimiter, TokenBucket, manualClock } from "../src/index.js";

test("a bucket refills over time", () => {
    const clock = manualClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, clock });
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), false);
    clock.advance(1000);
    assert.equal(bucket.tryTake(), true);
});

test("keys have separate buckets", () => {
    const limiter = new KeyedLimiter({ capacity: 1, refillPerSecond: 0, clock: manualClock() });
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), false);
    assert.equal(limiter.tryTake("b"), true);
});
