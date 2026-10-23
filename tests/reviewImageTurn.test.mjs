import assert from "node:assert/strict";
import test from "node:test";
import { reviewImageTurnPlan } from "../lib/reviewImageTurn.ts";

const models = [
  { id: "openai-chat", provider: "openai" },
  { id: "claude-chat", provider: "anthropic" },
  { id: "google-chat", provider: "google" },
];

test("one image per selected provider, with no text or replacement for an unsupported peer", () => {
  const plan = reviewImageTurnPlan({ models, panels: models.map(m => m.id), preset: "draft", choices: [
    { provider: "openai", modelId: "gpt-image-2" },
    { provider: "anthropic", modelId: null },
    { provider: "google", modelId: "google-image" },
  ] });
  assert.deepEqual(plan, { panelIds: models.map(m => m.id), turns: {
    "openai-chat": { modelIds: ["gpt-image-2"], preset: "draft" },
    "claude-chat": null,
    "google-chat": { modelIds: ["google-image"], preset: "draft" },
  } });
});

test("a manual image choice keeps the provider's existing panel and follow-up prompt", () => {
  const plan = reviewImageTurnPlan({ models, panels: ["google-chat"], preset: "final",
    prompt: "a bluer mountain", choices: [{ provider: "google", modelId: "google-image" }] });
  assert.deepEqual(plan.turns["google-chat"], { modelIds: ["google-image"], preset: "final", prompt: "a bluer mountain" });
});

test("missing or duplicate provider panels cannot create a partial or duplicate fan-out", () => {
  for (const choices of [[{ provider: "unknown", modelId: "image" }],
    [{ provider: "openai", modelId: "image" }, { provider: "openai", modelId: "image" }]]) {
    assert.equal(reviewImageTurnPlan({ models, panels: [], preset: "standard", choices }), null);
  }
});


test("provider answers share one group and persist a catalogue-independent target index", () => {
  const plan = reviewImageTurnPlan({ models, panels: models.map(m => m.id), preset: "standard",
    comparisonId: "shared-turn", choices: [
      { provider: "openai", modelId: "gpt-image-2" },
      { provider: "anthropic", modelId: null },
      { provider: "google", modelId: "fal-ai/nano-banana-2" },
    ] });
  assert.deepEqual(plan.turns["openai-chat"].comparison,
    { id: "shared-turn", index: 1, modelIds: ["fal-ai/nano-banana-2", "gpt-image-2"] });
  assert.deepEqual(plan.turns["google-chat"].comparison,
    { id: "shared-turn", index: 0, modelIds: ["fal-ai/nano-banana-2", "gpt-image-2"] });
  assert.equal(plan.turns["claude-chat"], null);
});
