import assert from "node:assert/strict";
import test from "node:test";

import { replacedMessageIndexes } from "../lib/chatSupersededAlignment.ts";

const row = (id, role, content, replaced = false) => ({ id, role, content, replaced });
const said = (role, content, id) => (id ? { id, role, content } : { role, content });
const sameId = (messageId, rowId) => messageId === rowId;
const dropped = (messages, rows, maxCells) => [...replacedMessageIndexes(messages, rows, sameId, maxCells)].sort((a, b) => a - b);

// A regenerate: the same question asked again, a different answer.
const regenerated = [
  row("q1", "user", "Q", true),
  row("a1", "assistant", "OLD", true),
  row("q2", "user", "Q"),
  row("a2", "assistant", "NEW"),
];

test("an id-less transcript loses the replaced turn, not the question asked again", () => {
  const messages = [said("user", "Q"), said("assistant", "OLD"), said("user", "Q"), said("assistant", "NEW"), said("user", "next")];
  assert.deepEqual(dropped(messages, regenerated), [0, 1]);
});

test("a client that already left the replaced turn out loses nothing more", () => {
  const messages = [said("user", "Q"), said("assistant", "NEW"), said("user", "next")];
  assert.deepEqual(dropped(messages, regenerated), []);
});

test("the same question asked earlier in the ordinary way stays", () => {
  const rows = [row("q0", "user", "Q"), row("a0", "assistant", "FIRST"), ...regenerated];
  const whole = [
    said("user", "Q"), said("assistant", "FIRST"),
    said("user", "Q"), said("assistant", "OLD"),
    said("user", "Q"), said("assistant", "NEW"),
    said("user", "next"),
  ];
  assert.deepEqual(dropped(whole, rows), [2, 3]);
  // Sent without the replaced turn, the earlier ordinary question is not taken for it.
  const filtered = [said("user", "Q"), said("assistant", "FIRST"), said("user", "Q"), said("assistant", "NEW"), said("user", "next")];
  assert.deepEqual(dropped(filtered, rows), []);
});

test("the turn this request replaces, not yet marked, leaves too", () => {
  const rows = [row("q1", "user", "Q", true), row("a1", "assistant", "OLD", true)];
  // The regenerate request itself: the old turn, then the question again.
  assert.deepEqual(dropped([said("user", "Q"), said("assistant", "OLD"), said("user", "Q")], rows), [0, 1]);
});

test("a message named by id is its row's; the message being answered never leaves", () => {
  const messages = [said("user", "Q", "q1"), said("assistant", "OLD", "a1"), said("user", "Q", "q2"), said("assistant", "NEW", "a2"), said("user", "Q")];
  assert.deepEqual(dropped(messages, regenerated), [0, 1]);
  // Even when the last message is text-identical to a replaced row (and the
  // question before it lines up with the standing one).
  assert.ok(!dropped([said("user", "Q"), said("assistant", "OLD")], regenerated).includes(1));
  assert.ok(!dropped([said("user", "x"), said("user", "Q")], [row("q1", "user", "Q", true)]).includes(1));
  assert.deepEqual(dropped([said("user", "only")], regenerated), []);
});

test("above the size limit only ids decide", () => {
  const messages = [said("user", "Q", "q1"), said("assistant", "OLD"), said("user", "next")];
  assert.deepEqual(dropped(messages, regenerated, 1), [0]);
  assert.deepEqual(dropped(messages, regenerated), [0, 1]);
});
