import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS, PUBLIC_MODELS, getModel } from "../lib/models.ts";
import {
  MAX_LOCKED_MODEL_RECOMMENDATIONS,
  MAX_MODEL_RECOMMENDATIONS,
  MODEL_RECOMMENDATION_USE_CASES,
  TARGET_MIN_MODEL_RECOMMENDATIONS,
  getModelRecommendations,
  getReferencedRecommendationModelIds,
  hasSufficientModelRecommendations,
  modelMatchesUseCase,
} from "../lib/modelRecommendations.ts";

const guestInput = {
  models: PUBLIC_MODELS,
  plan: "Guest",
  isGuestMode: true,
};

const freeInput = {
  models: PUBLIC_MODELS,
  plan: "Free",
  isGuestMode: false,
};

test("every use-case candidate is a real registry model", () => {
  const registryIds = new Set(AVAILABLE_MODELS.map((model) => model.id));
  for (const modelId of getReferencedRecommendationModelIds()) {
    assert.ok(
      registryIds.has(modelId),
      `${modelId} is referenced by a use case but missing from the registry`
    );
  }
});

test("recommendations stay within the 6-8 band the picker is designed for", () => {
  for (const input of [guestInput, freeInput]) {
    const recommendations = getModelRecommendations(input);
    assert.ok(
      recommendations.length <= MAX_MODEL_RECOMMENDATIONS,
      `${input.plan} got ${recommendations.length} recommendations`
    );
    assert.ok(recommendations.length >= TARGET_MIN_MODEL_RECOMMENDATIONS);
    assert.equal(hasSufficientModelRecommendations(recommendations), true);
  }
});

test("favourites, model-finder answers and recents never push the list past the cap", () => {
  const recommendations = getModelRecommendations({
    ...freeInput,
    favoriteModelIds: ["claude-sonnet-5", "mistral-large-3", "qwen3.7-max"],
    personalizedModelIds: ["mistral-medium-3-1", "qwen3.7-plus", "glm-5.2"],
    recentModelIds: ["codestral", "kimi-k2.7-code"],
  });
  assert.equal(recommendations.length, MAX_MODEL_RECOMMENDATIONS);
  const ids = recommendations.map((item) => item.modelId);
  assert.equal(new Set(ids).size, ids.length, "recommendations must be unique");
  // Explicit user signals lead the list.
  assert.deepEqual(ids.slice(0, 2), ["claude-sonnet-5", "mistral-large-3"]);
  assert.equal(recommendations[0].source, "favorite");
  assert.equal(recommendations[2].source, "personalized");
});

// A retired model stays in the user's stored favourites and recents forever
// -- nothing rewrites those lists when a model leaves the catalogue -- so the
// recommender is the layer that has to refuse them.
test("retired models a user still has stored are never recommended back", () => {
  const recommendations = getModelRecommendations({
    ...freeInput,
    favoriteModelIds: ["grok-3", "llama-3-3"],
    personalizedModelIds: ["grok-3-mini"],
    recentModelIds: ["llama-3-1", "llama-4-scout", "grok-4"],
  });
  const ids = recommendations.map((item) => item.modelId);
  for (const retiredId of [
    "grok-3",
    "grok-3-mini",
    "grok-4",
    "llama-3-1",
    "llama-3-3",
    "llama-4-scout",
  ]) {
    assert.equal(
      ids.includes(retiredId),
      false,
      `${retiredId} is retired and must not be recommended`
    );
  }
  // The list is still built from the use-case tables rather than collapsing.
  assert.ok(recommendations.length >= TARGET_MIN_MODEL_RECOMMENDATIONS);
});

