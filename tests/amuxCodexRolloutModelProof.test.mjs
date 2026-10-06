import assert from "node:assert/strict";
import test from "node:test";

import { codexExecThreadId, codexRolloutServedModel,
  withCodexRolloutModelProof } from
  "../lib/amux/codexRolloutModelProof.ts";

const threadId = "0199aabb-ccdd-4eee-8fff-123456789abc";
const event = (type, payload) => JSON.stringify({ type, payload });
const stdout = [JSON.stringify({ type: "thread.started", thread_id: threadId }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8,
    cached_input_tokens: 2, output_tokens: 3 } })];
const rollout = [event("session_meta", { id: threadId }),
  event("turn_context", { model: "gpt-6-sol" }),
  event("event_msg", { type: "token_count" })];
const observation = { version: 1, cli: "codex",
  completeness: "reported_complete", completedTurns: 1,
  observed: { inputTokens: 8, outputTokens: 3, cacheReadInputTokens: 2,
    cacheCreationInputTokens: null, reasoningOutputTokens: null },
  inputTokensIncludeCacheRead: true, inputTokensIncludeCacheWrite: null,
  reasoningOutputIncludedInOutput: true, models: [] };

test("a fresh Codex rollout attests one model for the same exec thread", () => {
  assert.equal(codexExecThreadId(stdout), threadId);
  const model = codexRolloutServedModel(threadId, rollout);
  assert.equal(model, "gpt-6-sol");
  assert.deepEqual(withCodexRolloutModelProof(observation, model).models,
    [{ modelId: "gpt-6-sol", observed: observation.observed }]);
});

test("foreign, repeated, mixed and missing rollout evidence fails closed", () => {
  assert.equal(codexExecThreadId([...stdout, stdout[0]]), null);
  assert.equal(codexRolloutServedModel(threadId,
    [event("session_meta", { id: "other" }), ...rollout.slice(1)]), null);
  assert.equal(codexRolloutServedModel(threadId,
    [...rollout, event("turn_context", { model: "gpt-6-astra" })]), null);
  assert.equal(codexRolloutServedModel(threadId, rollout.slice(1)), null);
  assert.equal(codexRolloutServedModel(threadId,
    [rollout[0], event("turn_context", { model: "../bad" })]), null);
  assert.equal(withCodexRolloutModelProof(observation, null).models.length, 0);
  assert.equal(withCodexRolloutModelProof({ ...observation,
    completeness: "reported_partial" }, "gpt-6-sol").models.length, 0);
});
