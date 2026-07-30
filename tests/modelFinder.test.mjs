import assert from "node:assert/strict";
import test from "node:test";
import {
  getComplementaryModelSuggestion,
  getContextualModelSuggestion,
  getModelFinderCombination,
  getModelFinderRecommendations,
  getOptionalModelSuggestion,
  isModelFinderDefaultId,
} from "../lib/modelFinder.ts";

test("model finder returns at most three free Standard defaults", () => {
  const recommendations = getModelFinderRecommendations({
    tasks: ["documents", "general"],
    priority: "fast",
    fileUsage: "documents",
  });
  assert.ok(recommendations.length > 0);
  assert.ok(recommendations.length <= 3);
  assert.ok(recommendations.every(({ modelId }) => isModelFinderDefaultId(modelId)));
  assert.equal(recommendations[0].modelId, "gemini-2-5-flash");
});

test("coding and multilingual work map to suitable Standard models", () => {
  const coding = getModelFinderRecommendations({
    tasks: ["coding"],
    priority: "fast",
    fileUsage: "rarely",
  });
  const multilingual = getModelFinderRecommendations({
    tasks: ["multilingual"],
    priority: "balanced",
    fileUsage: "rarely",
  });
  assert.equal(coding[0].modelId, "deepseek-v4-flash");
  assert.ok(["mistral-small-4", "qwen3.6-flash"].includes(multilingual[0].modelId));
});

test("Advanced and Research models are optional, never default recommendations", () => {
  const deep = getOptionalModelSuggestion({
    tasks: ["documents"],
    priority: "deep",
    fileUsage: "documents",
  });
  const research = getOptionalModelSuggestion({
    tasks: ["research"],
    priority: "sources",
    fileUsage: "rarely",
  });
  assert.deepEqual(deep, {
    modelId: "claude-sonnet-5",
    reason: "deep_analysis",
  });
  assert.deepEqual(research, {
    modelId: "perplexity/sonar",
    reason: "research",
  });
});

test("contextual suggestions classify locally without returning prompt content", () => {
  const suggestion = getContextualModelSuggestion({
    text: "이 계약서의 위험 조항을 분석해줘",
    attachments: [{ name: "contract.pdf", mediaType: "application/pdf" }],
  });
  assert.equal(suggestion?.modelId, "claude-sonnet-5");
  assert.deepEqual(Object.keys(suggestion || {}).sort(), ["key", "modelId", "reason"]);
});

test("model finder combination always returns 2-3 distinct models with a primary matching the ranked top pick", () => {
  const answers = { tasks: ["documents", "coding"], priority: "fast" };
  const combo = getModelFinderCombination(answers);
  const topRanked = getModelFinderRecommendations({
    ...answers,
    fileUsage: "rarely",
  })[0];

  assert.ok(combo.length === 2 || combo.length === 3);
  assert.equal(new Set(combo.map((pick) => pick.modelId)).size, combo.length);
  assert.equal(combo[0].role, "primary");
  assert.equal(combo[0].modelId, topRanked.modelId);
  assert.ok(
    combo
      .filter((pick) => pick.role !== "advanced")
      .every((pick) => isModelFinderDefaultId(pick.modelId))
  );
});

test("a research-and-sources answer includes an advanced research add-on", () => {
  const combo = getModelFinderCombination({
    tasks: ["research"],
    priority: "sources",
  });
  const advanced = combo.find((pick) => pick.role === "advanced");
  assert.equal(advanced?.modelId, "perplexity/sonar");
  assert.equal(advanced?.reasonKey, "modelFinder.optionalResearch");
});

test("complementary suggestion fills the missing capability in priority order", () => {
  const noReasoningOrResearch = getComplementaryModelSuggestion([
    "gpt-5-4-mini",
    "gemini-2-5-flash",
  ]);
  assert.deepEqual(noReasoningOrResearch, {
    modelId: "deepseek-r1",
    reason: "reasoning",
  });

  const hasReasoningOnly = getComplementaryModelSuggestion([
    "deepseek-r1",
    "gemini-2-5-flash",
  ]);
  assert.deepEqual(hasReasoningOnly, {
    modelId: "perplexity/sonar",
    reason: "research",
  });

  const hasReasoningAndResearch = getComplementaryModelSuggestion([
    "deepseek-r1",
    "perplexity/sonar",
  ]);
  assert.deepEqual(hasReasoningAndResearch, {
    modelId: "gpt-5-4-mini",
    reason: "different_provider",
  });
});

test("complementary suggestion never re-suggests an already-selected model", () => {
  const suggestion = getComplementaryModelSuggestion([
    "deepseek-r1",
    "deepseek-v4-flash",
  ]);
  assert.equal(suggestion?.modelId, "perplexity/sonar");
  assert.notEqual(suggestion?.modelId, "deepseek-r1");
  assert.notEqual(suggestion?.modelId, "deepseek-v4-flash");
});
