import assert from "node:assert/strict";
import test from "node:test";

import { AVAILABLE_MODELS, getModel } from "../lib/models.ts";
import {
  CHATGPT_VS_CLAUDE_MODEL_IDS,
  MARKETING_REFERENCED_MODEL_IDS,
  findUnsellableMarketingModels,
} from "../lib/marketingModelReferences.ts";

// The forcing function for "marketing must move with a retirement".
//
// A public marketing page names its models by hand -- in prose, in badges, in
// result labels, and in a prepared comparison deep link. Nothing about that
// follows the catalogue, so retiring a model leaves the page advertising
// something no visitor can pick, and its deep link silently resolving to a
// different model than the page describes. This test is what makes that a
// build failure instead of a discovery.
test("every marketing-referenced model is still publicly selectable", () => {
  const unsellable = findUnsellableMarketingModels();
  assert.deepEqual(
    unsellable,
    [],
    `marketing names ${unsellable
      .map((entry) => `${entry.modelId} (${entry.reason})`)
      .join(", ")}. Update the marketing copy, badges, result labels, ` +
      "structured data, deep links and captured screenshots together with " +
      "lib/marketingModelReferences.ts -- see " +
      "docs/policy/default-model-luna-migration.md."
  );
});

test("marketing-referenced ids exist in the registry", () => {
  const registryIds = new Set(AVAILABLE_MODELS.map((model) => model.id));
  for (const modelId of MARKETING_REFERENCED_MODEL_IDS) {
    assert.ok(registryIds.has(modelId), `${modelId} is not a registry model`);
  }
});

test("the ChatGPT vs Claude guide compares two different providers", () => {
  // The page's whole premise is one OpenAI model against one Anthropic model.
  // A swap that leaves both slots on the same provider would keep every
  // assertion above green while making the page nonsense.
  const providers = CHATGPT_VS_CLAUDE_MODEL_IDS.map(
    (modelId) => getModel(modelId)?.provider
  );
  assert.equal(providers.length, 2);
  assert.ok(providers.includes("openai"), "the GPT slot must be an OpenAI model");
  assert.ok(
    providers.includes("anthropic"),
    "the Claude slot must be an Anthropic model"
  );
});

test("the guide's models are reachable without a paid plan", () => {
  // The page invites a signed-out visitor to run the comparison themselves.
  // A Pro-only model in either slot turns that CTA into an upsell wall.
  for (const modelId of CHATGPT_VS_CLAUDE_MODEL_IDS) {
    assert.equal(
      getModel(modelId)?.minimumPlan,
      "Guest",
      `${modelId} is not reachable by a guest`
    );
  }
});
