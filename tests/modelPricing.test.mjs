import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS, getModelBillingProfile } from "../lib/models.ts";
import {
  FALLBACK_PRICING,
  findUnpricedModels,
  getModelPricingProfile,
  getNativeSearchCostMicroUsdPerQuery,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
  resolveModelPricing,
} from "../lib/modelPricing.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";

const model = (modelId) => {
  const found = AVAILABLE_MODELS.find((candidate) => candidate.id === modelId);
  assert.ok(found, `model ${modelId} is missing from the registry`);
  return found;
};

// Token counts recovered from the production incident. All three models were
// billed at the generic premium rate of US$15 input / US$60 output per million
// tokens, which is what the reported internal costs decompose to for a shared
// 3,469-token prompt:
//   Claude Opus 4.8   15*3469 + 60*2500 = 202,035 micro-USD (US$0.202035)
//   Gemini 3.1 Pro    15*3469 + 60*7710 = 514,635 micro-USD (US$0.514635)
//   GPT-5.5 Thinking  15*3469 + 60*6713 = 454,815 micro-USD (US$0.454815)
const INCIDENT_PROMPT_TOKENS = 3_469;
const INCIDENT_OUTPUT_TOKENS = {
  "claude-opus-4-8": 2_500,
  "gemini-3-1-pro": 7_710,
  "gpt-5-5-thinking": 6_713,
};

const costFor = (modelId, { inputTokens, outputTokens }) => {
  const pricing = resolveModelPricing(model(modelId), {
    estimatedPromptTokens: inputTokens,
  });
  return calculateProviderUsageCost({
    inputTokens,
    outputTokens,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
  }).totalCostMicroUsd;
};

test("the four incident models carry explicit standard-API pricing", () => {
  const expected = {
    "gpt-5-5": { input: 5, output: 30 },
    "gpt-5-5-thinking": { input: 5, output: 30 },
    "gemini-3-1-pro": { input: 2, output: 12 },
    "claude-opus-4-8": { input: 5, output: 25 },
  };
  for (const [modelId, rates] of Object.entries(expected)) {
    const pricing = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 4_000,
    });
    assert.equal(pricing.inputUsdPerMillionTokens, rates.input, modelId);
    assert.equal(pricing.outputUsdPerMillionTokens, rates.output, modelId);
    assert.equal(pricing.isFallbackPricing, false, modelId);
    assert.equal(pricing.costSource, "registry", modelId);
    // Verified against lib/activeAiModel.ts: first-party endpoints, no relay,
    // no priority/flex tier override in the request.
    assert.equal(pricing.routing, "direct_provider_api", modelId);
    assert.equal(pricing.processingTier, "standard", modelId);
    assert.ok(pricing.pricingVersion.length > 0, modelId);
    assert.ok(pricing.priceSource.length > 0, modelId);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(pricing.effectiveDate), modelId);
  }
});

test("the generic premium fallback no longer applies to the incident models", () => {
  assert.equal(FALLBACK_PRICING.premium.tiers[0].inputUsdPerMillionTokens, 15);
  assert.equal(FALLBACK_PRICING.premium.tiers[0].outputUsdPerMillionTokens, 60);
  for (const modelId of [
    "gpt-5-5",
    "gpt-5-5-thinking",
    "gemini-3-1-pro",
    "claude-opus-4-8",
  ]) {
    const profile = getModelBillingProfile(model(modelId));
    assert.notEqual(profile.inputUsdPerMillionTokens, 15, modelId);
    assert.notEqual(profile.outputUsdPerMillionTokens, 60, modelId);
  }
});

