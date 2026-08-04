import assert from "node:assert/strict";
import test from "node:test";
import { createSharedPendingRequest } from "../lib/sharedPendingRequest.ts";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("simultaneous callers share one run", async () => {
  // The case this exists for: three comparison panels refused at the same
  // moment, all asking for a fresh context. Three preparations would put them
  // on three snapshots, which is the thing sharing a bundle prevents.
  const shared = createSharedPendingRequest();
  const gate = deferred();
  const results = Promise.all([
    shared.run("prompt-1", () => gate.promise),
    shared.run("prompt-1", () => gate.promise),
    shared.run("prompt-1", () => gate.promise),
  ]);
  gate.resolve("bundle-a");
  assert.deepEqual(await results, ["bundle-a", "bundle-a", "bundle-a"]);
  assert.equal(shared.runCount(), 1);
});

test("a late caller gets the answer its siblings already have", async () => {
  const shared = createSharedPendingRequest();
  assert.equal(await shared.run("prompt-1", async () => "bundle-a"), "bundle-a");
  assert.equal(
    await shared.run("prompt-1", async () => "bundle-b"),
    "bundle-a"
  );
  assert.equal(shared.runCount(), 1);
});

test("different keys are different runs", async () => {
  const shared = createSharedPendingRequest();
  assert.equal(await shared.run("prompt-1", async () => "a"), "a");
  assert.equal(await shared.run("prompt-2", async () => "b"), "b");
  assert.equal(shared.runCount(), 2);
});

test("a failure is not remembered", async () => {
  // A preparation that failed on the network says nothing about the next
  // attempt; caching the rejection would make one bad moment permanent.
  const shared = createSharedPendingRequest();
  await assert.rejects(
    shared.run("prompt-1", async () => {
      throw new Error("offline");
    })
  );
  assert.equal(await shared.run("prompt-1", async () => "recovered"), "recovered");
  assert.equal(shared.runCount(), 2);
});

test("every simultaneous caller sees the same failure", async () => {
  const shared = createSharedPendingRequest();
  const gate = deferred();
  const first = shared.run("prompt-1", () => gate.promise);
  const second = shared.run("prompt-1", () => gate.promise);
  gate.reject(new Error("offline"));
  await assert.rejects(first, /offline/);
  await assert.rejects(second, /offline/);
  assert.equal(shared.runCount(), 1);
});

test("forgetting a key lets the next caller run again", async () => {
  const shared = createSharedPendingRequest();
  assert.equal(await shared.run("prompt-1", async () => "a"), "a");
  shared.forget("prompt-1");
  assert.equal(await shared.run("prompt-1", async () => "b"), "b");
  assert.equal(shared.runCount(), 2);
});

test("a null answer is still an answer and is shared", async () => {
  // "No recovery is available" has to be shared too -- otherwise each panel
  // re-asks and the run makes one preparation attempt per panel after all.
  const shared = createSharedPendingRequest();
  assert.equal(await shared.run("prompt-1", async () => null), null);
  assert.equal(await shared.run("prompt-1", async () => "late"), null);
  assert.equal(shared.runCount(), 1);
});
