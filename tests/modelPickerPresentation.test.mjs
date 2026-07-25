import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_MODELS, getModel } from "../lib/models.ts";
import {
  RECOMMENDED_MODEL_IDS,
  getModelPickerDescription,
  getModelPickerFeatures,
  getModelPickerUsageBand,
  modelMatchesCapability,
  modelPickerCopy,
  modelPickerFeatureLabels,
} from "../lib/modelPickerPresentation.ts";

test("every public model has a concise model-specific picker description", () => {
  for (const model of PUBLIC_MODELS) {
    assert.ok(model.bestFor.trim().length > 8, `${model.id} needs a useful description`);
    assert.equal(getModelPickerDescription(model, "en"), model.bestFor);
    assert.ok(getModelPickerDescription(model, "ko").trim().length > 8);
  }
});

test("picker exposes only decision-relevant special features", () => {
  // gpt-5-5-thinking is confirmed native-web-search-capable (see
  // lib/webSearchCapability.ts), so it now genuinely qualifies for the
  // search badge too -- with the 2-feature cap, that takes the slot "image"
  // used to occupy, which is covered separately below via a model that has
  // image input but no confirmed search support.
  assert.deepEqual(getModelPickerFeatures(getModel("gpt-5-5-thinking")), [
    "search",
    "reasoning",
  ]);
  assert.deepEqual(getModelPickerFeatures(getModel("gemini-2-5-flash")), [
    "image",
  ]);
  assert.deepEqual(getModelPickerFeatures(getModel("perplexity/sonar")), [
    "search",
  ]);
  assert.deepEqual(getModelPickerFeatures(getModel("codestral")), ["code"]);
  assert.equal(
    PUBLIC_MODELS.every((model) => getModelPickerFeatures(model).length <= 2),
    true
  );
  assert.equal(modelPickerFeatureLabels.ko.image, "이미지 입력");
});

test("usage bands supplement rather than replace exact credit values", () => {
  assert.equal(getModelPickerUsageBand(1), "light");
  assert.equal(getModelPickerUsageBand(4), "medium");
  assert.equal(getModelPickerUsageBand(8), "heavy");
  assert.equal(getModelPickerUsageBand(12), "intensive");
});

test("recommended and capability filters use model behavior", () => {
  assert.deepEqual(RECOMMENDED_MODEL_IDS, [
    "gpt-5-4-mini",
    "claude-sonnet-5",
    "deepseek-r1",
  ]);
  assert.equal(modelMatchesCapability(getModel("deepseek-r1"), "reasoning"), true);
  assert.equal(modelMatchesCapability(getModel("perplexity/sonar"), "search"), true);
  assert.equal(modelMatchesCapability(getModel("gpt-5-4-mini"), "fast"), true);
  assert.equal(modelPickerCopy.ko.personalizedRecommendations, "나에게 추천");
  assert.equal(modelPickerCopy.ko.tomverseRecommendations, "Tomverse 추천");
  assert.equal(modelPickerCopy.en.searchPlaceholder, "Search model names or tasks");
});