test("disabled and delisted models are never recommended", () => {
  const recommendations = getModelRecommendations(freeInput);
  for (const recommendation of recommendations) {
    const model = getModel(recommendation.modelId);
    assert.ok(model, `${recommendation.modelId} is not in the registry`);
    assert.equal(model.enabled, true);
    assert.notEqual(model.publiclyListed, false);
  }

  // gemini-2-5-pro is retired in the registry (enabled: false, publiclyListed:
  // false) and must stay out even though it is a plausible analysis model.
  const withRetiredFavorite = getModelRecommendations({
    ...freeInput,
    favoriteModelIds: ["gemini-2-5-pro"],
  });
  assert.equal(
    withRetiredFavorite.some((item) => item.modelId === "gemini-2-5-pro"),
    false
  );
});

test("guests see mostly usable models, with gated ones labelled and capped", () => {
  const recommendations = getModelRecommendations(guestInput);
  const locked = recommendations.filter((item) => item.lock !== "none");

  assert.ok(
    locked.length <= MAX_LOCKED_MODEL_RECOMMENDATIONS,
    `${locked.length} gated models crowded the guest recommendations`
  );
  assert.ok(
    recommendations.length - locked.length >= 4,
    "guests need several models they can run right now"
  );
  for (const recommendation of locked) {
    // Guests are told to sign in, never to upgrade a plan they do not have.
    assert.equal(recommendation.lock, "sign_in");
  }
  for (const recommendation of recommendations) {
    if (recommendation.lock !== "none") continue;
    assert.equal(getModel(recommendation.modelId).minimumPlan, "Guest");
  }
});

test("signed-in users on Free are told to upgrade rather than sign in", () => {
  const recommendations = getModelRecommendations({
    ...freeInput,
    // Force a gated slot by removing the Free-tier research models.
    models: PUBLIC_MODELS.filter(
      (model) => model.id !== "perplexity/sonar" && model.id !== "perplexity/sonar-pro"
    ),
  });
  const research = recommendations.find(
    (item) => item.modelId === "perplexity/sonar-reasoning-pro"
  );
  assert.ok(research, "the search slot should fall through to the Pro model");
  assert.equal(research.lock, "upgrade");
});

test("a provider outage removes the model instead of recommending a dead slot", () => {
  const healthy = getModelRecommendations(freeInput);
  const everydayPick = healthy.find((item) => item.useCase === "everyday");
  assert.equal(everydayPick.modelId, "gpt-5-4-mini");

  const degraded = getModelRecommendations({
    ...freeInput,
    modelStatuses: { "gpt-5-4-mini": "unavailable" },
  });
  assert.equal(
    degraded.some((item) => item.modelId === "gpt-5-4-mini"),
    false
  );
  assert.equal(
    degraded.find((item) => item.useCase === "everyday").modelId,
    "gpt-5-6-luna"
  );
});

test("a degraded provider loses its slot to a healthy alternative but is still selectable", () => {
  const recommendations = getModelRecommendations({
    ...freeInput,
    modelStatuses: { "gpt-5-4-mini": "limited" },
  });
  const everyday = recommendations.find((item) => item.useCase === "everyday");
  assert.equal(everyday.modelId, "gpt-5-6-luna");
  assert.equal(everyday.status, "available");

  // With no healthy alternative left, the limited model is offered and says so.
  const onlyLimited = getModelRecommendations({
    ...freeInput,
    models: PUBLIC_MODELS.filter((model) => model.id === "gpt-5-4-mini"),
    modelStatuses: { "gpt-5-4-mini": "limited" },
  });
  assert.equal(onlyLimited.length, 1);
  assert.equal(onlyLimited[0].status, "limited");
});

test("each use case is filled by a model that actually matches it", () => {
  const recommendations = getModelRecommendations(freeInput);
  const useCasePicks = recommendations.filter((item) =>
    MODEL_RECOMMENDATION_USE_CASES.includes(item.source)
  );
  assert.equal(useCasePicks.length, MODEL_RECOMMENDATION_USE_CASES.length);
  for (const pick of useCasePicks) {
    assert.equal(modelMatchesUseCase(pick.modelId, pick.useCase), true);
  }

  const byUseCase = new Map(useCasePicks.map((item) => [item.useCase, item.modelId]));
  assert.equal(byUseCase.get("search"), "perplexity/sonar");
  assert.equal(byUseCase.get("coding"), "deepseek-v4-flash");
  assert.equal(byUseCase.get("multimodal"), "gemini-3-6-flash");
});

