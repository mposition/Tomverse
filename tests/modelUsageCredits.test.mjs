import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseModelWithPlan,
  PUBLIC_MODELS,
  getEnabledModel,
  getInputCreditMultiplier,
  getModel,
  getModelBillingProfile,
  getModelUsageProfile,
  getSettledUsageCredits,
  getTypicalShortRequestCapacities,
  getWeightedUsageCredits,
  modelSupportsImageInput,
  modelSupportsNativePdfInput,
} from "../lib/models.ts";

const profile = (modelId) => getModelUsageProfile(getModel(modelId));

test("model usage profiles match the launch credit examples", () => {
  assert.deepEqual(profile("gpt-5-5"), { category: "Premium", credits: 8 });
  assert.deepEqual(profile("claude-sonnet-5"), {
    category: "Advanced",
    credits: 4,
  });
  assert.deepEqual(profile("claude-opus-4-8"), {
    category: "Premium",
    credits: 8,
  });
  assert.deepEqual(profile("perplexity/sonar-deep-research"), {
    category: "Research",
    credits: 30,
  });
  assert.deepEqual(profile("deepseek-v4-pro"), {
    category: "Standard",
    credits: 1,
  });
});

test("model usage classes are independent from subscription access", () => {
  const premium = getModel("gpt-5-5");
  const guestStandard = getModel("gpt-5-4-mini");
  const freeStandard = getModel("gemini-3-5-flash");

  assert.equal(premium.minimumPlan, "Pro");
  assert.equal(canUseModelWithPlan("Free", premium), false);
  assert.equal(canUseModelWithPlan("Pro", premium), true);
  assert.equal(canUseModelWithPlan("Max", premium), true);

  assert.equal(canUseModelWithPlan("Guest", guestStandard), true);
  assert.equal(getModelUsageProfile(guestStandard).category, "Standard");

  assert.equal(getModelUsageProfile(freeStandard).category, "Standard");
  assert.equal(freeStandard.minimumPlan, "Free");
  assert.equal(canUseModelWithPlan("Guest", freeStandard), false);
  assert.equal(canUseModelWithPlan("Free", freeStandard), true);
});

test("retired Gemini 2.5 Pro is not callable and points to its replacement", () => {
  const retired = getModel("gemini-2-5-pro");
  assert.equal(retired.enabled, false);
  assert.equal(retired.status, "disabled");
  assert.equal(retired.replacementModelId, "gemini-3-1-pro");
  assert.equal(retired.publiclyListed, false);
  assert.equal(PUBLIC_MODELS.some((model) => model.id === retired.id), false);
  assert.equal(getEnabledModel(retired.id), undefined);
  assert.equal(getEnabledModel(retired.replacementModelId)?.enabled, true);
});

test("Llama 4 Scout is a Standard vision model with explicit Groq limits", () => {
  const scout = getModel("llama-4-scout");
  assert.ok(scout);
  assert.equal(scout.apiModel, "meta-llama/llama-4-scout-17b-16e-instruct");
  assert.deepEqual(getModelUsageProfile(scout), {
    category: "Standard",
    credits: 1,
  });
  assert.equal(scout.contextWindowTokens, 131_072);
  assert.equal(modelSupportsImageInput(scout), true);
  assert.equal(modelSupportsNativePdfInput(scout), false);
  assert.equal(scout.inputCapabilities?.maxImages, 5);
  assert.equal(
    scout.inputCapabilities?.maxBase64ImagePayloadBytes,
    4 * 1024 * 1024
  );
  assert.equal(modelSupportsImageInput(getModel("llama-3-1")), false);
});

test("long input applies the configured credit multiplier", () => {
  const premium = getModel("gpt-5-5");
  assert.equal(getInputCreditMultiplier(16_000), 1);
  assert.equal(getInputCreditMultiplier(16_001), 1.5);
  assert.equal(getInputCreditMultiplier(50_001), 2);
  assert.equal(getInputCreditMultiplier(100_001), 3);
  assert.equal(getWeightedUsageCredits(premium, 60_000), 16);
});

test("pricing examples are derived from the same launch credit weights", () => {
  assert.deepEqual(getTypicalShortRequestCapacities(300), {
    standardResponses: 300,
    advancedResponses: 75,
    mixedComparisons: 23,
    mixedComparisonCredits: 13,
  });
  assert.deepEqual(getTypicalShortRequestCapacities(3_000), {
    standardResponses: 3_000,
    advancedResponses: 750,
    mixedComparisons: 230,
    mixedComparisonCredits: 13,
  });
  assert.deepEqual(getTypicalShortRequestCapacities(10_000), {
    standardResponses: 10_000,
    advancedResponses: 2_500,
    mixedComparisons: 769,
    mixedComparisonCredits: 13,
  });
});

test("credit settlement refunds failures and empty responses", () => {
  const base = {
    reservedCredits: 16,
    reservedInputTokens: 60_000,
    reservedOutputTokens: 8_000,
    actualInputTokens: 60_000,
  };
  assert.equal(
    getSettledUsageCredits({
      ...base,
      actualOutputTokens: 2_000,
      outcome: "completed",
    }),
    16
  );
  assert.equal(
    getSettledUsageCredits({
      ...base,
      actualOutputTokens: 0,
      outcome: "failed",
    }),
    0
  );
  assert.equal(
    getSettledUsageCredits({
      ...base,
      actualOutputTokens: 0,
      outcome: "empty",
    }),
    0
  );
  assert.equal(
    getSettledUsageCredits({
      ...base,
      actualOutputTokens: 8,
      outcome: "cancelled",
    }),
    0
  );
  const partial = getSettledUsageCredits({
    ...base,
    actualOutputTokens: 1_000,
    outcome: "cancelled",
  });
  assert.ok(partial > 0 && partial < 16);
});

test("cost reservations use realistic output while preserving provider output caps", () => {
  const premium = getModelBillingProfile(getModel("gpt-5-5"));
  assert.equal(premium.maxOutputTokens, 8_192);
  assert.equal(premium.reservationOutputTokens, 2_048);

  const threePremiumOutputReservationMicroUsd =
    3 * premium.reservationOutputTokens * premium.outputUsdPerMillionTokens;
  assert.equal(threePremiumOutputReservationMicroUsd, 368_640);
  assert.ok(threePremiumOutputReservationMicroUsd < 1_500_000);
});
