import assert from "node:assert/strict";
import test from "node:test";
import { createReviewAttemptQueue } from "../lib/comparisonReviewAttempts";

const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
const complete = { record: { status: "completed" } };

test("parallel mode starts only two attempts and reuses each result exactly once", async () => {
  const calls: string[] = [];
  const release = new Map<string, () => void>();
  const queue = createReviewAttemptQueue(candidates, async candidate => {
    calls.push(candidate.id);
    await new Promise<void>(resolve => release.set(candidate.id, resolve));
    return complete;
  }, true);
  assert.deepEqual(calls, ["a", "b"]);
  release.get("a")!();
  assert.equal(await queue.run(candidates[0]), complete);
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release.get("b")!();
  assert.equal(await queue.run(candidates[1]), complete);
  await drain;
  assert.deepEqual(calls, ["a", "b"]);
});

test("a local reservation refusal is retried only after concurrent leases finish", async () => {
  let active = false;
  let release!: () => void;
  const calls: string[] = [];
  const queue = createReviewAttemptQueue(candidates, async candidate => {
    calls.push(candidate.id);
    if (candidate.id === "a") {
      active = true;
      await new Promise<void>(resolve => { release = resolve; });
      active = false;
      return complete;
    }
    return active ? { record: { status: "refused" } } : complete;
  }, true);
  const secondary = queue.run(candidates[1]);
  await Promise.resolve();
  assert.deepEqual(calls, ["a", "b"]);
  release();
  assert.equal(await secondary, complete);
  assert.deepEqual(calls, ["a", "b", "b"]);
  await queue.drain();
});

test("provider failures are not silently retried by the prefetch layer", async () => {
  let calls = 0;
  const queue = createReviewAttemptQueue(candidates, async () => { calls++; return { record: { status: "failed" } }; }, true);
  assert.equal((await queue.run(candidates[1])).record.status, "failed");
  assert.equal(calls, 2);
  await queue.drain();
});

test("default sequential mode does not prefetch or add retries", async () => {
  let calls = 0;
  const queue = createReviewAttemptQueue(candidates, async () => { calls++; return { record: { status: "refused" } }; }, false);
  assert.equal(calls, 0);
  await queue.run(candidates[0]);
  assert.equal(calls, 1);
  await queue.drain();
});

test("a rejected secondary is drained and propagated without an unhandled rejection", async () => {
  const queue = createReviewAttemptQueue(candidates, async candidate => {
    if (candidate.id === "b") throw new Error("release failed");
    return complete;
  }, true);
  await queue.run(candidates[0]);
  await assert.rejects(queue.run(candidates[1]), /release failed/);
  await queue.drain();
});
