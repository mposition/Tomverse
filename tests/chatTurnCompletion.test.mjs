import assert from "node:assert/strict";
import test from "node:test";
import { chatTurnSettlement, resolveChatTurnCompletion } from "../lib/chatTurnCompletion.ts";
import { getSettledUsageCredits } from "../lib/models.ts";

/**
 * How a finished provider stream is recorded and charged
 * (lib/chatTurnCompletion.ts, docs/policy/credit-and-cost-limits.md
 * "완료 분기의 정산"). Each case pins the settlement outcome and, where it
 * moved, what the move does to the user's credits.
 */

const turn = (input) => {
  const completion = resolveChatTurnCompletion({
    isResearchPreview: false,
    filesDelivered: false,
    ...input,
  });
  return { completion, ...chatTurnSettlement({ completion, answerDelivered: input.answerDelivered ?? true }) };
};

// A turn that reserved 8 credits on 10,000 input and 4,000 output tokens and
// used 2,000 and 500: the flat charge against the prorated one.
const credits = (outcome) => getSettledUsageCredits({
  reservedCredits: 8,
  reservedInputTokens: 10_000,
  reservedOutputTokens: 4_000,
  actualInputTokens: 2_000,
  actualOutputTokens: 500,
  outcome,
});

test("a stop whose metadata alone could not be read is a finished answer, charged as one", () => {
  // `providerMetadata`, `response` or `content` rejecting no longer reaches
  // the outcome: only the finish reason's own promise can say the stream
  // failed to finish.
  const result = turn({ finishReason: "stop" });
  assert.deepEqual(result.completion, { status: "normal" });
  assert.equal(result.settledAs, "completed");
  assert.equal(result.providerInterrupted, false);
  // Before: interrupted, settled `cancelled` -- 2 credits for a whole answer.
  assert.equal(credits("completed"), 8);
  assert.equal(credits("cancelled"), 2);
});

test("a finish reason that itself rejected is still a stream that broke off", () => {
  const result = turn({ finishReason: undefined });
  assert.deepEqual(result.completion, { status: "incomplete", incompleteReason: "interrupted" });
  assert.equal(result.settledAs, "cancelled");
  assert.equal(result.providerInterrupted, true);
});

test("an error finish reason is unchanged: interrupted, prorated, a provider failure", () => {
  const result = turn({ finishReason: "error" });
  assert.equal(result.completion.incompleteReason, "interrupted");
  assert.equal(result.settledAs, "cancelled");
  assert.equal(result.providerInterrupted, true);
});

test("a turn its step budget stopped mid-tool-call is unfinished and prorated, not a provider fault", () => {
  const result = turn({ finishReason: "tool-calls", rawFinishReason: "tool_use" });
  // No reason: neither the output ceiling nor the provider. The browser says
  // only that the answer did not finish (chat.responseUnfinishedNotice).
  assert.deepEqual(result.completion, { status: "incomplete" });
  assert.equal(result.settledAs, "cancelled");
  assert.equal(result.providerInterrupted, false);
  // Before: `normal` and the flat 8.
  assert.equal(credits(result.settledAs), 2);
});

test("a tool call that stored a file is the answer, and is charged in full", () => {
  // docs/policy/generated-artifacts.md section 8.
  const result = turn({ finishReason: "tool-calls", filesDelivered: true });
  assert.deepEqual(result.completion, { status: "normal" });
  assert.equal(result.settledAs, "completed");
});

test("Research Preview keeps its accepted report as the answer", () => {
  for (const finishReason of ["tool-calls", "error", undefined]) {
    const result = turn({ finishReason, isResearchPreview: true });
    assert.equal(result.completion.status, "normal", String(finishReason));
    assert.equal(result.settledAs, "completed");
  }
});

test("the output ceiling is unchanged: incomplete, and charged in full", () => {
  const result = turn({ finishReason: "length" });
  assert.deepEqual(result.completion, { status: "incomplete", incompleteReason: "length" });
  assert.equal(result.settledAs, "completed");
  assert.equal(result.providerInterrupted, false);
});

test("nothing delivered is empty, whatever the finish reason said", () => {
  for (const finishReason of ["stop", "tool-calls", "error", undefined]) {
    const result = turn({ finishReason, answerDelivered: false });
    assert.equal(result.settledAs, "empty", String(finishReason));
    assert.equal(result.providerInterrupted, false);
  }
});
