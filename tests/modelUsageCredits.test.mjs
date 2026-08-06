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
  MODEL_USAGE_CREDIT_WEIGHTS,
} from "../lib/models.ts";

const profile = (modelId) => getModelUsageProfile(getModel(modelId));

test("model usage profiles match the launch credit examples", () => {
  assert.deepEqual(profile("gpt-5-5"), { category: "Premium", credits: 16 });
  assert.deepEqual(profile("claude-sonnet-5"), {
    category: "Advanced",
    credits: 4,
  });
  assert.deepEqual(profile("claude-opus-4-8"), {
    category: "Premium",
    credits: 16,
  });
  assert.deepEqual(profile("claude-fable-5"), {
    category: "Reasoning",
    credits: 20,
  });
  assert.deepEqual(profile("kimi-k3"), {
    category: "Reasoning",
    credits: 16,
  });
  assert.deepEqual(profile("minimax-m3"), {
    category: "Advanced",
    credits: 1,
  });
  assert.deepEqual(profile("perplexity/sonar-deep-research"), {
    category: "Research",
    credits: 16,
  });
  assert.deepEqual(profile("deepseek-v4-pro"), {
    category: "Standard",
    credits: 1,
  });
});

test("model usage classes are independent from subscription access", () => {
  const premium = getModel("gpt-5-5");
  const guestStandard = getModel("gpt-5-4-mini");
  const freeAdvanced = getModel("gemini-3-6-flash");

  assert.equal(premium.minimumPlan, "Pro");
  assert.equal(canUseModelWithPlan("Free", premium), false);
  assert.equal(canUseModelWithPlan("Pro", premium), true);
  assert.equal(canUseModelWithPlan("Max", premium), true);

  assert.equal(canUseModelWithPlan("Guest", guestStandard), true);
  assert.equal(getModelUsageProfile(guestStandard).category, "Standard");

  assert.equal(getModelUsageProfile(freeAdvanced).category, "Advanced");
  assert.equal(getModelUsageProfile(freeAdvanced).credits, 4);
  assert.equal(freeAdvanced.minimumPlan, "Free");
  assert.equal(canUseModelWithPlan("Guest", freeAdvanced), false);
  assert.equal(canUseModelWithPlan("Free", freeAdvanced), true);
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

test("new catalogue plans and credit weights follow their verified cost bands", () => {
  const expected = {
    "gpt-5-6-sol": ["Pro", "Premium", 16],
    "gpt-5-6-terra": ["Free", "Advanced", 4],
    "gpt-5-6-luna": ["Guest", "Standard", 1],
    "gemini-3-6-flash": ["Free", "Advanced", 4],
    "gemini-3-5-flash": ["Free", "Advanced", 4],
    "gemini-2-5-flash": ["Guest", "Standard", 1],
    "mistral-medium-3-1": ["Free", "Advanced", 4],
    "claude-fable-5": ["Pro", "Reasoning", 20],
    "kimi-k3": ["Pro", "Reasoning", 16],
    "minimax-m3": ["Free", "Advanced", 1],
  };

  for (const [id, [minimumPlan, category, credits]] of Object.entries(expected)) {
    const model = getModel(id);
    assert.equal(model.minimumPlan, minimumPlan, id);
    assert.deepEqual(getModelUsageProfile(model), { category, credits }, id);
  }
});

test("new catalogue models expose verified context, output and attachment capabilities", () => {
  for (const id of ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-5-6-luna"]) {
    const model = getModel(id);
    assert.equal(model.contextWindowTokens, 1_050_000, id);
    assert.equal(getModelBillingProfile(model).maxOutputTokens, 128_000, id);
    assert.equal(modelSupportsImageInput(model), true, id);
    assert.equal(modelSupportsNativePdfInput(model), true, id);
  }

  for (const id of ["gemini-3-6-flash", "gemini-3-5-flash", "gemini-2-5-flash"]) {
    const model = getModel(id);
    assert.equal(model.contextWindowTokens, 1_048_576, id);
    assert.equal(getModelBillingProfile(model).maxOutputTokens, 65_536, id);
    assert.equal(modelSupportsImageInput(model), true, id);
    assert.equal(modelSupportsNativePdfInput(model), true, id);
  }

  // Retired here rather than launched, but the capability fields stay
  // asserted: they are what an old transcript renders from, and what a
  // future relisting would start from.
  const grok = getModel("grok-4-3");
  assert.equal(grok.contextWindowTokens, 1_000_000);
  assert.equal(modelSupportsImageInput(grok), true);
  assert.equal(modelSupportsNativePdfInput(grok), false);

  const grok45 = getModel("grok-4-5");
  assert.equal(grok45.contextWindowTokens, 500_000);
  assert.equal(modelSupportsImageInput(grok45), true);

  const mistral = getModel("mistral-medium-3-1");
  assert.equal(mistral.apiModel, "mistral-medium-3-5");
  assert.equal(mistral.contextWindowTokens, 262_144);
  assert.equal(modelSupportsImageInput(mistral), true);
  assert.equal(modelSupportsNativePdfInput(mistral), false);

  const kimi = getModel("kimi-k3");
  assert.equal(kimi.contextWindowTokens, 1_048_576);
  // The window and the request's output cap are different numbers. They were
  // the same one, and the pair could never fit together, so every Kimi K3
  // request was refused before it reached the provider.
  assert.equal(getModelBillingProfile(kimi).maxOutputTokens, 131_072);
  assert.equal(modelSupportsImageInput(kimi), true);

  const minimax = getModel("minimax-m3");
  assert.equal(minimax.apiModel, "MiniMax-M3");
  assert.equal(minimax.contextWindowTokens, 1_000_000);
  assert.equal(getModelBillingProfile(minimax).maxOutputTokens, 524_288);
  assert.equal(modelSupportsImageInput(minimax), true);
});

test("long input applies the configured credit multiplier", () => {
  const premium = getModel("gpt-5-5");
  assert.equal(getInputCreditMultiplier(16_000), 1);
  assert.equal(getInputCreditMultiplier(16_001), 1.5);
  assert.equal(getInputCreditMultiplier(50_001), 2);
  assert.equal(getInputCreditMultiplier(100_001), 3);
  // gpt-5-5 now carries an explicit 16-credit weight; 2x at 60,000 tokens.
  assert.equal(getWeightedUsageCredits(premium, 60_000), 32);
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

test("native web search surcharge is refunded when the provider didn't actually search", () => {
  const base = {
    reservedCredits: 12,
    reservedInputTokens: 10_000,
    reservedOutputTokens: 2_000,
    actualInputTokens: 10_000,
    actualOutputTokens: 500,
  };
  const surcharge = MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge;

  assert.equal(
    getSettledUsageCredits({
      ...base,
      outcome: "completed",
      searchSurchargeCredits: surcharge,
      searchExecuted: true,
    }),
    12
  );
  assert.equal(
    getSettledUsageCredits({
      ...base,
      outcome: "completed",
      searchSurchargeCredits: surcharge,
      searchExecuted: false,
    }),
    12 - surcharge
  );
  assert.equal(
    getSettledUsageCredits({
      ...base,
      reservedCredits: surcharge - 1,
      outcome: "completed",
      searchSurchargeCredits: surcharge,
      searchExecuted: false,
    }),
    0
  );
  // Calls that never requested search rely on the defaults (searchExecuted
  // defaults to true, searchSurchargeCredits defaults to 0) -- nothing is
  // refunded, so pre-existing non-search settlement is unaffected.
  assert.equal(getSettledUsageCredits({ ...base, outcome: "completed" }), 12);
});

test("a cancelled request never leaves the search surcharge charged when the search didn't execute", () => {
  const surcharge = MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge;
  const base = {
    reservedCredits: 12,
    reservedInputTokens: 10_000,
    reservedOutputTokens: 2_000,
    actualInputTokens: 10_000,
    // Above the 16-token cancelled-proration floor.
    actualOutputTokens: 1_000,
    outcome: "cancelled",
    searchSurchargeCredits: surcharge,
  };

  const executedProration = getSettledUsageCredits({
    ...base,
    searchExecuted: true,
  });
  const notExecutedProration = getSettledUsageCredits({
    ...base,
    searchExecuted: false,
  });
  // The not-executed proration is computed from a strictly smaller base
  // (reservedCredits - surcharge), so it must never exceed the
  // surcharge-included proration, and must never exceed reservedCredits
  // minus the surcharge.
  assert.ok(notExecutedProration < executedProration);
  assert.ok(notExecutedProration <= 12 - surcharge);

  // Below the 16-token floor, a cancelled request is a full refund
  // regardless of the surcharge -- unaffected by this change.
  assert.equal(
    getSettledUsageCredits({
      ...base,
      actualOutputTokens: 10,
      searchExecuted: false,
    }),
    0
  );
});

test("cost reservations use realistic output while preserving provider output caps", () => {
  const premium = getModelBillingProfile(getModel("gpt-5-5"));
  assert.equal(premium.maxOutputTokens, 8_192);
  // Raised from a shared 2,048 to a per-model p90: a reservation far below the
  // real answer is settled upward afterwards and therefore protects nothing.
  assert.equal(premium.reservationOutputTokens, 4_096);
  assert.equal(premium.outputUsdPerMillionTokens, 30);

  // The three models from the production incident, reserved together. Under
  // the old generic premium price (US$60/MTok output, 2,048 reserved tokens)
  // this was 368,640 micro-USD against a hidden US$1.50 daily ceiling; the
  // real prices make the same comparison materially cheaper on input and the
  // guardrail is now derived from the plan's own credits instead.
  const outputReservation = (modelId) => {
    const profile = getModelBillingProfile(getModel(modelId));
    return profile.reservationOutputTokens * profile.outputUsdPerMillionTokens;
  };
  const incidentOutputReservationMicroUsd =
    outputReservation("gpt-5-5-thinking") +
    outputReservation("claude-opus-4-8") +
    outputReservation("gemini-3-1-pro");
  // Opus 5 reserves 8,192 tokens because adaptive thinking now shares its
  // 128K output allowance; the stable Tomverse id remains claude-opus-4-8.
  assert.equal(incidentOutputReservationMicroUsd, 184_320 + 204_800 + 49_152);
});
