import assert from "node:assert/strict";
import test from "node:test";
import {
  chatLeaseAcquired,
  chatLeaseReleased,
  chatLeaseStreamPublished,
  chatLeaseTakenByStream,
  chatLeaseToReleaseOnUnwind,
  NO_CHAT_LEASE,
} from "../lib/chatLeaseOwnershipCore.ts";

const LEASE = "lease_01H8XABCDEF";

test("a request that never reached a grant has nothing to release", () => {
  assert.equal(chatLeaseToReleaseOnUnwind(NO_CHAT_LEASE), null);
});

test("a request holding its own slot releases it when it unwinds", () => {
  const held = chatLeaseAcquired(LEASE);
  assert.deepEqual(chatLeaseToReleaseOnUnwind(held), {
    leaseId: LEASE,
    reason: "request_failed_before_stream",
  });
});

test("a stream built but never published is the request's to release", () => {
  // The regression this exists for: between taking the source reader and
  // returning the Response, the stream owns the slot and cannot free it,
  // because nothing will ever pull it. Reading "the request no longer holds
  // it" as "someone else will" left the slot until its TTL lapsed, and the
  // person who owns it was told a response was already being generated.
  const taken = chatLeaseTakenByStream(chatLeaseAcquired(LEASE));
  assert.equal(taken.holder, "unstarted_stream");
  assert.deepEqual(chatLeaseToReleaseOnUnwind(taken), {
    leaseId: LEASE,
    reason: "stream_never_started",
  });
});

test("the two failure reasons are distinct, because the incidents are", () => {
  const held = chatLeaseAcquired(LEASE);
  const taken = chatLeaseTakenByStream(held);
  assert.notEqual(
    chatLeaseToReleaseOnUnwind(held).reason,
    chatLeaseToReleaseOnUnwind(taken).reason
  );
});

test("a published stream owns its own slot and is not released twice", () => {
  const published = chatLeaseStreamPublished(
    chatLeaseTakenByStream(chatLeaseAcquired(LEASE))
  );
  assert.equal(published.holder, "stream");
  assert.equal(published.leaseId, LEASE);
  assert.equal(chatLeaseToReleaseOnUnwind(published), null);
});

test("a handed-off or released slot is never released again", () => {
  const gone = chatLeaseReleased();
  assert.equal(gone.leaseId, null);
  assert.equal(chatLeaseToReleaseOnUnwind(gone), null);
  // Deep research reaches the same state from a held slot: the route releases
  // it because the polling job outlives any lease, and once here nothing
  // releases it a second time.
});

test("out-of-order transitions cannot resurrect a released slot", () => {
  const gone = chatLeaseReleased();
  for (const next of [
    chatLeaseTakenByStream(gone),
    chatLeaseStreamPublished(gone),
    chatLeaseStreamPublished(chatLeaseTakenByStream(gone)),
  ]) {
    assert.equal(next.holder, "gone");
    assert.equal(chatLeaseToReleaseOnUnwind(next), null);
  }
  // Publishing without ever taking the reader is a no-op too: the request is
  // still the holder, so its unwind path still frees the slot.
  const held = chatLeaseAcquired(LEASE);
  assert.deepEqual(chatLeaseStreamPublished(held), held);
  assert.deepEqual(chatLeaseToReleaseOnUnwind(chatLeaseStreamPublished(held)), {
    leaseId: LEASE,
    reason: "request_failed_before_stream",
  });
});

test("every transition is a new value, so a stale read cannot be revived", () => {
  const held = chatLeaseAcquired(LEASE);
  const taken = chatLeaseTakenByStream(held);
  const published = chatLeaseStreamPublished(taken);
  assert.equal(held.holder, "request");
  assert.equal(taken.holder, "unstarted_stream");
  assert.equal(published.holder, "stream");
});
