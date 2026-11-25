import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/index.js";

test("retries with a constant delay and returns the first success", async () => {
    const waits = [];
    let calls = 0;
    const result = await retry(
        async () => {
            calls += 1;
            if (calls < 3) throw new Error("boom");
            return "done";
        },
        { retries: 3, delayMs: 50, sleep: async (ms) => waits.push(ms) },
    );
    assert.equal(result, "done");
    assert.deepEqual(waits, [50, 50]);
});

test("throws the last error after the retries are used up", async () => {
    let calls = 0;
    await assert.rejects(
        retry(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { retries: 2, sleep: async () => {} }),
        /fail 3/,
    );
});
