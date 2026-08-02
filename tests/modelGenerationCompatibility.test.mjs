import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelGenerationSettings,
  getModelProviderOptions,
  hasUnsupportedGeminiPrefill,
} from "../lib/modelGenerationCompatibility.ts";
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
