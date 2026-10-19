import assert from "node:assert/strict";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  AUTO_LLM_ROUTER_MAX_PROMPT_CHARS,
  autoLlmRouterCandidates,
  autoLlmRouterOutputSchema,
  autoLlmRouterUserMessage,
  parseAutoLlmRouterOutput,
  resolveAutoLlmRouterModel,
} from "../lib/autoLlmRouterCore.ts";

const ids = ["gpt-5-6-luna", "deepseek-v4-flash", "claude-opus-4-8"];
const candidates = autoLlmRouterCandidates(ids, AVAILABLE_MODELS, {
  "gpt-5-6-luna": 1,
  "deepseek-v4-flash": 1,
});

test("candidates carry what the choice needs, in the eligible order", () => {
  assert.deepEqual(candidates.map((candidate) => candidate.id), ids);
  for (const candidate of candidates) {
    assert.equal(typeof candidate.name, "string");
    assert.equal(typeof candidate.bestFor, "string");
    assert.equal(typeof candidate.tier, "string");
  }
  // An unknown credit price is null, not zero: zero would read as free.
  assert.equal(candidates[2].credits, null);
  assert.deepEqual(
    autoLlmRouterCandidates(["no-such-model"], AVAILABLE_MODELS, {}),
    []
  );
});

test("the schema only admits ids from the candidate set", () => {
  const schema = autoLlmRouterOutputSchema(candidates);
  assert.deepEqual(schema.properties.modelId.enum, ids);
  assert.deepEqual(schema.required, ["modelId"]);
  assert.equal(schema.additionalProperties, false);
});

test("an answer outside the set, or of the wrong shape, is no pick", () => {
  assert.equal(parseAutoLlmRouterOutput({ modelId: "deepseek-v4-flash" }, candidates), "deepseek-v4-flash");
  assert.equal(parseAutoLlmRouterOutput({ modelId: "gpt-6-sol" }, candidates), null);
  assert.equal(parseAutoLlmRouterOutput({ modelId: 3 }, candidates), null);
  assert.equal(parseAutoLlmRouterOutput("deepseek-v4-flash", candidates), null);
  assert.equal(parseAutoLlmRouterOutput(null, candidates), null);
});

test("the prompt is cut before it leaves", () => {
  const message = JSON.parse(
    autoLlmRouterUserMessage("가".repeat(AUTO_LLM_ROUTER_MAX_PROMPT_CHARS + 50), candidates)
  );
  assert.equal(message.message.length, AUTO_LLM_ROUTER_MAX_PROMPT_CHARS);
  assert.equal(message.candidates.length, ids.length);
});

test("the router model is off unless configured with an enabled catalogue id", () => {
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, undefined), null);
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, "  "), null);
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, "no-such-model"), null);
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, "gpt-5-6-luna")?.id, "gpt-5-6-luna");
});
