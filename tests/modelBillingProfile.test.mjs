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
