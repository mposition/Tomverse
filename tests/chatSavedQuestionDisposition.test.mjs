import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SAVED_QUESTION_NOT_SENT_LIMIT,
  SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY,
  SAVED_QUESTION_NOT_SENT_STORAGE_KEY,
  addSavedQuestionNotSentKey,
  bindSavedQuestionNotSentOwner,
  clearSavedQuestionNotSentKeys,
  consumeSavedQuestionNotSentPrefix,
  removeSavedQuestionNotSentKey,
  setBoundedMapEntry,
} from "../lib/chatSavedQuestionDisposition.ts";

const storageFixture = (initial = [], owner = null) => {
  const values = new Map();
  if (initial.length > 0) {
    values.set(SAVED_QUESTION_NOT_SENT_STORAGE_KEY, JSON.stringify(initial));
  }
  if (owner) values.set(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY, owner);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    keys: () => JSON.parse(values.get(SAVED_QUESTION_NOT_SENT_STORAGE_KEY) ?? "[]"),
    owner: () => values.get(SAVED_QUESTION_NOT_SENT_OWNER_STORAGE_KEY) ?? null,
  };
};

test("adding before local hydration preserves dispositions already in storage", () => {
  const a = "account:a\0conversation-a\0turn-a";
  const b = "account:a\0conversation-b\0turn-b";
  const storage = storageFixture([a]);
  const memory = new Set();

  addSavedQuestionNotSentKey(memory, storage, b);

  assert.deepEqual(storage.keys(), [a, b]);
  assert.deepEqual([...memory], [a, b]);
});

test("a stale memory snapshot cannot resurrect a consumed disposition", () => {
  const consumed = "account:a\0conversation-a\0turn-a";
  const current = "account:a\0conversation-b\0turn-b";
  const late = "account:a\0conversation-c\0turn-c";
  const storage = storageFixture([current]);
  const staleMemory = new Set([consumed]);

  addSavedQuestionNotSentKey(staleMemory, storage, late);

  assert.deepEqual(storage.keys(), [current, late]);
  assert.equal(staleMemory.has(consumed), false);
});

test("malformed readable storage does not revive stale memory", () => {
  const values = new Map([[SAVED_QUESTION_NOT_SENT_STORAGE_KEY, "not-json"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const memory = new Set(["account:a\0conversation-old\0turn-old"]);
  const current = "account:a\0conversation-new\0turn-new";
  addSavedQuestionNotSentKey(memory, storage, current);
  assert.deepEqual(
    JSON.parse(values.get(SAVED_QUESTION_NOT_SENT_STORAGE_KEY)),
    [current]
  );
  assert.deepEqual([...memory], [current]);
});

test("storage and memory remain bounded to the newest 64 opaque keys", () => {
  const storage = storageFixture();
  const memory = new Set();
  for (let index = 0; index < 80; index += 1) {
    addSavedQuestionNotSentKey(
      memory,
      storage,
      `account:a\0conversation-a\0turn-${index}`
    );
  }

  assert.equal(memory.size, SAVED_QUESTION_NOT_SENT_LIMIT);
  assert.equal(storage.keys().length, SAVED_QUESTION_NOT_SENT_LIMIT);
  assert.equal(memory.has("account:a\0conversation-a\0turn-15"), false);
  assert.equal(memory.has("account:a\0conversation-a\0turn-16"), true);
});

test("consume and provider-start removal apply to the exact latest storage set", () => {
  const a1 = "account:a\0conversation-a\0turn-1";
  const a2 = "account:a\0conversation-a\0turn-2";
  const b1 = "account:a\0conversation-b\0turn-1";
  const storage = storageFixture([a1, a2, b1]);
  const memory = new Set(["stale"]);

  assert.equal(
    consumeSavedQuestionNotSentPrefix(memory, storage, "account:a", "conversation-a"),
    true
  );
  assert.deepEqual(storage.keys(), [b1]);
  assert.equal(removeSavedQuestionNotSentKey(memory, storage, b1), true);
  assert.deepEqual(storage.keys(), []);
  assert.deepEqual([...memory], []);
});

test("consume preserves the exact disposition for a still-mounted undispatched payload", () => {
  const protectedKey = "account:a\0conversation-a\0turn-active";
  const abandonedKey = "account:a\0conversation-a\0turn-abandoned";
  const storage = storageFixture([protectedKey, abandonedKey]);
  const memory = new Set();

  assert.equal(
    consumeSavedQuestionNotSentPrefix(
      memory,
      storage,
      "account:a",
      "conversation-a",
      protectedKey
    ),
    true
  );
  assert.deepEqual(storage.keys(), [protectedKey]);
  assert.deepEqual([...memory], [protectedKey]);
  assert.equal(
    consumeSavedQuestionNotSentPrefix(
      memory,
      storage,
      "account:a",
      "conversation-a",
      protectedKey
    ),
    false
  );
});

test("identity clear never merges a stale storage value", () => {
  const storage = storageFixture(["account:a\0conversation-a\0turn-1"]);
  const memory = new Set(["memory-only"]);
  clearSavedQuestionNotSentKeys(memory, storage);
  assert.deepEqual(storage.keys(), []);
  assert.equal(memory.size, 0);
});

test("the pending registry evicts oldest entries deterministically", () => {
  const pending = new Map();
  for (let index = 0; index < 80; index += 1) {
    setBoundedMapEntry(pending, `turn-${index}`, { index });
  }
  assert.equal(pending.size, SAVED_QUESTION_NOT_SENT_LIMIT);
  assert.equal(pending.has("turn-15"), false);
  assert.deepEqual(pending.get("turn-16"), { index: 16 });
});

test("a same-identity full reload preserves opaque dispositions", () => {
  const key = "account:a\0conversation-a\0turn-a";
  const storage = storageFixture([key], "account:a");
  const memory = new Set();

  assert.equal(bindSavedQuestionNotSentOwner(memory, storage, "account:a"), true);
  assert.deepEqual(storage.keys(), [key]);
  assert.equal(storage.owner(), "account:a");
});

test("a different-identity full mount clears dispositions and rebinds owner", () => {
  const storage = storageFixture(
    ["account:a\0conversation-a\0turn-a"],
    "account:a"
  );
  const memory = new Set(["stale-memory"]);

  assert.equal(bindSavedQuestionNotSentOwner(memory, storage, "account:b"), false);
  assert.deepEqual(storage.keys(), []);
  assert.equal(storage.owner(), "account:b");
  assert.equal(memory.size, 0);
});

test("an unowned or oversized owner marker fails closed", () => {
  const storage = storageFixture(["account:a\0conversation-a\0turn-a"]);
  const memory = new Set(["stale-memory"]);

  assert.equal(bindSavedQuestionNotSentOwner(memory, storage, "x".repeat(257)), false);
  assert.deepEqual(storage.keys(), []);
  assert.equal(storage.owner(), null);
  assert.equal(memory.size, 0);
});
