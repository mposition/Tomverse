import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  armSupersede,
  beginReplacement,
  canEditQuestion,
  getSupersededIds,
  lastReplaceableTurn,
  markTurnSuperseded,
  parkReplacement,
  resetSupersededForTests,
  settleParkedReplacement,
  subscribeSuperseded,
  takeArmedSupersede,
  withoutSuperseded,
} from "../lib/chatSupersededTurns.ts";
import { decideArmedRegenerate } from "../lib/chatRegenerateArm.ts";

const user = (id, content = "question", extra = {}) => ({ id, role: "user", content, ...extra });
const answer = (id, extra = {}) => ({ id, role: "assistant", content: "answer", status: "normal", ...extra });

test("the newest finished question and answer can be replaced", () => {
  const turn = lastReplaceableTurn([user("u0"), answer("a0"), user("u1"), answer("a1")]);
  assert.equal(turn?.question.id, "u1");
  assert.equal(turn?.answer.id, "a1");
  assert.equal(canEditQuestion(turn), true);
  assert.ok(lastReplaceableTurn([user("u1"), answer("a1", { status: "incomplete" })]));
});

test("failed, stopped, empty, image, research and imported answers have their own controls", () => {
  for (const extra of [
    { status: "error" },
    { status: "cancelled" },
    { status: "pending" },
    { content: "  " },
    { imageTurn: { groupId: "g", modelIds: [] } },
    { researchRunId: "r" },
    { pendingJobId: "j" },
    { carriedAnswer: true },
    { imported: { provider: "chatgpt" } },
  ]) {
    assert.equal(lastReplaceableTurn([user("u1"), answer("a1", extra)]), null, JSON.stringify(extra));
  }
  // The answer must follow a question, and be the last message.
  assert.equal(lastReplaceableTurn([answer("a1")]), null);
  assert.equal(lastReplaceableTurn([user("u1")]), null);
  assert.equal(lastReplaceableTurn([user("u1"), answer("a1"), user("u2")]), null);
  assert.equal(lastReplaceableTurn([user("u1", "q", { imported: { provider: "chatgpt" } }), answer("a1")]), null);
});

test("a question that carried files is not editable", () => {
  const withFile = lastReplaceableTurn([
    user("u1", "see file", { attachments: [{ id: "f", name: "f.pdf", mediaType: "application/pdf", size: 1 }] }),
    answer("a1"),
  ]);
  assert.ok(withFile);
  assert.equal(canEditQuestion(withFile), false);
});

test("replaced turns drop out of the request and persist per conversation", () => {
  resetSupersededForTests();
  assert.equal(getSupersededIds("c1").size, 0);
  markTurnSuperseded("c1", ["u1", "a1"]);
  markTurnSuperseded("c1", ["u2"]);
  assert.deepEqual([...getSupersededIds("c1")].sort(), ["a1", "u1", "u2"]);
  assert.equal(getSupersededIds("c2").size, 0);
  const messages = [{ id: "u1" }, { id: "a1" }, { id: "u3" }];
  assert.deepEqual(withoutSuperseded(messages, getSupersededIds("c1")).map((m) => m.id), ["u3"]);
  assert.deepEqual(withoutSuperseded(messages, new Set()).map((m) => m.id), ["u1", "a1", "u3"]);
});

test("a replacement is recorded only by the send that carries the same question", () => {
  resetSupersededForTests();
  armSupersede("c1", "  same question ", ["u1", "a1"], 1_000);
  assert.deepEqual(takeArmedSupersede("c1", "same question", 2_000), ["u1", "a1"]);
  // Consumed once.
  assert.equal(takeArmedSupersede("c1", "same question", 2_100), null);

  armSupersede("c1", "same question", ["u1", "a1"], 1_000);
  assert.equal(takeArmedSupersede("c1", "another question", 1_500), null);

  armSupersede("c1", "same question", ["u1", "a1"], 1_000);
  assert.equal(takeArmedSupersede("c2", "same question", 1_500), null);

  // A send that never started does not linger.
  armSupersede("c1", "same question", ["u1", "a1"], 1_000);
  assert.equal(takeArmedSupersede("c1", "same question", 1_000 + 21_000), null);
});

