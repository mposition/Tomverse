import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_MODEL_REGISTRY,
  getImageModel,
  getImageModelPrice,
  listActiveImageProviders,
  listEnabledImageModels,
  maxImageRequestCostMicroUsd,
  minimumCreditsForImageOption,
} from "../lib/imageModelRegistry.ts";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_PROMPT_BUDGET_MICRO_USD,
} from "../lib/imageGenerationPricing.ts";

test("the registry ships GPT Image 2 enabled and Nano Banana 2 on a verification hold", () => {
  const openai = getImageModel("gpt-image-2");
  assert.equal(openai?.provider, "openai");
  assert.equal(openai?.disabledReason, null);
  assert.equal(openai?.lifecycle, "stable");
  assert.equal(DEFAULT_IMAGE_MODEL_ID, "gpt-image-2");

  const google = getImageModel("gemini-3.1-flash-image");
  assert.equal(google?.provider, "google");
  assert.equal(google?.lifecycle, "stable");
  // Policy section 12: registered, but no request may reach it until an
  // official price has been read and the worst case proven finite.
  assert.equal(google?.disabledReason, "price_unverified");
  assert.equal(google?.priceVerification.verifiedAt, null);
  assert.equal(google?.priceVerification.thinkingCapMicroUsd, null);
  assert.deepEqual(google?.prices, []);
});

test("a disabled model is invisible to every selection path", () => {
  const enabled = listEnabledImageModels().map((model) => model.id);
  assert.deepEqual(enabled, ["gpt-image-2"]);
  assert.deepEqual(listActiveImageProviders(), ["openai"]);
  // Fail-closed price lookup: the model exists, but pricing it is refused.
  assert.equal(
    getImageModelPrice("gemini-3.1-flash-image", "medium", "1024x1024"),
    null
  );
  assert.equal(getImageModelPrice("unknown-model", "low", "1024x1024"), null);
});

test("worst-case cost is null when the thinking cap is unknown", () => {
  const google = getImageModel("gemini-3.1-flash-image");
  const hypotheticalPrice = {
    quality: "medium",
    size: "1024x1024",
    credits: 80,
    outputCostMicroUsd: 67_000,
  };
  // Even handed a price, an unknown cap cannot produce a finite worst case,
  // so no fixed credit figure can be derived from it.
  assert.equal(maxImageRequestCostMicroUsd(google, hypotheticalPrice), null);
  assert.equal(minimumCreditsForImageOption(google, hypotheticalPrice), null);
});

test("every enabled option prices at or above the policy minimum", () => {
  for (const model of listEnabledImageModels()) {
    for (const price of model.prices) {
      const maxCost = maxImageRequestCostMicroUsd(model, price);
      const minimum = minimumCreditsForImageOption(model, price);
      assert.ok(maxCost !== null && minimum !== null);
      assert.equal(
        maxCost,
        price.outputCostMicroUsd +
          IMAGE_PROMPT_BUDGET_MICRO_USD +
          model.priceVerification.thinkingCapMicroUsd
      );
      assert.ok(
        price.credits >= minimum,
        `${model.id} ${price.quality} ${price.size}: ${price.credits} < ${minimum}`
      );
      assert.ok(
        maxCost / price.credits <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD
      );
    }
  }
});

test("the registry price table agrees with the v1 flat table it replaces", () => {
  // The registry is the successor, not a second opinion: a drift here would
  // let the workspace quote one price while the reservation charges another.
  const openai = getImageModel("gpt-image-2");
  assert.equal(openai.prices.length, 9);
  assert.equal(getImageModelPrice("gpt-image-2", "low", "1024x1024").credits, 15);
  assert.equal(
    getImageModelPrice("gpt-image-2", "medium", "1536x1024").credits,
    60
  );
  assert.equal(
    getImageModelPrice("gpt-image-2", "high", "1024x1024").outputCostMicroUsd,
    211_000
  );
});

test("model ids are unique and every id equals its API model id today", () => {
  const ids = IMAGE_MODEL_REGISTRY.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const model of IMAGE_MODEL_REGISTRY) {
    assert.equal(model.id, model.apiModelId);
    assert.ok(model.outputMimeTypes.length > 0);
    assert.ok(model.priceVerification.sources.length > 0);
  }
});
