import assert from "node:assert/strict";
import test from "node:test";

import {
  clearConfirmedIdeaRequest,
  clearPendingIdeaRequest,
  readConfirmedIdeaRequest,
  readPendingIdeaRequest,
  rememberConfirmedIdeaRequest,
  reservePendingIdeaRequest,
} from "../lib/amux/ideaSubmissionRecoveryCore.ts";

const firstId = "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0";
const secondId = "73e6bc36-8806-48a7-a41d-8356b622e7cb";
const store = () => {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
};

test("request id is persisted before POST and cannot be replaced until resolved", () => {
  const storage = store();
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-1"), { kind: "none" });
  assert.equal(reservePendingIdeaRequest(storage, "owner-1", firstId), true);
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-1"), { kind: "pending", requestId: firstId });
  assert.equal(reservePendingIdeaRequest(storage, "owner-1", secondId), false);
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-2"), { kind: "none" });
  assert.deepEqual([...storage.data.values()], [firstId], "only the opaque id reaches storage");
  clearPendingIdeaRequest(storage, "owner-1", secondId);
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-1"), { kind: "pending", requestId: firstId });
  clearPendingIdeaRequest(storage, "owner-1", firstId);
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-1"), { kind: "none" });
});

test("unavailable, corrupt and non-persisting browser storage fails closed", () => {
  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const noWrite = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.deepEqual(readPendingIdeaRequest(null, "owner-1"), { kind: "unavailable" });
  assert.deepEqual(readPendingIdeaRequest(throwing, "owner-1"), { kind: "unavailable" });
  assert.equal(reservePendingIdeaRequest(null, "owner-1", firstId), false);
  assert.equal(reservePendingIdeaRequest(throwing, "owner-1", firstId), false);
  assert.equal(reservePendingIdeaRequest(noWrite, "owner-1", firstId), false);
  const corrupt = store();
  corrupt.data.set("amux-v4-idea-unresolved-request:owner-1", "not-a-request-id");
  assert.deepEqual(readPendingIdeaRequest(corrupt, "owner-1"), { kind: "unavailable" });
  assert.equal(reservePendingIdeaRequest(corrupt, "owner-1", firstId), false);
});

test("confirmed request survives reload with no idea text and is reverified", () => {
  const storage = store();
  assert.equal(reservePendingIdeaRequest(storage, "owner-1", firstId), true);
  assert.equal(rememberConfirmedIdeaRequest(storage, "owner-1", firstId), true);
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-1"), { kind: "none" });
  assert.deepEqual(readConfirmedIdeaRequest(storage, "owner-1"),
    { kind: "confirmed", requestId: firstId });
  assert.deepEqual([...storage.data.values()], [firstId], "only an opaque request ID is retained");
  clearConfirmedIdeaRequest(storage, "owner-1", secondId);
  assert.deepEqual(readConfirmedIdeaRequest(storage, "owner-1"),
    { kind: "confirmed", requestId: firstId });
  clearConfirmedIdeaRequest(storage, "owner-1", firstId);
  assert.deepEqual(readConfirmedIdeaRequest(storage, "owner-1"), { kind: "none" });
});

test("failure to preserve a confirmed receipt keeps the unresolved receipt", () => {
  const storage = store();
  reservePendingIdeaRequest(storage, "owner-1", firstId);
  const noConfirm = { ...storage,
    setItem: (key, value) => { if (!key.includes("confirmed")) storage.setItem(key, value); },
  };
  assert.equal(rememberConfirmedIdeaRequest(noConfirm, "owner-1", firstId), false);
  assert.deepEqual(readPendingIdeaRequest(storage, "owner-1"),
    { kind: "pending", requestId: firstId });
});
