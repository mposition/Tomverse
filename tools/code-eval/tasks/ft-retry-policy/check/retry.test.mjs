import { test } from "node:test";
import assert from "node:assert/strict";
import { AbortError, retry } from "../src/index.js";

const failing = (times, value = "ok") => {
    let calls = 0;
    const fn = async () => {
        calls += 1;
        if (calls <= times) throw new Error(`fail ${calls}`);
        return value;
    };
    fn.calls = () => calls;
    return fn;
};

test("exponential backoff doubles and is capped", async () => {
    const waits = [];
    await retry(failing(4), { retries: 4, delayMs: 100, backoff: "exponential", maxDelayMs: 500, sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(waits, [100, 200, 400, 500]);
});

test("custom factor", async () => {
    const waits = [];
    await retry(failing(3), { retries: 3, delayMs: 10, backoff: "exponential", factor: 3, sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(waits, [10, 30, 90]);
});

test("constant backoff is the default", async () => {
    const waits = [];
    await retry(failing(2), { retries: 2, delayMs: 40, sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(waits, [40, 40]);
});

test("full jitter uses the injected random source once per wait", async () => {
    const waits = [];
    const draws = [0.5, 0.25];
    let drawn = 0;
    await retry(failing(2), {
        retries: 2,
        delayMs: 100,
        backoff: "exponential",
        jitter: true,
        rng: () => (drawn += 1, draws.shift()),
        sleep: async (ms) => waits.push(ms),
    });
    assert.deepEqual(waits, [50, 50]);
    assert.equal(drawn, 2);
});

test("jitter is applied after the cap", async () => {
    const waits = [];
    await retry(failing(1), { retries: 1, delayMs: 1000, maxDelayMs: 200, jitter: true, rng: () => 0.5, sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(waits, [100]);
});

test("shouldRetry can stop early", async () => {
    const fn = failing(5);
    const seen = [];
    await assert.rejects(
        retry(fn, { retries: 5, sleep: async () => {}, shouldRetry: (error, attempt) => (seen.push([error.message, attempt]), attempt < 2) }),
        /fail 2/,
    );
    assert.equal(fn.calls(), 2);
    assert.deepEqual(seen, [["fail 1", 1], ["fail 2", 2]]);
});

test("onRetry runs before each wait but not for the final failure", async () => {
    const events = [];
    await assert.rejects(
        retry(failing(9), {
            retries: 2,
            delayMs: 7,
            sleep: async (ms) => events.push(`sleep ${ms}`),
            onRetry: ({ error, attempt, delayMs }) => events.push(`retry ${attempt} ${error.message} ${delayMs}`),
        }),
        /fail 3/,
    );
    assert.deepEqual(events, ["retry 1 fail 1 7", "sleep 7", "retry 2 fail 2 7", "sleep 7"]);
});

test("an already aborted signal never calls fn", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = failing(0);
    await assert.rejects(retry(fn, { signal: controller.signal }), (error) => error instanceof AbortError);
    assert.equal(fn.calls(), 0);
});

test("aborting during the wait stops the next attempt", async () => {
    const controller = new AbortController();
    const fn = failing(5);
    await assert.rejects(
        retry(fn, {
            retries: 5,
            signal: controller.signal,
            sleep: async () => controller.abort(),
        }),
        (error) => error instanceof AbortError && error.cause?.message === "fail 1",
    );
    assert.equal(fn.calls(), 1);
});

test("the last error is thrown unchanged when retries run out", async () => {
    await assert.rejects(retry(failing(9), { retries: 1, sleep: async () => {} }), (error) => error.message === "fail 2" && !(error instanceof AbortError));
});
