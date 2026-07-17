import assert from "node:assert/strict";
import test from "node:test";
import { selectLatestComparableTurn } from "../lib/comparisonReviewTurnCore.ts";

const at = (seconds) => new Date(`2026-07-17T00:00:${String(seconds).padStart(2, "0")}Z`);
const message = (id, role, content, modelId, seconds) => ({
  id,
  role,
  content,
  modelId,
  createdAt: at(seconds),
});

test("does not fall back to an older question when the newest answer set is incomplete", () => {
  const result = selectLatestComparableTurn([
    message("q1", "user", "older question", null, 1),
    message("a1", "assistant", "older A", "gpt-5-4-mini", 2),
    message("a2", "assistant", "older B", "claude-haiku-4-5", 3),
    message("q2", "user", "latest question", null, 4),
    message("a3", "assistant", "latest A only", "gpt-5-4-mini", 5),
  ]);

  assert.equal(result, null);
});

test("returns only distinct model answers after the latest question", () => {
  const result = selectLatestComparableTurn([
    message("q1", "user", "older question", null, 1),
    message("old", "assistant", "must not be included", "mistral-small-4", 2),
    message("q2", "user", "latest question", null, 3),
    message("a1", "assistant", "first draft", "gpt-5-4-mini", 4),
    message("a2", "assistant", "second model", "claude-haiku-4-5", 5),
    message("a3", "assistant", "latest draft", "gpt-5-4-mini", 6),
  ]);

  assert.ok(result);
  assert.equal(result.prompt.id, "q2");
  assert.deepEqual(
    result.responses.map(({ messageId, content }) => ({ messageId, content })),
    [
      { messageId: "a3", content: "latest draft" },
      { messageId: "a2", content: "second model" },
    ]
  );
  assert.equal(
    result.responses.some((response) => response.messageId === "old"),
    false
  );
});
