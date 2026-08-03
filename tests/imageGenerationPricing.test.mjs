import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_GENERATION_MODEL_ID,
  IMAGE_GENERATION_PRICING,
  IMAGE_PRICING_VERSION,
  IMAGE_PROMPT_BUDGET_MICRO_USD,
  IMAGE_PROMPT_MAX_TOKENS,
  IMAGE_QUALITY_BY_PRESET,
  getImageGenerationPricing,
  listEnabledImagePricingEntries,
  maxRequestCostMicroUsd,
  PRICE_VERIFICATION,
} from "../lib/imageGenerationPricing.ts";
import {
  IMAGE_GENERATION_FLAG_KEY,
  imageGenerationEnabledFromValue,
  planAllowsImageGeneration,
} from "../lib/imageGenerationAccess.ts";

const QUALITIES = ["low", "medium", "high"];
const SIZES = ["1024x1024", "1536x1024", "1024x1536"];

test("every advertised quality x size combination has exactly one enabled price", () => {
  for (const quality of QUALITIES) {
    for (const size of SIZES) {
      const entry = getImageGenerationPricing(quality, size);
      assert.ok(entry, `${quality} ${size} must have an enabled pricing entry`);
      assert.equal(entry.quality, quality);
      assert.equal(entry.size, size);
    }
  }
  assert.equal(listEnabledImagePricingEntries().length, 9);
});

test("credits match the approved policy table", () => {
  const expected = {
    "low 1024x1024": 15,
    "low 1536x1024": 15,
    "low 1024x1536": 15,
    "medium 1024x1024": 70,
    "medium 1536x1024": 60,
    "medium 1024x1536": 60,
    "high 1024x1024": 250,
    "high 1536x1024": 200,
    "high 1024x1536": 200,
  };
  for (const [key, credits] of Object.entries(expected)) {
    const [quality, size] = key.split(" ");
    assert.equal(getImageGenerationPricing(quality, size)?.credits, credits, key);
  }
});

test("worst-case per-credit cost, prompt budget included, stays at or under the ceiling", () => {
  assert.equal(IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD, 900);
  assert.equal(IMAGE_PROMPT_BUDGET_MICRO_USD, 5_000);
  for (const entry of listEnabledImagePricingEntries()) {
    const perCredit = maxRequestCostMicroUsd(entry) / entry.credits;
    assert.ok(
      perCredit <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
      `${entry.quality} ${entry.size}: ${perCredit} exceeds ceiling`
    );
  }
});

test("current worst case is Final square at 864 microUSD per credit", () => {
  const entry = getImageGenerationPricing("high", "1024x1024");
  assert.equal(maxRequestCostMicroUsd(entry) / entry.credits, 864);
});

test("unknown or disabled combinations fail closed to null", () => {
  assert.equal(getImageGenerationPricing("ultra", "1024x1024"), null);
  assert.equal(getImageGenerationPricing("high", "2048x2048"), null);
  assert.equal(getImageGenerationPricing("auto", "auto"), null);
});

test("pricing metadata is pinned", () => {
  assert.equal(IMAGE_GENERATION_MODEL_ID, "gpt-image-2");
  assert.ok(IMAGE_PRICING_VERSION.length > 0);
  assert.equal(IMAGE_PROMPT_MAX_TOKENS, 1_000);
  assert.ok(!Number.isNaN(Date.parse(PRICE_VERIFICATION.verifiedAt)));
  assert.ok(PRICE_VERIFICATION.sources.length >= 1);
  assert.deepEqual(IMAGE_QUALITY_BY_PRESET, {
    draft: "low",
    standard: "medium",
    final: "high",
  });
  for (const entry of IMAGE_GENERATION_PRICING) {
    assert.ok(Number.isSafeInteger(entry.credits) && entry.credits > 0);
    assert.ok(Number.isSafeInteger(entry.outputCostMicroUsd) && entry.outputCostMicroUsd > 0);
  }
});

test("plan entitlement is Pro/Max only", () => {
  assert.equal(planAllowsImageGeneration("Pro"), true);
  assert.equal(planAllowsImageGeneration("Max"), true);
  assert.equal(planAllowsImageGeneration("Free"), false);
  assert.equal(planAllowsImageGeneration("Guest"), false);
});

test("feature flag is explicit opt-in: only the literal \"true\" enables", () => {
  assert.equal(IMAGE_GENERATION_FLAG_KEY, "feature.imageGenerationEnabled");
  assert.equal(imageGenerationEnabledFromValue("true"), true);
  for (const value of [undefined, null, "", "false", "TRUE", "True", "1", "yes", "on"]) {
    assert.equal(
      imageGenerationEnabledFromValue(value),
      false,
      `${String(value)} must stay disabled`
    );
  }
});
