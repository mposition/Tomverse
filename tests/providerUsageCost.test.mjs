import assert from "node:assert/strict";
import test from "node:test";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";

test("Mistral cached prompt tokens use ten percent of the input rate", () => {
  const usage = calculateProviderUsageCost({
    inputTokens: 1_013,
    cachedInputTokens: 1_008,
    outputTokens: 30,
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 6,
    cachedInputPriceMultiplier: 0.1,
  });

  assert.deepEqual(
    {
      uncachedInputTokens: usage.uncachedInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      uncachedInputCostMicroUsd: usage.uncachedInputCostMicroUsd,
      cachedInputCostMicroUsd: usage.cachedInputCostMicroUsd,
      outputCostMicroUsd: usage.outputCostMicroUsd,
      totalCostMicroUsd: usage.totalCostMicroUsd,
    },
    {
      uncachedInputTokens: 5,
      cachedInputTokens: 1_008,
      uncachedInputCostMicroUsd: 10,
      cachedInputCostMicroUsd: 202,
      outputCostMicroUsd: 180,
      totalCostMicroUsd: 392,
    }
  );
});

test("cached tokens are bounded by total prompt tokens", () => {
  const usage = calculateProviderUsageCost({
    inputTokens: 10,
    cachedInputTokens: 20,
    outputTokens: 0,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 1,
    cachedInputPriceMultiplier: 0.1,
  });
  assert.equal(usage.cachedInputTokens, 10);
  assert.equal(usage.uncachedInputTokens, 0);
  assert.equal(usage.totalCostMicroUsd, 1);
});

test("Zhipu cached prompt tokens can use a request-time twenty percent multiplier", () => {
  const result = calculateProviderUsageCost({
    inputTokens: 1_000,
    cachedInputTokens: 600,
    outputTokens: 100,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 3,
    cachedInputPriceMultiplier: 0.2,
  });

  assert.equal(result.uncachedInputCostMicroUsd, 400);
  assert.equal(result.cachedInputCostMicroUsd, 120);
  assert.equal(result.outputCostMicroUsd, 300);
  assert.equal(result.totalCostMicroUsd, 820);
});
