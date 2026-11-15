import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS, PUBLIC_MODELS, getModel } from "../lib/models.ts";
import {
  MAX_LOCKED_MODEL_RECOMMENDATIONS,
  FEATURED_PROVIDERS,
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

const providerOf = (models, modelId) => models.find((model) => model.id === modelId)?.provider;
const creditsOf = (recommendations, modelId) => recommendations.find((item) => item.modelId === modelId)?.credits;

test("signed-in users on Free are told to upgrade rather than sign in", () => {
  const recommendations = getModelRecommendations(freeInput);
  const gated = recommendations.filter((item) => item.lock !== "none");
  assert.ok(gated.length >= 1, "a provider with only Pro models is shown gated");
  for (const item of gated) assert.equal(item.lock, "upgrade");
});

test("the first screen is one card per provider: its top model the viewer can run", () => {
  // Owner decision 2026-11-15. The screen used to fill seven task slots from
  // tables of model ids: one provider could take two cards while a provider
  // whose models were added in the Admin catalogue could take none.
  for (const input of [guestInput, freeInput, { ...freeInput, plan: "Pro" }]) {
    const recommendations = getModelRecommendations(input);
    const providers = recommendations.map((item) => providerOf(input.models, item.modelId));
    assert.equal(new Set(providers).size, providers.length, `${input.plan}: ${providers.join(",")}`);
    // The featured providers lead, in their own order.
    assert.deepEqual(providers.slice(0, FEATURED_PROVIDERS.length), [...FEATURED_PROVIDERS]);
    for (const pick of recommendations.filter((item) => item.lock === "none" && item.status === "available")) {
      const provider = providerOf(input.models, pick.modelId);
      const dearer = getModelRecommendations({
        ...input,
        models: input.models.filter((model) => model.provider === provider),
      }).find((item) => item.lock === "none" && item.status === "available");
      // Asked about that provider alone, the answer is the same model.
      assert.equal(dearer.modelId, pick.modelId);
    }
  }
  const pro = getModelRecommendations({ ...freeInput, plan: "Pro" });
  const free = getModelRecommendations(freeInput);
  const openAi = (list) => list.find((item) => providerOf(PUBLIC_MODELS, item.modelId) === "openai");
  // A higher plan sees a higher model of the same provider.
  assert.ok(openAi(pro).credits > openAi(free).credits);
});

test("a model the Admin catalogue added needs no table entry to be its provider's card", () => {
  // In production on 2026-11-15 no enabled Gemini or Grok model was in any
  // table, so neither provider could reach the first screen.
  const models = [
    ...PUBLIC_MODELS.filter((model) => model.provider !== "google"),
    { ...getModel("gpt-6-luna"), id: "gemini-next", name: "Gemini Next", provider: "google", usageClass: "advanced", minimumPlan: "Free" },
  ];
  const recommendations = getModelRecommendations({ ...freeInput, models });
  const card = recommendations.find((item) => item.modelId === "gemini-next");
  assert.ok(card);
  assert.equal(card.lock, "none");
  // Its reason line and the task filter come from its profile.
  assert.equal(card.useCase, "writing");
  const model = models.find((entry) => entry.id === "gemini-next");
  assert.equal(modelMatchesUseCase("gemini-next", "writing", model), true);
  assert.equal(modelMatchesUseCase("gemini-next", "coding", model), false);
  // A listed model keeps its hand-written tasks, whatever its profile says.
  assert.equal(modelMatchesUseCase("perplexity/sonar", "everyday", getModel("perplexity/sonar")), false);
  assert.equal(MODEL_RECOMMENDATION_USE_CASES.includes(card.source), true);
});

test("a provider outage removes the model instead of recommending a dead slot", () => {
  const healthy = getModelRecommendations(freeInput);
  const openAi = healthy.find((item) => providerOf(PUBLIC_MODELS, item.modelId) === "openai");
  const degraded = getModelRecommendations({
    ...freeInput,
    modelStatuses: { [openAi.modelId]: "unavailable" },
  });
  assert.equal(degraded.some((item) => item.modelId === openAi.modelId), false);
  // The provider keeps its card: its next model takes it.
  const next = degraded.find((item) => providerOf(PUBLIC_MODELS, item.modelId) === "openai");
  assert.ok(next);
  assert.ok(next.credits <= creditsOf(healthy, openAi.modelId));
});

test("a degraded model loses its provider's card to a healthy one but is still selectable", () => {
  const healthy = getModelRecommendations(freeInput);
  const openAi = healthy.find((item) => providerOf(PUBLIC_MODELS, item.modelId) === "openai");
  const recommendations = getModelRecommendations({
    ...freeInput,
    modelStatuses: { [openAi.modelId]: "limited" },
  });
  const card = recommendations.find((item) => providerOf(PUBLIC_MODELS, item.modelId) === "openai");
  assert.notEqual(card.modelId, openAi.modelId);
  assert.equal(card.status, "available");

  // With no healthy alternative left, the limited model is offered and says so.
  const onlyLimited = getModelRecommendations({
    ...freeInput,
    models: PUBLIC_MODELS.filter((model) => model.id === "gpt-5-4-mini"),
    modelStatuses: { "gpt-5-4-mini": "limited" },
  });
  assert.equal(onlyLimited.length, 1);
  assert.equal(onlyLimited[0].status, "limited");
});

test("recommended cards carry the cost and capabilities the card renders", () => {
  const research = getModelRecommendations({
    ...freeInput,
    models: PUBLIC_MODELS.filter((model) => model.provider === "perplexity"),
  });
  assert.equal(research.length, 1);
  assert.equal(research[0].useCase, "search");
  assert.deepEqual(research[0].features, ["search"]);
  for (const recommendation of getModelRecommendations(freeInput)) {
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
  const google = getModelRecommendations(freeInput).find(
    (item) => providerOf(PUBLIC_MODELS, item.modelId) === "google"
  );
  const withoutIt = PUBLIC_MODELS.map((model) =>
    model.id === google.modelId ? { ...model, enabled: false, status: "disabled" } : model
  );
  const recommendations = getModelRecommendations({ ...freeInput, models: withoutIt });
  assert.equal(recommendations.some((item) => item.modelId === google.modelId), false);
  const next = recommendations.find((item) => providerOf(withoutIt, item.modelId) === "google");
  assert.ok(next, "another Google model takes the provider's card");
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

test("every guest trio model is a recommendation candidate, so a new guest sees its selection in the picker", async () => {
  const { GUEST_BRAND_TRIO_MODEL_IDS } = await import("../lib/appDefaults.ts");
  const recommendations = getModelRecommendations({
    ...guestInput,
    selectedModelIds: [...GUEST_BRAND_TRIO_MODEL_IDS],
  });
  for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    const item = recommendations.find((entry) => entry.modelId === modelId);
    assert.ok(item, `${modelId} is recommended to a guest`);
    assert.equal(item.isSelected, true);
  }
});
