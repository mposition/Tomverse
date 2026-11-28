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
  // Every panel carries each panel's chat model in image-model order, so the
  // request that reserves the group writes every panel's answer.
  const panelModelIds = ["google-chat", "openai-chat"];
  assert.deepEqual(plan.turns["openai-chat"].comparison,
    { id: "shared-turn", index: 1, modelIds: ["fal-ai/nano-banana-2", "gpt-image-2"], panelModelIds });
  assert.deepEqual(plan.turns["google-chat"].comparison,
    { id: "shared-turn", index: 0, modelIds: ["fal-ai/nano-banana-2", "gpt-image-2"], panelModelIds });
  assert.equal(plan.turns["claude-chat"], null);
});

// --- active image catalogue ------------------------------------------------

import { reviewImageDraftModelId, reviewImageProviders } from "../lib/reviewImageTurn.ts";
import { IMAGE_MODEL_REGISTRY, imageModelOwner } from "../lib/imageModelRegistry.ts";

const disable = (ids) => IMAGE_MODEL_REGISTRY.map(model =>
  ids.includes(model.id) ? { ...model, disabledReason: "operational_hold" } : model);

test("image providers come from the active catalogue, not a fixed list", () => {
  // Review compares at 1K square. A native-2K-only catalogue entry belongs
  // in the Image workspace and cannot supply the 1K comparison.
  const active = IMAGE_MODEL_REGISTRY.filter(model => model.disabledReason === null &&
    model.prices.some(price => price.size === "1024x1024"));
  assert.ok(active.length > 0, "the seed catalogue has an active image model");
  const providers = reviewImageProviders(IMAGE_MODEL_REGISTRY);
  for (const model of active) assert.ok(providers.includes(imageModelOwner(model)), model.id);
  for (const model of IMAGE_MODEL_REGISTRY.filter(item => !active.includes(item))) {
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

// --- explicit image models (owner direction 2026-11-25) --------------------

import { reviewImageModelSelection } from "../lib/reviewImageTurn.ts";

const activeImage = IMAGE_MODEL_REGISTRY.filter(model => model.disabledReason === null);
const ownerOf = (id) => imageModelOwner(IMAGE_MODEL_REGISTRY.find(model => model.id === id));

test("picking one image model in Review turns every answering panel into an image model", () => {
  const picked = activeImage[0].id;
  const chosen = reviewImageModelSelection({ imageModels: IMAGE_MODEL_REGISTRY, current: [], picked,
    providers: ["openai", "google", "xai"], slots: 3, max: 3 });
  assert.equal(chosen[0], picked);
  assert.equal(chosen.length, Math.min(3, activeImage.length));
  assert.equal(new Set(chosen).size, chosen.length);
  for (const id of chosen) assert.ok(activeImage.some(model => model.id === id), id);
  // Other owners come before a second model of an owner already chosen.
  const owners = new Set(activeImage.map(model => imageModelOwner(model)));
  if (owners.size >= chosen.length) assert.equal(new Set(chosen.map(ownerOf)).size, chosen.length);
  // A single answering panel stays a single image model.
  assert.deepEqual(reviewImageModelSelection({ imageModels: IMAGE_MODEL_REGISTRY, current: [], picked,
    providers: ["openai"], slots: 1, max: 3 }), [picked]);
});

test("once in image mode a pick toggles, adds or replaces the last model", () => {
  const [a, b, c] = activeImage.map(model => model.id);
  const pick = (current, picked, max = 3) => reviewImageModelSelection({ imageModels: IMAGE_MODEL_REGISTRY,
    current, picked, providers: [], slots: 3, max });
  if (b) {
    assert.deepEqual(pick([a, b], b), [a]);
    assert.deepEqual(pick([a], a), [a], "the last image model cannot be removed");
    assert.deepEqual(pick([a], b), [a, b]);
  }
  if (c) assert.deepEqual(pick([a, b], c, 2), [a, c]);
  // A disabled or unknown model never enters the selection.
  assert.deepEqual(pick([a], "not-a-model"), [a]);
  assert.deepEqual(reviewImageModelSelection({ imageModels: disable([a]), current: [], picked: a,
    providers: [], slots: 3, max: 3 }), []);
});

test("an image owner without a chat model is hosted by a free selected panel", () => {
  const plan = reviewImageTurnPlan({ models, panels: models.map(m => m.id), preset: "standard", choices: [
    { provider: "openai", modelId: "gpt-image-2" },
    { provider: "bfl", modelId: "flux" },
    { provider: "openai", modelId: "gpt-image-1.5" },
  ] });
  assert.deepEqual(plan.panelIds, ["openai-chat", "claude-chat", "google-chat"]);
  assert.deepEqual(plan.turns["claude-chat"], { modelIds: ["flux"], preset: "standard" });
  assert.deepEqual(plan.turns["google-chat"], { modelIds: ["gpt-image-1.5"], preset: "standard" });
});