test("another model: fire only when the model really changes while the wait is live", () => {
  const armed = { armedModelId: "m1", armedAt: 1_000 };
  assert.equal(decideArmedRegenerate({ ...armed, currentModelId: "m1", now: 2_000 }), "wait");
  assert.equal(decideArmedRegenerate({ ...armed, currentModelId: "m2", now: 2_000 }), "fire");
  assert.equal(decideArmedRegenerate({ ...armed, currentModelId: null, now: 2_000 }), "wait");
  assert.equal(decideArmedRegenerate({ ...armed, currentModelId: "m2", now: 1_000 + 61_000 }), "expire");
  assert.equal(decideArmedRegenerate({ ...armed, currentModelId: "m1", now: 1_000 + 61_000 }), "expire");
});

test("another model: closing the picker ends the wait, a later pick sends nothing", () => {
  const armed = { armedModelId: "m1", armedAt: 1_000, currentModelId: "m1" };
  // Picker still open: keep waiting.
  assert.equal(decideArmedRegenerate({ ...armed, now: 5_000, pickerClosedAt: null }), "wait");
  // A pick that closes the picker in the same click still fires.
  assert.equal(
    decideArmedRegenerate({ ...armed, currentModelId: "m2", now: 5_100, pickerClosedAt: 5_000 }),
    "fire"
  );
  // Closed without a change: the wait is over after the grace, well before the TTL.
  assert.equal(decideArmedRegenerate({ ...armed, now: 5_100, pickerClosedAt: 5_000 }), "wait");
  assert.equal(decideArmedRegenerate({ ...armed, now: 6_000, pickerClosedAt: 5_000 }), "expire");
  // A model picked later from the ordinary picker must not resend the question.
  assert.equal(
    decideArmedRegenerate({ ...armed, currentModelId: "m2", now: 20_000, pickerClosedAt: 5_000 }),
    "expire"
  );
});

test("a replacement is recorded only once the new answer is written as finished", () => {
  resetSupersededForTests();
  // The request leaves the replaced turn out at once.
  const failed = beginReplacement("c1", ["u1", "a1"]);
  assert.deepEqual([...failed.excludedIds()].sort(), ["a1", "u1"]);
  // Refused, failed or stopped: nothing is recorded and the earlier answer stands.
  for (const status of ["pending", "error", "cancelled", undefined]) failed.complete(status);
  assert.equal(getSupersededIds("c1").size, 0);

  const done = beginReplacement("c1", ["u1", "a1"]);
  done.complete("pending");
  assert.equal(getSupersededIds("c1").size, 0);
  done.complete("normal");
  assert.deepEqual([...getSupersededIds("c1")].sort(), ["a1", "u1"]);

  // A cut-off answer still counts as the replacement, and an ordinary send changes nothing.
  const cutOff = beginReplacement("c2", ["u2", "a2"]);
  cutOff.complete("incomplete");
  assert.deepEqual([...getSupersededIds("c2")].sort(), ["a2", "u2"]);
  const ordinary = beginReplacement("c3", null);
  ordinary.complete("normal");
  assert.equal(getSupersededIds("c3").size, 0);
});

