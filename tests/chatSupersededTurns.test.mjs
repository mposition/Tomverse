import assert from "node:assert/strict";
import test from "node:test";

import {
  armSupersede,
  canEditQuestion,
  getSupersededIds,
  lastReplaceableTurn,
  markTurnSuperseded,
  resetSupersededForTests,
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
