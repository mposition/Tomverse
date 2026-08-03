import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelSettingsSyncQueue,
  modelSettingsSnapshotsEqual,
} from "../lib/modelSettingsSyncQueue.ts";

// Regression harness for the MODEL_NOT_SELECTED sync race (trace
// 5dc1d2ee-6c98-44fa-8b6f-03d798c3f011): the old debounce-and-abort sync let
// an older selectedModels PATCH commit after a newer one, and its flush
// treated "no pending request" as "the server has my state". These tests pin
// the queue's structural guarantees: serialized non-overlapping writes,
// coalescing to the newest desired snapshot, a barrier that only resolves on
// real server confirmation, per-conversation isolation, and safe recovery to
// the confirmed state on permanent failure.

const snap = (models, disabled = []) => ({ models, disabled });

/**
 * A persist spy whose completion order the test controls. Each call records
 * (conversationId, snapshot) and returns a promise the test resolves.
 */
const createManualPersist = () => {
  const calls = [];
  const persist = (conversationId, snapshot) =>
    new Promise((resolve) => {
      calls.push({
        conversationId,
        snapshot,
        succeed: (confirmed) =>
          resolve({ ok: true, confirmed: confirmed ?? snapshot }),
        fail: (retryable = false, traceId) =>
          resolve({ ok: false, retryable, traceId }),
      });
    });
  return { calls, persist };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("writes for one conversation never overlap, and coalesce to the newest snapshot", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.enqueue("conv", snap(["model-b"]));
  await tick();
  assert.equal(calls.length, 1, "first change starts one write");

  // Two further changes while the first write is still running: they must
  // not start their own overlapping requests.
  queue.enqueue("conv", snap(["model-b", "model-c"]));
  queue.enqueue("conv", snap(["model-c"]));
  await tick();
  assert.equal(calls.length, 1, "no overlapping write was started");

  // The first (slow) write completes only now -- with the old abort-based
  // sync this is exactly the window where its stale payload could commit
  // after the newer one. Here the newer state has not even been sent yet.
  calls[0].succeed();
  await tick();
  assert.equal(calls.length, 2, "the queued changes were coalesced into one write");
  assert.deepEqual(
    calls[1].snapshot.models,
    ["model-c"],
    "the follow-up write carries the newest desired snapshot, not an intermediate one"
  );

  calls[1].succeed();
  await tick();
  assert.deepEqual(queue.confirmedSnapshot("conv").models, ["model-c"]);
  assert.equal(queue.hasUnconfirmedChanges("conv"), false);
});

test("ensureConfirmed waits for the in-flight write instead of trusting 'no pending request'", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.enqueue("conv", snap(["model-b"]));
  await tick();
  assert.equal(calls.length, 1);

  let settled = null;
  queue.ensureConfirmed("conv", snap(["model-b"])).then((outcome) => {
    settled = outcome;
  });
  await tick();
  assert.equal(settled, null, "the barrier must not resolve before the server confirms");

  calls[0].succeed();
  await tick();
  assert.equal(settled?.status, "confirmed");
  assert.deepEqual(settled.confirmed.models, ["model-b"]);
});

test("ensureConfirmed resolves immediately when the snapshot is already confirmed, without a write", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.markConfirmed("conv", snap(["model-a"]));
  const outcome = await queue.ensureConfirmed("conv", snap(["model-a"]));
  assert.equal(outcome.status, "confirmed");
  assert.equal(calls.length, 0, "an already-confirmed snapshot needs no PATCH");
});

test("ensureConfirmed flushes a debounced write immediately", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({
    persist,
    debounceMs: 60_000,
    retryDelayMs: 0,
  });

  queue.enqueue("conv", snap(["model-b"]));
  await tick();
  assert.equal(calls.length, 0, "the debounce is holding the write back");

  const pending = queue.ensureConfirmed("conv", snap(["model-b"]));
  await tick();
  assert.equal(calls.length, 1, "a send must not wait out the debounce");
  calls[0].succeed();
  assert.equal((await pending).status, "confirmed");
});

test("the confirmed state is the server's normalized answer, not the client's payload", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  const pending = queue.ensureConfirmed("conv", snap(["model-b", "model-x"]));
  await tick();
  // The server dropped model-x (e.g. it was just disabled).
  calls[0].succeed(snap(["model-b"]));
  const outcome = await pending;
  assert.equal(outcome.status, "confirmed");
  assert.deepEqual(outcome.confirmed.models, ["model-b"]);
  assert.deepEqual(queue.confirmedSnapshot("conv").models, ["model-b"]);
});

