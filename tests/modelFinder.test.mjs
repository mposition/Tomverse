import assert from "node:assert/strict";
import test from "node:test";
import {
  getContextualModelSuggestion,
  getModelFinderRecommendations,
  getOptionalModelSuggestion,
  isModelFinderDefaultId,
} from "../lib/modelFinder.ts";
import {
  getModelFinderReappearsAt,
  shouldAutoShowModelFinder,
} from "../lib/modelFinderSnooze.ts";

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

test("model finder dismissal snoozes automatic onboarding for three days", () => {
  const dismissedAt = new Date("2026-07-15T10:00:00.000Z");
  assert.equal(
    getModelFinderReappearsAt(dismissedAt)?.toISOString(),
    "2026-07-18T10:00:00.000Z"
  );
  assert.equal(
    shouldAutoShowModelFinder({
      completedAt: null,
      dismissedAt,
      now: new Date("2026-07-18T09:59:59.999Z"),
    }),
    false
  );
  assert.equal(
    shouldAutoShowModelFinder({
      completedAt: null,
      dismissedAt,
      now: new Date("2026-07-18T10:00:00.000Z"),
    }),
    true
  );
});

test("completed model finder never auto-opens after a previous dismissal", () => {
  assert.equal(
    shouldAutoShowModelFinder({
      completedAt: new Date("2026-07-16T10:00:00.000Z"),
      dismissedAt: new Date("2026-07-15T10:00:00.000Z"),
      now: new Date("2026-07-20T10:00:00.000Z"),
    }),
    false
  );
});
