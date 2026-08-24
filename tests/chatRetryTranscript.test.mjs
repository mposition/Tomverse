import { strict as assert } from "node:assert";
import test from "node:test";

import { transcriptBeforeSend } from "../lib/chatRetryTranscript.ts";

/**
 * A retry rebuilds its turn; it does not add one.
 *
 * The panel keeps the failed user turn on screen deliberately -- the draft and
 * the attachment cards live in it -- and puts the error in the assistant turn
 * beneath. Retrying under a fresh message id left both and appended a second
 * copy of the question, which named the same upload twice and had `/api/chat`
 * refuse the transcript outright.
 */

const turn = (id, role = "user") => ({ id, role });

test("a first send drops nothing", () => {
  const messages = [turn("u1"), turn("a1", "assistant")];
  assert.deepEqual(transcriptBeforeSend(messages, "u2"), messages);
});

test("a retry drops its own turn and the error beneath it", () => {
  // What the request body is built from: the failed exchange is gone, so the
  // attachment it carried is named once, by the turn being rebuilt.
  const messages = [
    turn("u1"),
    turn("a1", "assistant"),
    turn("u2"),
    turn("a2", "assistant"),
  ];
  assert.deepEqual(transcriptBeforeSend(messages, "u2"), [
    turn("u1"),
    turn("a1", "assistant"),
  ]);
});

test("retrying twice converges rather than accumulating", () => {
  // The second press sees the transcript the first press produced. If this
  // returned anything but the same prefix, each retry would add a turn and the
  // duplicate refusal would come back.
  const first = transcriptBeforeSend(
    [turn("u1"), turn("a1", "assistant"), turn("u2"), turn("a2", "assistant")],
    "u2"
  );
  const rebuilt = [...first, turn("u2"), turn("a3", "assistant")];
  assert.deepEqual(transcriptBeforeSend(rebuilt, "u2"), first);
});

test("the earliest turn can be retried", () => {
  assert.deepEqual(
    transcriptBeforeSend([turn("u1"), turn("a1", "assistant")], "u1"),
    []
  );
});

test("the input is not mutated", () => {
  const messages = [turn("u1"), turn("a1", "assistant"), turn("u2")];
  const before = [...messages];
  transcriptBeforeSend(messages, "u2");
  assert.deepEqual(messages, before);
});

test("an empty transcript is returned as a fresh array", () => {
  const messages = [];
  const result = transcriptBeforeSend(messages, "u1");
  assert.deepEqual(result, []);
  assert.notEqual(result, messages, "the caller spreads the result and appends");
});