test("a permanent failure fails the barrier with a trace id and recovers desired to confirmed", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.markConfirmed("conv", snap(["model-a"]));
  const pending = queue.ensureConfirmed("conv", snap(["model-b"]));
  await tick();
  calls[0].fail(false, "trace-42");

  const outcome = await pending;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.traceId, "trace-42");
  assert.deepEqual(outcome.confirmed.models, ["model-a"]);
  assert.equal(queue.hasUnconfirmedChanges("conv"), false);

  // After recovery the abandoned snapshot is not silently retried: only the
  // confirmed state is accepted without a new write.
  const recovered = await queue.ensureConfirmed("conv", snap(["model-a"]));
  assert.equal(recovered.status, "confirmed");
  assert.equal(calls.length, 1, "no retry loop for the refused snapshot");
});

test("a retryable failure is retried exactly once", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  const pending = queue.ensureConfirmed("conv", snap(["model-b"]));
  await tick();
  calls[0].fail(true);
  await tick();
  assert.equal(calls.length, 2, "one retry for a retryable failure");
  calls[1].succeed();
  assert.equal((await pending).status, "confirmed");
});

test("a change made during a permanently failing write is still written afterwards", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.enqueue("conv", snap(["model-b"]));
  await tick();
  queue.enqueue("conv", snap(["model-c"]));
  calls[0].fail(false);
  await tick();
  assert.equal(calls.length, 2, "the newer change still gets its own write");
  assert.deepEqual(calls[1].snapshot.models, ["model-c"]);
  calls[1].succeed();
  await tick();
  assert.deepEqual(queue.confirmedSnapshot("conv").models, ["model-c"]);
});

test("one conversation's pending write neither blocks nor cancels another conversation's", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.enqueue("conv-a", snap(["model-b"]));
  await tick();
  assert.equal(calls.length, 1);

  // Conversation B confirms while A's write is still hanging.
  const pendingB = queue.ensureConfirmed("conv-b", snap(["model-z"]));
  await tick();
  assert.equal(calls.length, 2, "conversation B got its own write immediately");
  assert.equal(calls[1].conversationId, "conv-b");
  calls[1].succeed();
  assert.equal((await pendingB).status, "confirmed");

  // A's write was neither cancelled nor redirected.
  assert.equal(queue.hasUnconfirmedChanges("conv-a"), true);
  calls[0].succeed();
  await tick();
  assert.deepEqual(queue.confirmedSnapshot("conv-a").models, ["model-b"]);
});

test("markConfirmed refuses a stale server read while local changes are unconfirmed", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.enqueue("conv", snap(["model-b"]));
  await tick();

  // A conversation-detail GET that started before the change lands now.
  assert.equal(
    queue.markConfirmed("conv", snap(["model-a"])),
    false,
    "the late read must not overwrite the in-flight change"
  );

  calls[0].succeed();
  await tick();
  assert.deepEqual(queue.confirmedSnapshot("conv").models, ["model-b"]);

  // Once nothing is pending, a server read may seed the confirmed state.
  assert.equal(queue.markConfirmed("conv", snap(["model-b"])), true);
});

test("identical repeated enqueues do not schedule duplicate writes", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  queue.markConfirmed("conv", snap(["model-a"]));
  queue.enqueue("conv", snap(["model-a"]));
  queue.enqueue("conv", snap(["model-a"]));
  await tick();
  assert.equal(calls.length, 0, "re-asserting the confirmed state writes nothing");
});

test("localRevision exposes when a read raced a local change -- even one already confirmed", async () => {
  const { calls, persist } = createManualPersist();
  const queue = createModelSettingsSyncQueue({ persist, retryDelayMs: 0 });

  // A conversation-detail GET captures the revision as it starts.
  const revisionAtFetchStart = queue.localRevision("conv");

  // The user changes models while that GET is in flight, and the PATCH even
  // completes before the GET response lands.
  queue.enqueue("conv", snap(["model-b"]));
  await tick();
  calls[0].succeed();
  await tick();
  assert.equal(queue.hasUnconfirmedChanges("conv"), false);

  // The GET response now predates the change: the revision compare is what
  // still detects that, where a pending-only check no longer can.
  assert.notEqual(queue.localRevision("conv"), revisionAtFetchStart);
});

test("snapshot equality is order-sensitive for models and covers disabled panels", () => {
  assert.equal(
    modelSettingsSnapshotsEqual(snap(["a", "b"]), snap(["a", "b"])),
    true
  );
  assert.equal(
    modelSettingsSnapshotsEqual(snap(["a", "b"]), snap(["b", "a"])),
    false
  );
  assert.equal(
    modelSettingsSnapshotsEqual(snap(["a"], ["a"]), snap(["a"])),
    false
  );
  assert.equal(modelSettingsSnapshotsEqual(null, snap(["a"])), false);
});
