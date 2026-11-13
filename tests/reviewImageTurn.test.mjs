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

// --- active image catalogue ------------------------------------------------

import { reviewImageDraftModelId, reviewImageProviders } from "../lib/reviewImageTurn.ts";
import { IMAGE_MODEL_REGISTRY, imageModelOwner } from "../lib/imageModelRegistry.ts";

const disable = (ids) => IMAGE_MODEL_REGISTRY.map(model =>
  ids.includes(model.id) ? { ...model, disabledReason: "operational_hold" } : model);

test("image providers come from the active catalogue, not a fixed list", () => {
  const active = IMAGE_MODEL_REGISTRY.filter(model => model.disabledReason === null);
  assert.ok(active.length > 0, "the seed catalogue has an active image model");
  const providers = reviewImageProviders(IMAGE_MODEL_REGISTRY);
  for (const model of active) assert.ok(providers.includes(imageModelOwner(model)), model.id);
  for (const model of IMAGE_MODEL_REGISTRY.filter(item => item.disabledReason !== null)) {
    if (!active.some(item => imageModelOwner(item) === imageModelOwner(model))) {
      assert.ok(!providers.includes(imageModelOwner(model)), model.id);
    }
  }
  // Disabling every model of one provider takes its badge away.
  const openai = IMAGE_MODEL_REGISTRY.filter(model => imageModelOwner(model) === "openai").map(model => model.id);
  assert.ok(!reviewImageProviders(disable(openai)).includes("openai"));
  assert.deepEqual(reviewImageProviders(disable(IMAGE_MODEL_REGISTRY.map(model => model.id))), []);
});

test("a Review image draft never starts on a disabled model", () => {
  // Owner report 2026-11-13: the Review image card armed GPT Image 2 after it
  // had been disabled, and the image mode could never send.
  const catalogue = disable(["gpt-image-2"]);
  const chosen = reviewImageDraftModelId(catalogue, ["openai", "google", "xai"]);
  assert.notEqual(chosen, "gpt-image-2");
  assert.equal(catalogue.find(model => model.id === chosen)?.disabledReason, null);
  // A provider already answering is preferred over catalogue order.
  const preferred = reviewImageDraftModelId(IMAGE_MODEL_REGISTRY, ["xai"]);
  const xaiActive = IMAGE_MODEL_REGISTRY.some(model => model.disabledReason === null && imageModelOwner(model) === "xai");
  if (xaiActive) assert.equal(imageModelOwner(IMAGE_MODEL_REGISTRY.find(model => model.id === preferred)), "xai");
  // Nothing active: no model, so no image mode is armed.
  assert.equal(reviewImageDraftModelId(disable(IMAGE_MODEL_REGISTRY.map(model => model.id)), ["openai"]), null);
});