test("two tabs share the replaced-turn note instead of overwriting each other", () => {
  const listeners = new Set();
  const data = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
    },
    addEventListener: (type, fn) => type === "storage" && listeners.add(fn),
    removeEventListener: (type, fn) => type === "storage" && listeners.delete(fn),
  };
  try {
    resetSupersededForTests();
    let notified = 0;
    const unsubscribe = subscribeSuperseded(() => {
      notified += 1;
    });
    assert.equal(listeners.size, 1);
    assert.equal(getSupersededIds("c1").size, 0);

    // Another tab replaces a turn and saves; this tab hears about it.
    data.set("tomverse:superseded-turns:v1", JSON.stringify({ c1: ["u1", "a1"] }));
    for (const fn of listeners) fn({ key: "tomverse:superseded-turns:v1" });
    assert.equal(notified, 1);
    assert.deepEqual([...getSupersededIds("c1")].sort(), ["a1", "u1"]);
    // An unrelated key, or news this tab already has, changes nothing.
    for (const fn of listeners) fn({ key: "other" });
    for (const fn of listeners) fn({ key: "tomverse:superseded-turns:v1" });
    assert.equal(notified, 1);

    // This tab saves without having heard about a newer write: nothing is lost.
    data.set("tomverse:superseded-turns:v1", JSON.stringify({ c1: ["u1", "a1", "u2", "a2"], c2: ["x"] }));
    markTurnSuperseded("c1", ["u3"]);
    const saved = JSON.parse(data.get("tomverse:superseded-turns:v1"));
    assert.deepEqual([...saved.c1].sort(), ["a1", "a2", "u1", "u2", "u3"]);
    assert.deepEqual(saved.c2, ["x"]);

    // A send reads the newest note before it builds its request.
    data.set("tomverse:superseded-turns:v1", JSON.stringify({ c1: ["u1", "a1", "u2", "a2", "u3", "u4"], c2: ["x"] }));
    assert.ok(beginReplacement("c1", null).excludedIds().has("u4"));

    unsubscribe();
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.window = previousWindow;
    resetSupersededForTests();
  }
});

test("nothing is recorded before the answer is reported finished", () => {
  resetSupersededForTests();
  // Streaming progress writes carry "normal" too; only `complete` records, so
  // a send that is interrupted after the first chunk restores the old turn.
  const interrupted = beginReplacement("c1", ["u1", "a1"]);
  interrupted.excludedIds();
  assert.equal(getSupersededIds("c1").size, 0);
  settleParkedReplacement("never-parked", "normal");
  assert.equal(getSupersededIds("c1").size, 0);
});

test("a durable attempt records the replacement from every place it is found finished", () => {
  resetSupersededForTests();
  // Arrives already completed: recorded at once.
  beginReplacement("c1", ["u1", "a1"]).complete("normal");
  assert.deepEqual([...getSupersededIds("c1")].sort(), ["a1", "u1"]);

  // Still running when the request returned: parked, recorded when a poll or a
  // history load finds it completed, and not before.
  const waiting = beginReplacement("c2", ["u2", "a2"]);
  parkReplacement("answer-2", waiting);
  assert.equal(getSupersededIds("c2").size, 0);
  settleParkedReplacement("answer-2", "incomplete");
  assert.deepEqual([...getSupersededIds("c2")].sort(), ["a2", "u2"]);
  // Settled once: a second report changes nothing.
  settleParkedReplacement("answer-2", "normal");

  // The attempt ended without an answer: nothing is recorded, even if a late
  // completion is reported for the same id.
  const failed = beginReplacement("c3", ["u3", "a3"]);
  parkReplacement("answer-3", failed);
  settleParkedReplacement("answer-3", null);
  settleParkedReplacement("answer-3", "normal");
  assert.equal(getSupersededIds("c3").size, 0);
});

test("the chat panel reports completion at each finished-answer path, never from a progress write", () => {
  const source = readFileSync(new URL("../components/chat/ChatApp.tsx", import.meta.url), "utf8");
  // Completion is explicit; the status of a write is not a completion signal.
  assert.ok(!source.includes("answerWritten"));
  assert.ok(source.includes("replacement.complete(completionStatus)"));
  assert.ok(source.includes("replacement.complete(completedMessage.status)"));
  assert.ok(source.includes("parkReplacement(assistantMessageId, replacement)"));
  assert.ok(source.includes("settleParkedReplacement(assistantMessageId, completedMessage.status)"));
});
