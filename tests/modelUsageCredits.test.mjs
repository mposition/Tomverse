import assert from "node:assert/strict";
import test from "node:test";
import {
  getInputCreditMultiplier,
  getModel,
  getModelUsageProfile,
  getSettledUsageCredits,
  getWeightedUsageCredits,
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

test("long input applies the configured credit multiplier", () => {
  const premium = getModel("gpt-5-5");
  assert.equal(getInputCreditMultiplier(16_000), 1);
  assert.equal(getInputCreditMultiplier(16_001), 1.5);
  assert.equal(getInputCreditMultiplier(50_001), 2);
  assert.equal(getInputCreditMultiplier(100_001), 3);
  assert.equal(getWeightedUsageCredits(premium, 60_000), 16);
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
