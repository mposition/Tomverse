import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelGenerationSettings,
  getModelProviderOptions,
  hasUnsupportedGeminiPrefill,
} from "../lib/modelGenerationCompatibility.ts";
import {
  getWebSearchCapability,
  openAiNativeSearchToolCallCeiling,
} from "../lib/webSearchCapability.ts";
import { getModel } from "../lib/models.ts";

test("the existing GPT-5.5 Thinking variant sends its promised reasoning effort", () => {
  assert.deepEqual(getModelProviderOptions(getModel("gpt-5-5-thinking")), {
    openai: { reasoningEffort: "high" },
  });
});

test("GPT-5.6 does not gain a synthetic Thinking configuration", () => {
  for (const id of ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-5-6-luna"]) {
    assert.deepEqual(getModelProviderOptions(getModel(id)), {
      openai: { reasoningEffort: "medium" },
    }, id);
    assert.deepEqual(getModelGenerationSettings(getModel(id), { temperature: 0.2 }), {
      providerOptions: { openai: { reasoningEffort: "medium" } },
    });
  }
});

test("OpenAI-compatible reasoning models pass reasoning_effort through the SDK", () => {
  // grok-4-3 is retired, but it stays covered here: forceReasoning is what
  // stops the SDK dropping reasoning_effort for a provider that is not on its
  // own allowlist, and that is the part a relisting would depend on.
  assert.deepEqual(getModelProviderOptions(getModel("grok-4-3")), {
    openai: { reasoningEffort: "none", forceReasoning: true },
  });
  assert.deepEqual(getModelProviderOptions(getModel("grok-4-5")), {
    openai: { reasoningEffort: "high", forceReasoning: true },
  });
});

test("Claude 5 models use adaptive thinking with their catalogue effort", () => {
  for (const id of ["claude-fable-5", "claude-opus-4-8"]) {
    assert.deepEqual(getModelProviderOptions(getModel(id)), {
      anthropic: {
        thinking: { type: "adaptive" },
        effort: "high",
      },
    });
  }
});

test("Kimi K3 uses the Moonshot provider and explicit high effort", () => {
  assert.deepEqual(getModelGenerationSettings(getModel("kimi-k3"), {
    temperature: 0.2,
  }), {
    providerOptions: {
      moonshotai: { reasoningEffort: "high" },
    },
  });
});

test("MiniMax M3 enables adaptive thinking without Anthropic-only effort", () => {
  assert.deepEqual(getModelProviderOptions(getModel("minimax-m3")), {
    anthropic: { thinking: { type: "adaptive" } },
  });
});

test("new Gemini request paths omit unsupported sampling parameters", () => {
  for (const id of ["gemini-3-6-flash", "gemini-2-5-flash"]) {
    assert.deepEqual(getModelGenerationSettings(getModel(id), { temperature: 0.1 }), {});
  }
  assert.deepEqual(
    getModelGenerationSettings(getModel("gemini-3-5-flash"), { temperature: 0.1 }),
    { temperature: 0.1 }
  );
});

test("new Gemini models reject a prefilled final model turn", () => {
  for (const id of ["gemini-3-6-flash", "gemini-2-5-flash"]) {
    const model = getModel(id);
    assert.equal(
      hasUnsupportedGeminiPrefill(model, [
        { role: "user", content: "question" },
        { role: "assistant", content: "prefill" },
      ]),
      true
    );
    assert.equal(
      hasUnsupportedGeminiPrefill(model, [
        { role: "assistant", content: "prior answer" },
        { role: "user", content: "follow-up" },
      ]),
      false
    );
  }

  assert.equal(
    hasUnsupportedGeminiPrefill(getModel("gemini-3-5-flash"), [
      { role: "assistant", content: "allowed for this legacy model" },
    ]),
    false
  );
});


// `max_tool_calls` is what bounds an OpenAI Responses request's built-in tool
// calls, and therefore what makes the native web search's per-query cost
// reservable at all. It lands in the same `providerOptions.openai` namespace
// `reasoningEffort` already occupies, so the merge below is not a convenience:
// a shallow spread drops whichever of the two was written first.

const searchSettings = (modelId) => {
  const model = getModel(modelId);
  const capability = getWebSearchCapability(modelId);
  return getModelGenerationSettings(model, {
    openAiMaxToolCalls: openAiNativeSearchToolCallCeiling({
      capability,
      nativeSearchEnabled: true,
    }),
  });
};

