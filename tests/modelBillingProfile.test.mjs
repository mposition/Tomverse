import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS, getModelBillingProfile } from "../lib/models.ts";

const profile = (modelId) => {
  const model = AVAILABLE_MODELS.find((candidate) => candidate.id === modelId);
  assert.ok(model);
  return getModelBillingProfile(model);
};

test("DeepSeek model defaults distinguish cache-hit and cache-miss pricing", () => {
  assert.deepEqual(profile("deepseek-v4-flash"), {
    maxOutputTokens: 2_048,
    reservationOutputTokens: 1_024,
    inputUsdPerMillionTokens: 0.14,
    outputUsdPerMillionTokens: 0.28,
    cachedInputPriceMultiplier: 0.02,
  });
  assert.deepEqual(profile("deepseek-v4-pro"), {
    maxOutputTokens: 4_096,
    reservationOutputTokens: 2_048,
    inputUsdPerMillionTokens: 0.435,
    outputUsdPerMillionTokens: 0.87,
    cachedInputPriceMultiplier: 1 / 120,
  });
});

// Grok 4.5 is the sole xAI model and therefore also the provider probe's
// target, so its price is what the shared daily probe cap is spent against.
// Falling through to the "premium" cost class booked USD 15/60 per million
// against a model that really costs USD 2/6.
test("Grok 4.5 uses xAI's published prices, not the premium cost-class default", () => {
  const grok = profile("grok-4-5");
  assert.equal(grok.inputUsdPerMillionTokens, 2);
  assert.equal(grok.outputUsdPerMillionTokens, 6);
  // xAI publishes USD 0.30 per million cached input tokens; the profile
  // stores it as a multiple of the input price.
  assert.equal(grok.cachedInputPriceMultiplier * grok.inputUsdPerMillionTokens, 0.3);
});

// Retired with the rest of Llama, but its billing profile is deliberately
// kept: ledger rows and cost reports for conversations that ran on it must
// keep settling against the prices they were charged at.
test("retired Llama 4 Scout keeps its published Groq token pricing for historical settlement", () => {
  assert.deepEqual(profile("llama-4-scout"), {
    maxOutputTokens: 8_192,
    reservationOutputTokens: 2_048,
    inputUsdPerMillionTokens: 0.11,
    outputUsdPerMillionTokens: 0.34,
    cachedInputPriceMultiplier: 1,
  });
});
