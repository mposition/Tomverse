import assert from "node:assert/strict";
import test from "node:test";
import { arrangeColumns, columnTurns, moveColumn, shiftColumn, type ReviewMessage } from "../src/review-columns";
import { reviewTurnInput } from "../src/chat-contract";

const user = (id: string, content: string, modelId?: string): ReviewMessage =>
  ({ id, role: "user", content, status: "normal", ...(modelId ? { modelId } : {}), artifacts: [] });
const answer = (id: string, modelId: string, content = id): ReviewMessage =>
  ({ id, role: "assistant", content, status: "normal", modelId, artifacts: [] });

test("a column holds the shared questions, its own follow-ups and only its own answers", () => {
  const messages = [
    user("q1", "Shared"), answer("a-gpt", "gpt"), answer("a-gemini", "gemini"),
    user("q2", "Only Gemini", "gemini"), answer("a2-gemini", "gemini"),
  ];
  const columns = ["gpt", "gemini"];
  assert.deepEqual(columnTurns(messages, "gpt", columns).map(({ question, answers }) => [question.id, answers.map(({ id }) => id)]),
    [["q1", ["a-gpt"]]]);
  assert.deepEqual(columnTurns(messages, "gemini", columns).map(({ question, answers }) => [question.id, answers.map(({ id }) => id)]),
    [["q1", ["a-gemini"]], ["q2", ["a2-gemini"]]]);
});

test("a model that never answered a question borrows the answer no other column shows", () => {
  const messages = [user("q1", "Shared"), answer("a-old", "old-model")];
  const [turn] = columnTurns(messages, "new-model", ["new-model"]);
  assert.equal(turn?.answers[0]?.id, "a-old");
  assert.equal(columnTurns(messages, "new-model", ["new-model", "old-model"])[0]?.answers.length, 0);
});

test("the arrangement orders the columns and keeps the ones it does not name after them", () => {
  assert.deepEqual(arrangeColumns(["a", "b", "c"], ["c", "a"]), ["c", "a", "b"]);
  assert.deepEqual(arrangeColumns(["a", "b", "c"], []), ["a", "b", "c"]);
  assert.deepEqual(arrangeColumns(["a", "b"], ["x", "b", "a"]), ["b", "a"]);
});

test("a dropped column takes the place of the column it lands on", () => {
  assert.deepEqual(moveColumn(["a", "b", "c"], "a", "c"), ["b", "c", "a"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], "b", "b"), ["a", "b", "c"]);
  assert.deepEqual(moveColumn(["a", "b", "c"], "x", "a"), ["a", "b", "c"]);
});

test("the keyboard moves a column one place and stops at the ends", () => {
  assert.deepEqual(shiftColumn(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(shiftColumn(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(shiftColumn(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(shiftColumn(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
});

test("a follow-up for one model names a saved conversation and exactly that model", () => {
  const base = { requestId: crypto.randomUUID(), prompt: "More?", mode: "professional", effort: "default" } as const;
  assert.equal(reviewTurnInput.safeParse({ ...base, conversationId: "review-1", choices: ["gpt"], onlyModelId: "gpt" }).success, true);
  assert.equal(reviewTurnInput.safeParse({ ...base, choices: ["gpt"], onlyModelId: "gpt" }).success, false);
  assert.equal(reviewTurnInput.safeParse({ ...base, conversationId: "review-1", choices: ["gpt", "gemini"], onlyModelId: "gpt" }).success, false);
  assert.equal(reviewTurnInput.safeParse({ ...base, conversationId: "review-1", choices: ["gemini"], onlyModelId: "gpt" }).success, false);
});
