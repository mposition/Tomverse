import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentIdentity,
  collapseRepeatedAttachments,
  REPEATED_ATTACHMENT_TURN_TEXT,
} from "../lib/chatRepeatedAttachments.ts";

const file = (attachmentId) => ({ attachmentId });
const user = (content, ...attachments) => ({
  role: "user",
  content,
  ...(attachments.length ? { attachments } : {}),
});
const reply = { role: "assistant", content: "" };

test("a transcript with no repeat is the same array", () => {
  const messages = [user("one", file("a")), reply, user("two", file("b"))];
  const result = collapseRepeatedAttachments(messages);
  assert.equal(result.messages, messages);
  assert.equal(result.removedReferenceCount, 0);
});

test("a repeat stays on the last message naming it and leaves the earlier ones", () => {
  const messages = [user("q", file("a")), reply, user("q", file("a")), reply, user("q", file("a"))];
  const result = collapseRepeatedAttachments(messages);
  assert.deepEqual(result.messages.map((message) => message.attachments), [
    [],
    undefined,
    [],
    undefined,
    [file("a")],
  ]);
  assert.equal(result.removedReferenceCount, 2);
  assert.deepEqual(messages[0].attachments, [file("a")], "the input is not mutated");
});

test("only the repeated files move; the order on the last message is untouched", () => {
  const messages = [
    user("q", file("a"), file("b")),
    reply,
    user("q", file("c"), file("a")),
  ];
  const result = collapseRepeatedAttachments(messages);
  assert.deepEqual(result.messages[0].attachments, [file("b")]);
  assert.deepEqual(result.messages[2].attachments, [file("c"), file("a")]);
  assert.equal(result.removedReferenceCount, 1);
});

test("a text follow-up after the repeats leaves one copy in the history", () => {
  const messages = [user("q", file("a")), reply, user("q", file("a")), reply, user("next")];
  const result = collapseRepeatedAttachments(messages);
  assert.deepEqual(result.messages.flatMap((message) => message.attachments ?? []), [file("a")]);
  assert.deepEqual(result.messages[2].attachments, [file("a")]);
});

test("an attachment-only question is not left empty for the provider", () => {
  const messages = [user("", file("a")), reply, user("", file("a"))];
  const result = collapseRepeatedAttachments(messages);
  assert.equal(result.messages[0].content, REPEATED_ATTACHMENT_TURN_TEXT);
  assert.equal(result.messages[2].content, "");
  assert.deepEqual(result.messages[2].attachments, [file("a")]);
});

test("a question with text keeps it, and a partly moved attachment-only one keeps its emptiness", () => {
  const result = collapseRepeatedAttachments([
    user("what is this", file("a")),
    reply,
    user("", file("b"), file("c")),
    reply,
    user("", file("a"), file("b")),
  ]);
  assert.equal(result.messages[0].content, "what is this");
  assert.equal(result.messages[2].content, "", "it still has a file of its own");
  assert.deepEqual(result.messages[2].attachments, [file("c")]);
});

test("a file named twice on one message leaves the whole request for the gate", () => {
  for (const messages of [
    [user("q", file("a"), file("a"))],
    [user("q", file("a"), file("a")), reply, user("q", file("a"))],
    [user("q", file("a")), reply, user("q", file("b"), file("b")), reply, user("q", file("a"))],
  ]) {
    const result = collapseRepeatedAttachments(messages);
    assert.equal(result.messages, messages);
    assert.equal(result.removedReferenceCount, 0);
  }
});

test("an inline copy anywhere leaves the whole request for the gate", () => {
  const messages = [
    user("q", { attachmentId: "a", data: "data:text/plain;base64,aGk=" }),
    reply,
    user("q", file("a")),
  ];
  assert.equal(collapseRepeatedAttachments(messages).messages, messages);
});

test("assistant copies are neither moved nor a reason to move a user's file", () => {
  const assistantCopy = { role: "assistant", content: "", attachments: [file("a")] };
  const messages = [user("q", file("a")), assistantCopy];
  const result = collapseRepeatedAttachments(messages);
  assert.equal(result.messages, messages);
  assert.deepEqual(result.messages[0].attachments, [file("a")]);
});

test("a guest's key is the identity, and different kinds of reference never match", () => {
  const key = { objectKey: "guest-attachments/owner/one" };
  assert.equal(attachmentIdentity(key), "k:guest-attachments/owner/one");
  assert.equal(
    collapseRepeatedAttachments([user("q", key), reply, user("q", key)]).removedReferenceCount,
    1
  );
  assert.equal(
    collapseRepeatedAttachments([
      user("q", { uploadId: "same" }),
      reply,
      user("q", { attachmentId: "same" }),
    ]).removedReferenceCount,
    0
  );
});

test("an attachment with no usable reference is left for the later checks to refuse", () => {
  const nameless = { name: "x.txt" };
  const messages = [user("q", nameless), reply, user("q", nameless)];
  assert.equal(collapseRepeatedAttachments(messages).messages, messages);
});
