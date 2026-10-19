import assert from "node:assert/strict";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  AUTO_LLM_ROUTER_MAX_CONTEXT_CHARS,
  AUTO_LLM_ROUTER_MAX_PROMPT_CHARS,
  AUTO_LLM_ROUTER_MAX_REASON_CHARS,
  autoLlmRouterCandidates,
  autoLlmRouterOutputSchema,
  autoLlmRouterUserMessage,
  parseAutoLlmRouterOutput,
  previousAnswerExcerpt,
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
    assert.equal(typeof candidate.provider, "string");
    assert.equal(typeof candidate.bestFor, "string");
    assert.equal(typeof candidate.tier, "string");
    assert.equal(typeof candidate.acceptsImages, "boolean");
  }
  // Catalogue facts, not prose written for the router.
  const luna = AVAILABLE_MODELS.find((model) => model.id === "gpt-5-6-luna");
  assert.equal(candidates[0].provider, luna.provider);
  assert.equal(candidates[0].reasoning, luna.reasoning ?? null);
  assert.equal(candidates[0].contextWindowTokens, luna.contextWindowTokens ?? null);
  // An unknown credit price is null, not zero: zero would read as free.
  assert.equal(candidates[2].credits, null);
  assert.deepEqual(
    autoLlmRouterCandidates(["no-such-model"], AVAILABLE_MODELS, {}),
    []
  );
});

test("the schema asks for a reason first, then an id from the candidate set", () => {
  const schema = autoLlmRouterOutputSchema(candidates);
  assert.deepEqual(schema.properties.modelId.enum, ids);
  assert.deepEqual(Object.keys(schema.properties), ["reason", "modelId"]);
  assert.deepEqual(schema.required, ["reason", "modelId"]);
  assert.equal(schema.additionalProperties, false);
});

test("an answer outside the set, or of the wrong shape, is no pick", () => {
  assert.deepEqual(
    parseAutoLlmRouterOutput({ reason: " Short coding fix. ", modelId: "deepseek-v4-flash" }, candidates),
    { modelId: "deepseek-v4-flash", reason: "Short coding fix." }
  );
  // A missing or empty reason does not void the pick.
  assert.deepEqual(
    parseAutoLlmRouterOutput({ modelId: "deepseek-v4-flash", reason: "  " }, candidates),
    { modelId: "deepseek-v4-flash", reason: null }
  );
  const long = parseAutoLlmRouterOutput(
    { reason: "x".repeat(AUTO_LLM_ROUTER_MAX_REASON_CHARS + 10), modelId: "gpt-5-6-luna" },
    candidates
  );
  assert.equal(long.reason.length, AUTO_LLM_ROUTER_MAX_REASON_CHARS);
  assert.equal(parseAutoLlmRouterOutput({ modelId: "gpt-6-sol" }, candidates), null);
  assert.equal(parseAutoLlmRouterOutput({ modelId: 3 }, candidates), null);
  assert.equal(parseAutoLlmRouterOutput("deepseek-v4-flash", candidates), null);
  assert.equal(parseAutoLlmRouterOutput(null, candidates), null);
});

test("the prompt is cut before it leaves, and the previous answer travels only when present", () => {
  const message = JSON.parse(
    autoLlmRouterUserMessage("가".repeat(AUTO_LLM_ROUTER_MAX_PROMPT_CHARS + 50), null, candidates)
  );
  assert.equal(message.message.length, AUTO_LLM_ROUTER_MAX_PROMPT_CHARS);
  assert.equal(message.candidates.length, ids.length);
  assert.equal("previousAnswer" in message, false);
  const withContext = JSON.parse(autoLlmRouterUserMessage("위 코드 고쳐줘", "def f(x):", candidates));
  assert.equal(withContext.previousAnswer, "def f(x):");
});

test("the previous answer is the assistant reply the latest prompt follows", () => {
  assert.equal(previousAnswerExcerpt([{ role: "user", content: "hi" }]), null);
  assert.equal(previousAnswerExcerpt([]), null);
  assert.equal(
    previousAnswerExcerpt([
      { role: "user", content: "write f" },
      { role: "assistant", content: "  def f(x): return x  " },
      { role: "user", content: "fix the code above" },
    ]),
    "def f(x): return x"
  );
  // Two user turns in a row: the latest prompt follows no answer.
  assert.equal(
    previousAnswerExcerpt([
      { role: "assistant", content: "old" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]),
    null
  );
  // Non-text content is not guessed at.
  assert.equal(
    previousAnswerExcerpt([
      { role: "assistant", content: [{ type: "image" }] },
      { role: "user", content: "and this?" },
    ]),
    null
  );
  const long = previousAnswerExcerpt([
    { role: "assistant", content: "a".repeat(AUTO_LLM_ROUTER_MAX_CONTEXT_CHARS + 5) },
    { role: "user", content: "next" },
  ]);
  assert.equal(long.length, AUTO_LLM_ROUTER_MAX_CONTEXT_CHARS);
});

test("the router model is off unless configured with an enabled catalogue id", () => {
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, undefined), null);
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, "  "), null);
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, "no-such-model"), null);
  assert.equal(resolveAutoLlmRouterModel(AVAILABLE_MODELS, "gpt-5-6-luna")?.id, "gpt-5-6-luna");
});
