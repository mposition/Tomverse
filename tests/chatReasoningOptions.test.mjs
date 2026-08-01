import assert from "node:assert/strict";
import test from "node:test";

import { buildReasoningProviderOptions } from "../lib/chatReasoningOptions.ts";
import {
  AVAILABLE_MODELS,
  getModel,
  isPubliclySelectableModel,
} from "../lib/models.ts";

test("an OpenAI reasoning model is asked to reason", () => {
  assert.deepEqual(
    buildReasoningProviderOptions(getModel("gpt-5-5-thinking")),
    { openai: { reasoningEffort: "high" } }
  );
});

test("the plain OpenAI model it shares an apiModel with is not", () => {
  // The whole point: gpt-5-5 and gpt-5-5-thinking both send "gpt-5.5", so the
  // reasoning effort is the only thing that distinguishes the request the user
  // pays double for.
  const plain = getModel("gpt-5-5");
  const thinking = getModel("gpt-5-5-thinking");
  assert.equal(plain.apiModel, thinking.apiModel);
  assert.equal(buildReasoningProviderOptions(plain), null);
  assert.notEqual(buildReasoningProviderOptions(thinking), null);
});

test("a non-reasoning model is sent nothing", () => {
  assert.equal(buildReasoningProviderOptions(getModel("gpt-5-4-mini")), null);
  assert.equal(
    buildReasoningProviderOptions({ provider: "openai", reasoning: "none" }),
    null
  );
  assert.equal(buildReasoningProviderOptions({ provider: "openai" }), null);
});

test("no OpenAI-compatible provider is sent an unverified parameter", () => {
  // grok-4-5, kimi-k3 and the Perplexity reasoning models all declare
  // reasoning, but they are reached through OpenAI-*compatible* endpoints
  // whose support for the field is per-model and unverified here. A parameter
  // a provider rejects fails every request for that model and reads as a
  // provider outage.
  for (const model of AVAILABLE_MODELS) {
    if (model.provider === "openai") continue;
    assert.equal(
      buildReasoningProviderOptions(model),
      null,
      `${model.id} (${model.provider}) must not be sent a reasoning effort`
    );
  }
});

test("every selectable model that bills as reasoning either reasons upstream or is uniquely addressed", () => {
  // A reasoning-class model is charged 12-16 credits instead of 1-8. That is
  // defensible when the provider is genuinely doing more work -- either
  // because we ask it to, or because its apiModel is a different model. It is
  // not defensible when the request is identical to a cheaper entry's.
  const selectable = AVAILABLE_MODELS.filter(isPubliclySelectableModel);
  const apiModelCounts = new Map();
  for (const model of selectable) {
    apiModelCounts.set(
      model.apiModel,
      (apiModelCounts.get(model.apiModel) ?? 0) + 1
    );
  }

  for (const model of selectable) {
    const billsAsReasoning =
      model.usageClass === "reasoning" || model.usageClass === "premium-reasoning";
    if (!billsAsReasoning) continue;
    const sharesApiModel = apiModelCounts.get(model.apiModel) > 1;
    if (!sharesApiModel) continue;
    assert.notEqual(
      buildReasoningProviderOptions(model),
      null,
      `${model.id} bills as reasoning and shares apiModel "${model.apiModel}" with another selectable model, but sends no reasoning effort -- it is a more expensive name for the same request`
    );
  }
});
