import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter, TokenBucket, manualClock } from "../src/index.js";

const make = (options = {}) => {
    const clock = manualClock(1000);
    return { clock, limiter: new SlidingWindowLimiter({ limit: 3, windowMs: 1000, clock, ...options }) };
};

test("allows up to the limit and reports what is left", () => {
    const { limiter } = make();
    assert.deepEqual(limiter.tryAcquire("u"), { allowed: true, remaining: 2, retryAfterMs: 0 });
    assert.deepEqual(limiter.tryAcquire("u"), { allowed: true, remaining: 1, retryAfterMs: 0 });
    assert.deepEqual(limiter.tryAcquire("u"), { allowed: true, remaining: 0, retryAfterMs: 0 });
    assert.equal(limiter.tryAcquire("u").allowed, false);
});

test("a denied call reports when the oldest acquisition expires and records nothing", () => {
    const { limiter, clock } = make();
    limiter.tryAcquire("u");
    clock.advance(100);
    limiter.tryAcquire("u");
    clock.advance(100);
    limiter.tryAcquire("u");
    clock.advance(300);
    assert.deepEqual(limiter.tryAcquire("u"), { allowed: false, remaining: 0, retryAfterMs: 500 });
    assert.deepEqual(limiter.tryAcquire("u"), { allowed: false, remaining: 0, retryAfterMs: 500 });
    clock.advance(500);
    assert.equal(limiter.remaining("u"), 1);
});

test("an acquisition expires exactly windowMs later", () => {
    const { limiter, clock } = make({ limit: 1 });
    limiter.tryAcquire("u");
    clock.advance(999);
    assert.equal(limiter.tryAcquire("u").allowed, false);
    clock.advance(1);
    assert.equal(limiter.tryAcquire("u").allowed, true);
});

test("the window slides instead of resetting", () => {
    const { limiter, clock } = make({ limit: 2, windowMs: 1000 });
    limiter.tryAcquire("u");
    clock.advance(600);
    limiter.tryAcquire("u");
    clock.advance(500);
    assert.equal(limiter.remaining("u"), 1);
    assert.equal(limiter.tryAcquire("u").allowed, true);
    assert.equal(limiter.tryAcquire("u").allowed, false);
});

test("keys are independent and the default key exists", () => {
    const { limiter } = make({ limit: 1 });
    assert.equal(limiter.tryAcquire("a").allowed, true);
    assert.equal(limiter.tryAcquire("b").allowed, true);
    assert.equal(limiter.tryAcquire("a").allowed, false);
    assert.equal(limiter.tryAcquire().allowed, true);
    assert.equal(limiter.tryAcquire().allowed, false);
});

test("remaining does not record", () => {
    const { limiter } = make();
    assert.equal(limiter.remaining("u"), 3);
    assert.equal(limiter.remaining("u"), 3);
    assert.equal(limiter.tryAcquire("u").remaining, 2);
});

test("reset one key or all", () => {
    const { limiter } = make({ limit: 1 });
    limiter.tryAcquire("a");
    limiter.tryAcquire("b");
    limiter.reset("a");
    assert.equal(limiter.tryAcquire("a").allowed, true);
    assert.equal(limiter.tryAcquire("b").allowed, false);
    limiter.reset();
    assert.equal(limiter.tryAcquire("b").allowed, true);
});

test("expired keys do not stay in memory", () => {
    const { limiter, clock } = make();
    limiter.tryAcquire("a");
    limiter.tryAcquire("b");
    assert.equal(limiter.size(), 2);
    clock.advance(1000);
    assert.equal(limiter.size(), 0);
    limiter.tryAcquire("c");
    assert.equal(limiter.size(), 1);
});

test("invalid options throw", () => {
    for (const bad of [{ limit: 0 }, { limit: 1.5 }, { windowMs: 0 }, { windowMs: "x" }]) {
        assert.throws(() => new SlidingWindowLimiter({ limit: 1, windowMs: 1, ...bad }), RangeError, JSON.stringify(bad));
    }
    assert.throws(() => new SlidingWindowLimiter(), RangeError);
});

test("the token bucket is unchanged", () => {
    const clock = manualClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, clock });
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), false);
    clock.advance(1000);
    assert.equal(bucket.available(), 1);
});
