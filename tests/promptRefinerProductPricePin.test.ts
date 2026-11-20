import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS,
  PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_PRODUCT_PRICE_PIN,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_PRODUCT_WORST_CASE_MICRO_USD,
} from "../lib/promptRefinerProductPricePin.ts";
import { guardPromptRefinerProductBilledUsage } from "../lib/promptRefinerProductUsageGuard.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { getModel } from "../lib/models.ts";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
} from "../lib/promptRefinerVnextOneShotPriceBinding.ts";

const pin = PROMPT_REFINER_PRODUCT_PRICE_PIN;

test("the product pin is gpt-6-luna at its published catalogue rates", () => {
  const model = getModel(pin.modelId);
  assert.ok(model, "gpt-6-luna is in the static catalogue");
  assert.equal(model.apiModel, pin.apiModelId);
  const price = resolveModelPricing(model, { estimatedPromptTokens: PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS });
  assert.equal(price.provider, pin.provider);
  assert.equal(price.routing, pin.routing);
  assert.equal(price.processingTier, pin.processingTier);
  assert.equal(price.inputUsdPerMillionTokens, pin.inputUsdPerMillionTokens);
  assert.equal(price.cachedInputPriceMultiplier, pin.cachedInputPriceMultiplier);
  assert.equal(price.cacheWriteUsdPerMillionTokens, pin.cacheWriteUsdPerMillionTokens);
  assert.equal(price.outputUsdPerMillionTokens, pin.outputUsdPerMillionTokens);
  assert.equal(price.reasoningTokenBilling, "billed_as_output");
  assert.ok(price.maxOutputTokens >= PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS);
});

test("the kept 29,918 ceiling is above gpt-6-luna's worst case", () => {
  // The worst case the vNext guard admits: one uncached, one cached, the rest
  // cache write, full output -- each bucket rounded up.
  const worst = calculateProviderUsageCost({
    inputTokens: PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS,
    cachedInputTokens: 1,
    cacheWriteInputTokens: PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS - 2,
    outputTokens: PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
    inputUsdPerMillionTokens: pin.inputUsdPerMillionTokens,
    cachedInputPriceMultiplier: pin.cachedInputPriceMultiplier,
    cacheWriteUsdPerMillionTokens: pin.cacheWriteUsdPerMillionTokens,
    outputUsdPerMillionTokens: pin.outputUsdPerMillionTokens,
  });
  assert.equal(worst.totalCostMicroUsd, PROMPT_REFINER_PRODUCT_WORST_CASE_MICRO_USD);
  assert.equal(PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD, 29_918);
  assert.ok(PROMPT_REFINER_PRODUCT_WORST_CASE_MICRO_USD < PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD);
});

test("the product price pin digest is its own, not the evaluation's", () => {
  assert.match(PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST, /^[0-9a-f]{64}$/);
  assert.notEqual(PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST, PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST);
});

test("billed usage is priced at the product pin and refused on any other pin", () => {
  const usage = {
    inputTokens: 1_000,
    outputTokens: 200,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 50,
  };
  const ok = guardPromptRefinerProductBilledUsage({ usage, effectivePricePin: { ...pin } });
  assert.equal(ok.complete, true);
  // 1,000 x 0.1 + 200 x 0.5 = 100 + 100 micro-USD.
  assert.equal(ok.costUpperBoundMicroUsd, 200);
  const old = guardPromptRefinerProductBilledUsage({
    usage,
    effectivePricePin: { ...pin, inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2 },
  });
  assert.equal(old.complete, false);
  assert.ok(old.problems.includes("price_pin_mismatch"));
});