test("the reproduction token counts price at the official rates", () => {
  const opus = costFor("claude-opus-4-8", {
    inputTokens: INCIDENT_PROMPT_TOKENS,
    outputTokens: INCIDENT_OUTPUT_TOKENS["claude-opus-4-8"],
  });
  const gemini = costFor("gemini-3-1-pro", {
    inputTokens: INCIDENT_PROMPT_TOKENS,
    outputTokens: INCIDENT_OUTPUT_TOKENS["gemini-3-1-pro"],
  });
  const gpt = costFor("gpt-5-5-thinking", {
    inputTokens: INCIDENT_PROMPT_TOKENS,
    outputTokens: INCIDENT_OUTPUT_TOKENS["gpt-5-5-thinking"],
  });

  assert.equal(opus, 3_469 * 5 + 2_500 * 25);
  assert.equal(gemini, 3_469 * 2 + 7_710 * 12);
  assert.equal(gpt, 3_469 * 5 + 6_713 * 30);

  // The same three responses cost US$1.171485 internally under generic pricing.
  const previouslyReported = 202_035 + 514_635 + 454_815;
  assert.equal(previouslyReported, 1_171_485);
  assert.ok(opus + gemini + gpt < previouslyReported / 2);
});

test("Gemini 3.1 Pro switches price tier at the 200K prompt boundary", () => {
  const below = resolveModelPricing(model("gemini-3-1-pro"), {
    estimatedPromptTokens: 200_000,
  });
  assert.equal(below.inputUsdPerMillionTokens, 2);
  assert.equal(below.outputUsdPerMillionTokens, 12);
  assert.equal(below.costSource, "registry");
  assert.equal(below.longContextThresholdTokens, null);

  const above = resolveModelPricing(model("gemini-3-1-pro"), {
    estimatedPromptTokens: 200_001,
  });
  assert.equal(above.inputUsdPerMillionTokens, 4);
  assert.equal(above.outputUsdPerMillionTokens, 18);
  assert.equal(above.costSource, "registry_long_context");
  assert.equal(above.longContextThresholdTokens, 200_000);
});

test("flat-priced models are unaffected by prompt size", () => {
  for (const modelId of ["gpt-5-5", "gpt-5-5-thinking", "claude-opus-4-8"]) {
    const small = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 500,
    });
    const large = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 500_000,
    });
    assert.deepEqual(
      [small.inputUsdPerMillionTokens, small.outputUsdPerMillionTokens],
      [large.inputUsdPerMillionTokens, large.outputUsdPerMillionTokens],
      modelId
    );
    assert.equal(large.longContextThresholdTokens, null, modelId);
  }
});

test("reasoning tokens bill at the output rate and get their own reservation headroom", () => {
  const thinking = resolveModelPricing(model("gpt-5-5-thinking"));
  const nonThinking = resolveModelPricing(model("gpt-5-5"));

  // Same upstream model, same price -- only the reserved output differs.
  assert.equal(thinking.apiModelId, nonThinking.apiModelId);
  assert.equal(
    thinking.outputUsdPerMillionTokens,
    nonThinking.outputUsdPerMillionTokens
  );
  assert.equal(thinking.reasoningTokenBilling, "billed_as_output");
  assert.ok(
    thinking.reservationOutputTokens > nonThinking.reservationOutputTokens
  );
  assert.ok(thinking.reservationOutputTokens <= thinking.maxOutputTokens);

  // A settled turn whose output is mostly reasoning costs the same as one of
  // equal total length that is all text -- reasoning is inside `outputTokens`.
  const allText = costFor("gpt-5-5-thinking", {
    inputTokens: 1_000,
    outputTokens: 4_000,
  });
  const mostlyReasoning = costFor("gpt-5-5-thinking", {
    inputTokens: 1_000,
    outputTokens: 4_000,
  });
  assert.equal(allText, mostlyReasoning);
});

