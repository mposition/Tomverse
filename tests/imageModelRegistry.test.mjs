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
  // Policy section 12: the per-image price was read from Google's own
  // documentation on 2026-08-04, but thinking cannot be disabled and no token
  // cap is established -- so the worst case is not provably finite and the
  // reason says exactly that rather than claiming the price is unknown.
  assert.equal(google?.disabledReason, "worst_case_cost_unbounded");
  assert.equal(google?.priceVerification.verifiedAt, "2026-08-04");
  assert.equal(google?.priceVerification.thinkingCapMicroUsd, null);
  assert.deepEqual(google?.prices, []);
});

test("Grok Imagine ships enabled at the approved price, 1K square only", () => {
  // Enabled 2026-08-05, after the operational hold was cleared in order: the
  // adapter, then the provider budget deployed ahead of this code. The price
  // question was already settled -- flat per-image, no token charges -- which
  // is why the approved credits were recorded while it was still held rather
  // than typed in by hand on launch day.
  const grok = getImageModel("grok-imagine-image-quality-20260403");
  assert.equal(grok?.disabledReason, null);
  assert.equal(grok?.priceVerification.verifiedAt, "2026-08-04");
  assert.equal(grok?.priceVerification.thinkingCapMicroUsd, 0);
  assert.deepEqual(grok?.prices, [
    {
      quality: "medium",
      size: "1024x1024",
      credits: 75,
      outputCostMicroUsd: 50_000,
    },
  ]);
  assert.ok(
    grok.prices[0].credits >= minimumCreditsForImageOption(grok, grok.prices[0])
  );
  assert.deepEqual(
    getImageModelPrice("grok-imagine-image-quality-20260403", "medium", "1024x1024"),
    grok.prices[0]
  );

  // 2K is approved at 100 credits and deliberately absent: it needs the size
  // system to grow a resolution tier first. Every other option prices to null,
  // so the composer disables submission rather than quoting a guess.
  assert.deepEqual(grok.sizes, ["1024x1024"]);
  assert.deepEqual(grok.qualities, ["medium"]);
  for (const [quality, size] of [
    ["low", "1024x1024"],
    ["high", "1024x1024"],
    ["medium", "1536x1024"],
    ["medium", "1024x1536"],
  ]) {
    assert.equal(
      getImageModelPrice("grok-imagine-image-quality-20260403", quality, size),
      null,
      `${quality} ${size}`
    );
  }

  // Verified absent, not unread: no watermark, C2PA or metadata guarantee
  // anywhere in xAI's documentation. Claiming provenance a file may not carry
  // would be worse than claiming none.
  assert.deepEqual(grok.provenance, []);
});

test("a disabled model is invisible to every selection path", () => {
  const enabled = listEnabledImageModels().map((model) => model.id);
  assert.deepEqual(enabled, [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
  // Two providers now, which is what makes the comparison cross-provider. The
  // three Google models are registered and still contribute no provider here.
  assert.deepEqual(listActiveImageProviders(), ["openai", "xai"]);
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

test("each model carries its own pricing version, and gpt-image-2 keeps the one already on disk", () => {
  // A reservation freezes the version of the price list it was priced by. With
  // one global string, adding xAI's price would have moved every gpt-image-2
  // reservation onto a new version without a cent of its price changing --
  // every cost report would show a boundary that corresponds to nothing.
  const versions = IMAGE_MODEL_REGISTRY.map((model) => model.pricingVersion);
  assert.equal(new Set(versions).size, versions.length);
  for (const version of versions) assert.ok(version.length > 0);

  // Not derived from IMAGE_PRICING_VERSION on purpose: coupling them would let
  // a ceiling change bump this model's version, which is the same noise in the
  // other direction. It is the literal string reservations already carry, and
  // it moves only when gpt-image-2's own prices move.
  assert.equal(getImageModel("gpt-image-2").pricingVersion, "2026-08-03-v1");
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

test("a documented output limit is never mistaken for a proven cost cap", () => {
  // The two facts look alike and are not. `maxOutputTokens` is what the model
  // card publishes and what every request sends; `thinkingCapMicroUsd` is
  // whether the worst case is provably finite. Google publishes the first and
  // does not state the second -- the Interactions reference defines
  // max_output_tokens and reports total_output_tokens and
  // total_thought_tokens as separate counters, and nothing links them. So a
  // model may carry an output limit and still be unbounded, and writing the
  // limit in must not quietly enable anything.
  const google = IMAGE_MODEL_REGISTRY.filter(
    (model) => model.provider === "google"
  );
  assert.equal(google.length, 3);
  for (const model of google) {
    assert.ok(model.maxOutputTokens && model.maxOutputTokens > 0, model.id);
    assert.equal(model.priceVerification.thinkingCapMicroUsd, null, model.id);
    assert.equal(model.disabledReason, "worst_case_cost_unbounded", model.id);
    assert.deepEqual(model.prices, [], model.id);
  }
  // Flash Lite's low ceiling is what makes it the first model worth measuring:
  // a limit that never binds proves nothing about whether it is enforced.
  assert.equal(getImageModel("gemini-3.1-flash-lite-image").maxOutputTokens, 4_096);
});

test("no model claims a thinking level nobody verified it accepts", () => {
  // Support is per model. An unset field omits the parameter entirely, which
  // is the fail-closed direction: a request that carries a parameter the model
  // rejects fails in a way that reads like a provider outage.
  for (const model of IMAGE_MODEL_REGISTRY) {
    if (model.thinkingLevel === undefined) continue;
    assert.ok(["low", "medium", "high"].includes(model.thinkingLevel), model.id);
  }
});
