import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL_ID,
  PUBLIC_MODELS,
  getModel,
  isPubliclySelectableModel,
  isRetiredModel,
} from "../lib/models.ts";
import {
  APP_DEFAULTS,
  GUEST_BRAND_TRIO_MODEL_IDS,
  GUEST_FALLBACK_MODEL_IDS,
  getGuestDefaultSelectedModels,
} from "../lib/appDefaults.ts";
import { getReferencedRecommendationModelIds } from "../lib/modelRecommendations.ts";
import { RECOMMENDED_MODEL_IDS } from "../lib/modelPickerPresentation.ts";
import { PROVIDER_FALLBACKS } from "../lib/providerFallbackCandidates.ts";
import {
  MODEL_FINDER_FILE_USAGE,
  MODEL_FINDER_PRIORITIES,
  MODEL_FINDER_TASKS,
  getModelFinderRecommendations,
} from "../lib/modelFinder.ts";
import {
  COMPARISON_REVIEW_DEFAULT_MODEL_IDS,
  QUICK_COMPARISON_DEFAULT_MODEL_IDS,
} from "../lib/comparisonReview.ts";

// Retiring a model in lib/models.ts is only half the job: its id also sits in
// the guest defaults, the recommendation tables, the per-provider outage
// fallbacks and the comparison-review panels. Each of those resolves ids
// lazily and skips anything unknown, so a stale entry degrades a list
// silently instead of failing. This suite is the check that catches it.

const RETIRED_IDS = AVAILABLE_MODELS.filter(isRetiredModel).map(
  (model) => model.id
);

const assertLive = (label, modelIds) => {
  for (const modelId of modelIds) {
    const model = getModel(modelId);
    assert.ok(model, `${label} references unknown model ${modelId}`);
    assert.equal(
      isRetiredModel(model),
      false,
      `${label} references retired model ${modelId}`
    );
    assert.equal(
      isPubliclySelectableModel(model),
      true,
      `${label} references ${modelId}, which is not publicly selectable`
    );
  }
};

test("the catalogue actually carries retired models to check against", () => {
  assert.ok(RETIRED_IDS.length > 0);
  for (const id of [
    "llama-3-1",
    "llama-3-3",
    "llama-4-scout",
    "grok-4",
    "grok-3",
    "grok-3-mini",
  ]) {
    assert.ok(RETIRED_IDS.includes(id), `${id} should be retired`);
  }
});

test("the default and guest default models are live", () => {
  assertLive("DEFAULT_MODEL_ID", [DEFAULT_MODEL_ID]);
  assertLive("APP_DEFAULTS.guestDefaultModelId", [
    APP_DEFAULTS.guestDefaultModelId,
  ]);
  assertLive("GUEST_BRAND_TRIO_MODEL_IDS", GUEST_BRAND_TRIO_MODEL_IDS);
  assertLive("GUEST_FALLBACK_MODEL_IDS", GUEST_FALLBACK_MODEL_IDS);
});

test("the guest default selection is three live models", () => {
  const guestDefaults = getGuestDefaultSelectedModels();
  assert.equal(guestDefaults.length, APP_DEFAULTS.maxGuestSelectedModels);
  assertLive("guest default selection", guestDefaults);
});

test("recommendation tables reference only live models", () => {
  assertLive("USE_CASE_CANDIDATES", getReferencedRecommendationModelIds());
  assertLive("RECOMMENDED_MODEL_IDS", RECOMMENDED_MODEL_IDS);
});

test("provider outage fallbacks reference only live models", () => {
  for (const [provider, fallback] of Object.entries(PROVIDER_FALLBACKS)) {
    assertLive(`PROVIDER_FALLBACKS.${provider}`, fallback.recommendedModelIds);
  }
});

test("the model finder only ever recommends live models", () => {
  for (const task of MODEL_FINDER_TASKS) {
    for (const priority of MODEL_FINDER_PRIORITIES) {
      for (const fileUsage of MODEL_FINDER_FILE_USAGE) {
        const recommendations = getModelFinderRecommendations({
          tasks: [task],
          priority,
          fileUsage,
        });
        assert.ok(
          recommendations.length > 0,
          `model finder returned nothing for ${task}/${priority}/${fileUsage}`
        );
        assertLive(
          `model finder (${task}/${priority}/${fileUsage})`,
          recommendations.map((item) => item.modelId)
        );
      }
    }
  }
});

test("comparison review panels reference only live models", () => {
  assertLive(
    "COMPARISON_REVIEW_DEFAULT_MODEL_IDS",
    COMPARISON_REVIEW_DEFAULT_MODEL_IDS
  );
  assertLive(
    "QUICK_COMPARISON_DEFAULT_MODEL_IDS",
    QUICK_COMPARISON_DEFAULT_MODEL_IDS
  );
});

test("no retired id is publicly listed anywhere in the catalogue", () => {
  const publicIds = new Set(
    PUBLIC_MODELS.filter(isPubliclySelectableModel).map((model) => model.id)
  );
  for (const retiredId of RETIRED_IDS) {
    assert.equal(
      publicIds.has(retiredId),
      false,
      `${retiredId} is retired but still publicly selectable`
    );
  }
});

test("a retired model never names another retired model as its replacement", () => {
  const retired = new Set(RETIRED_IDS);
  for (const model of AVAILABLE_MODELS) {
    if (!model.replacementModelId) continue;
    assert.equal(
      retired.has(model.replacementModelId),
      false,
      `${model.id} points at retired model ${model.replacementModelId}`
    );
  }
});