test("recommended cards carry the cost and capabilities the card renders", () => {
  const recommendations = getModelRecommendations(freeInput);
  const research = recommendations.find(
    (item) => item.modelId === "perplexity/sonar"
  );
  assert.equal(research.credits, 20);
  assert.deepEqual(research.features, ["search"]);
  for (const recommendation of recommendations) {
    assert.ok(recommendation.credits > 0);
    assert.ok(recommendation.features.length <= 2);
  }
});

test("staged image attachments exclude models that cannot read images", () => {
  const recommendations = getModelRecommendations({
    ...freeInput,
    requiresImageInput: true,
  });
  assert.ok(recommendations.length > 0);
  for (const recommendation of recommendations) {
    assert.equal(
      getModel(recommendation.modelId).inputCapabilities?.image,
      true,
      `${recommendation.modelId} cannot accept images`
    );
  }
  // The text-only research models drop out entirely rather than being offered
  // and then refusing the attachment.
  assert.equal(
    recommendations.some((item) => item.modelId === "perplexity/sonar"),
    false
  );
});

test("a thin registry returns only what is available instead of padding", () => {
  const recommendations = getModelRecommendations({
    ...freeInput,
    models: PUBLIC_MODELS.filter((model) =>
      ["gpt-5-4-mini", "claude-haiku-4-5"].includes(model.id)
    ),
  });
  assert.equal(recommendations.length, 2);
  assert.equal(hasSufficientModelRecommendations(recommendations), false);
  assert.deepEqual(
    recommendations.map((item) => item.modelId).sort(),
    ["claude-haiku-4-5", "gpt-5-4-mini"]
  );
});

test("registry edits flow straight through to the recommendations", () => {
  const withoutFlash = PUBLIC_MODELS.map((model) =>
    model.id === "gemini-3-6-flash"
      ? { ...model, enabled: false, status: "disabled" }
      : model
  );
  const recommendations = getModelRecommendations({
    ...freeInput,
    models: withoutFlash,
  });
  assert.equal(
    recommendations.some((item) => item.modelId === "gemini-3-6-flash"),
    false
  );
  assert.equal(
    recommendations.find((item) => item.useCase === "multimodal").modelId,
    "gemini-3-5-flash"
  );
});

test("guests get a stable set that does not depend on personalization", () => {
  const first = getModelRecommendations(guestInput);
  const second = getModelRecommendations(guestInput);
  assert.deepEqual(
    first.map((item) => item.modelId),
    second.map((item) => item.modelId)
  );
  // Selecting a model must not reshuffle or shrink the set -- it only flips the
  // card's selected state, so the recommendations stay a stable frame of
  // reference while the user builds a comparison.
  const withSelection = getModelRecommendations({
    ...guestInput,
    selectedModelIds: [first[0].modelId],
  });
  assert.deepEqual(
    withSelection.map((item) => item.modelId),
    first.map((item) => item.modelId)
  );
  assert.equal(withSelection[0].isSelected, true);
  assert.equal(withSelection[1].isSelected, false);
});

test("a non-English interface prefers a multilingual cost-efficient model", () => {
  const english = getModelRecommendations({ ...freeInput, language: "en" });
  const korean = getModelRecommendations({ ...freeInput, language: "ko" });
  assert.equal(
    english.find((item) => item.useCase === "value").modelId,
    "gpt-5-6-luna"
  );
  assert.equal(
    korean.find((item) => item.useCase === "value").modelId,
    "mistral-small-4"
  );
});
