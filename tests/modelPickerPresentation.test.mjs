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
  modelPickerStepCopy,
  modelPickerUseCaseLabels,
} from "../lib/modelPickerPresentation.ts";
import { MODEL_RECOMMENDATION_USE_CASES } from "../lib/modelRecommendations.ts";

const PICKER_LANGUAGES = ["en", "ko", "zh", "fr", "de", "es", "pt"];

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
    "search",
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
    "gpt-5-6-luna",
    "claude-sonnet-5",
    "gemini-3-6-flash",
  ]);
  assert.equal(modelMatchesCapability(getModel("grok-4-5"), "reasoning"), true);
  // A retired model still classifies correctly -- the reasoning filter reads
  // the model's own capability, not its lifecycle.
  assert.equal(modelMatchesCapability(getModel("deepseek-r1"), "reasoning"), true);
  assert.equal(modelMatchesCapability(getModel("perplexity/sonar"), "search"), true);
  assert.equal(modelMatchesCapability(getModel("gpt-5-4-mini"), "fast"), true);
  assert.equal(modelPickerCopy.ko.personalizedRecommendations, "나에게 추천");
  assert.equal(modelPickerCopy.ko.tomverseRecommendations, "Tomverse 추천");
  assert.equal(modelPickerCopy.en.searchPlaceholder, "Search model names or tasks");
});

test("the two-step picker is fully translated in every supported language", () => {
  const requiredKeys = Object.keys(modelPickerStepCopy.en);
  assert.ok(requiredKeys.length > 0);

  for (const language of PICKER_LANGUAGES) {
    const copy = modelPickerStepCopy[language];
    assert.ok(copy, `${language} is missing step copy`);
    assert.deepEqual(
      Object.keys(copy).sort(),
      requiredKeys.slice().sort(),
      `${language} step copy has different keys to en`
    );
    for (const [key, value] of Object.entries(copy)) {
      assert.ok(value.trim().length > 0, `${language}.${key} is empty`);
    }
    // Interpolated copy must keep its placeholder, otherwise the count or the
    // model cap silently disappears from the UI.
    assert.ok(copy.resultCount.includes("{count}"), `${language} lost {count}`);
    assert.ok(copy.activeFilters.includes("{count}"), `${language} lost {count}`);
    assert.ok(copy.maxReached.includes("{max}"), `${language} lost {max}`);
  }
});

test("recommendation reasons are task language, not provider names", () => {
  const providerWords = [
    "openai",
    "gpt",
    "anthropic",
    "claude",
    "google",
    "gemini",
    "deepseek",
    "mistral",
    "perplexity",
    "qwen",
    "grok",
    "llama",
  ];

  for (const language of PICKER_LANGUAGES) {
    const labels = modelPickerUseCaseLabels[language];
    assert.ok(labels, `${language} is missing use-case labels`);
    for (const useCase of MODEL_RECOMMENDATION_USE_CASES) {
      assert.ok(
        labels[useCase]?.trim().length > 0,
        `${language}.${useCase} needs a task-language reason`
      );
    }
    for (const extraSource of ["favorite", "personalized", "recent"]) {
      assert.ok(labels[extraSource]?.trim().length > 0);
    }
    for (const [key, label] of Object.entries(labels)) {
      const normalized = label.toLowerCase();
      for (const word of providerWords) {
        assert.equal(
          normalized.includes(word),
          false,
          `${language}.${key} names a provider instead of the task`
        );
      }
    }
  }
});