const nonSearchSettings = (modelId) => {
  const model = getModel(modelId);
  const capability = getWebSearchCapability(modelId);
  return getModelGenerationSettings(model, {
    openAiMaxToolCalls: openAiNativeSearchToolCallCeiling({
      capability,
      nativeSearchEnabled: false,
    }),
  });
};

test("a searching Luna turn carries the OpenAI tool-call ceiling", () => {
  const settings = searchSettings("gpt-5-6-luna");
  assert.equal(settings.providerOptions.openai.maxToolCalls, 5);
});

test("a Luna turn that is not searching sends no tool-call ceiling", () => {
  // A request attaching no built-in tool has no built-in tool calls to bound,
  // and sending a bound for them would be describing a request that is not
  // being made.
  const settings = nonSearchSettings("gpt-5-6-luna");
  assert.equal("maxToolCalls" in settings.providerOptions.openai, false);
  // Everything the turn did have is untouched.
  assert.equal(settings.providerOptions.openai.reasoningEffort, "medium");
});

test("reasoningEffort and maxToolCalls survive each other", () => {
  // The failure this guards: `{...providerOptions, ...{openai:{maxToolCalls}}}`
  // replaces the whole `openai` object, so the request goes out with a ceiling
  // and no reasoning effort -- and the model quietly answers at the provider's
  // default.
  // Every OpenAI native-search model that declares a reasoning effort. `gpt-5-5`
  // declares none and is covered by the no-reasoning case below.
  for (const [modelId, effort] of [
    ["gpt-5-6-luna", "medium"],
    ["gpt-5-6-sol", "medium"],
    ["gpt-5-5-thinking", "high"],
  ]) {
    const withSearch = searchSettings(modelId);
    const withoutSearch = nonSearchSettings(modelId);
    assert.equal(
      withSearch.providerOptions.openai.reasoningEffort,
      effort,
      `${modelId}: the reasoning effort must not change because a tool was attached`
    );
    assert.equal(
      withoutSearch.providerOptions.openai.reasoningEffort,
      effort,
      modelId
    );
    assert.equal(withSearch.providerOptions.openai.maxToolCalls, 5, modelId);
    assert.equal(
      "maxToolCalls" in withoutSearch.providerOptions.openai,
      false,
      modelId
    );
  }

  // A native-search model with no reasoning profile still gets its ceiling and
  // invents no effort to go with it.
  assert.deepEqual(searchSettings("gpt-5-5").providerOptions, {
    openai: { maxToolCalls: 5 },
  });
  assert.equal(nonSearchSettings("gpt-5-5").providerOptions, undefined);
});

test("a ceiling reaches a model that has no reasoning profile at all", () => {
  // `getModelProviderOptions` returns undefined for those, so the merge has to
  // create the namespace rather than add to one.
  const settings = getModelGenerationSettings(
    { id: "hypothetical", provider: "openai", reasoning: undefined },
    { openAiMaxToolCalls: 5 }
  );
  assert.deepEqual(settings.providerOptions, { openai: { maxToolCalls: 5 } });
});

test("no ceiling means no providerOptions key is invented", () => {
  const settings = getModelGenerationSettings(
    { id: "hypothetical", provider: "openai", reasoning: undefined },
    { temperature: 0.4 }
  );
  assert.equal("providerOptions" in settings, false);
  assert.equal(settings.temperature, 0.4);
});

test("a non-OpenAI provider's namespace is never crossed with OpenAI's", () => {
  // Anthropic's ceiling is `maxUses` on the tool, sent by
  // `buildWebSearchToolConfig`; nothing about it belongs in a request-level
  // `openai` namespace. `openAiNativeSearchToolCallCeiling` is what keeps it
  // out, and a searching Claude turn is where that would show.
  const withReasoning = searchSettings("claude-fable-5");
  assert.equal(withReasoning.providerOptions.openai, undefined);
  assert.deepEqual(withReasoning.providerOptions.anthropic, {
    thinking: { type: "adaptive" },
    effort: "high",
  });

  const withoutReasoning = searchSettings("claude-sonnet-5");
  assert.equal(
    withoutReasoning.providerOptions,
    undefined,
    "no namespace is invented for a provider this parameter does not belong to"
  );
});