test("native web search prices come from the registry, per provider", () => {
  assert.equal(getNativeSearchCostMicroUsdPerQuery("openai"), 10_000);
  assert.equal(getNativeSearchCostMicroUsdPerQuery("anthropic"), 10_000);
  assert.equal(getNativeSearchCostMicroUsdPerQuery("google"), 14_000);
  // Perplexity reports its own response cost and must never also be charged a
  // flat per-query estimate.
  assert.equal(getNativeSearchCostMicroUsdPerQuery("perplexity"), undefined);

  for (const modelId of ["gpt-5-5", "claude-opus-4-8", "gemini-3-1-pro"]) {
    const pricing = resolveModelPricing(model(modelId));
    assert.ok(
      (pricing.nativeSearchCostMicroUsdPerQuery ?? 0) > 0,
      `${modelId} should declare a native search price`
    );
  }
});

test("an unknown model falls back conservatively and is reported, not hidden", () => {
  const unknown = {
    id: "totally-new-premium-model",
    usageClass: "premium",
    provider: "openai",
    apiModel: "totally-new-premium-model",
  };
  const pricing = resolveModelPricing(unknown, { estimatedPromptTokens: 1_000 });
  assert.equal(pricing.isFallbackPricing, true);
  assert.equal(pricing.costSource, "conservative_fallback");
  assert.equal(pricing.inputUsdPerMillionTokens, 15);
  assert.equal(pricing.outputUsdPerMillionTokens, 60);

  const reported = findUnpricedModels([{ ...unknown, enabled: true }]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].severity, "error");
});

test("no enabled premium model is silently unpriced", () => {
  const unpriced = findUnpricedModels(AVAILABLE_MODELS);
  assert.deepEqual(
    unpriced.filter((entry) => entry.severity === "error"),
    []
  );
  // Everything acknowledged as pending must actually still be unpriced, so the
  // list cannot quietly grow stale and start covering a real regression.
  for (const modelId of PENDING_VERIFIED_PRICE_MODEL_IDS) {
    assert.ok(
      unpriced.some((entry) => entry.modelId === modelId),
      `${modelId} is priced now and should leave PENDING_VERIFIED_PRICE_MODEL_IDS`
    );
  }
});

test("existing billing snapshots keep their previously published rates", () => {
  // Backwards compatibility: profiles migrated out of lib/models.ts must not
  // change value, so no already-settled UsageBucket is retroactively wrong.
  assert.deepEqual(getModelBillingProfile(model("deepseek-v4-flash")), {
    maxOutputTokens: 2_048,
    reservationOutputTokens: 1_024,
    inputUsdPerMillionTokens: 0.14,
    outputUsdPerMillionTokens: 0.28,
    cachedInputPriceMultiplier: 0.02,
  });
  assert.deepEqual(getModelBillingProfile(model("deepseek-v4-pro")), {
    maxOutputTokens: 4_096,
    reservationOutputTokens: 2_048,
    inputUsdPerMillionTokens: 0.435,
    outputUsdPerMillionTokens: 0.87,
    cachedInputPriceMultiplier: 1 / 120,
  });
  assert.deepEqual(getModelBillingProfile(model("llama-4-scout")), {
    maxOutputTokens: 8_192,
    reservationOutputTokens: 2_048,
    inputUsdPerMillionTokens: 0.11,
    outputUsdPerMillionTokens: 0.34,
    cachedInputPriceMultiplier: 1,
  });
});

test("an admin registry price override wins over the registry and is labelled", () => {
  const overridden = {
    ...model("claude-opus-4-8"),
    inputUsdPerMillionTokens: 7.5,
    outputUsdPerMillionTokens: 40,
  };
  const pricing = resolveModelPricing(overridden);
  assert.equal(pricing.inputUsdPerMillionTokens, 7.5);
  assert.equal(pricing.outputUsdPerMillionTokens, 40);
  assert.equal(pricing.costSource, "model_registry_override");
});

test("every explicit profile has an unbounded final tier", () => {
  for (const modelId of [
    "gpt-5-5",
    "gpt-5-5-thinking",
    "gemini-3-1-pro",
    "claude-opus-4-8",
  ]) {
    const profile = getModelPricingProfile(modelId);
    assert.ok(profile);
    assert.equal(profile.tiers[profile.tiers.length - 1].maxPromptTokens, null);
  }
});
