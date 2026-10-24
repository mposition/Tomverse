import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewProviderDefaults, resolveReviewProviderDefaults, reviewProviderOptions } from "../lib/reviewProviderPreferencesCore.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

test("Review defaults reject empty, duplicated, oversized and malformed provider lists", () => {
  for (const value of [null, [], ["openai", "openai"], ["openai", "google", "anthropic", "xai"], ["OpenAI"], [7], "openai"]) assert.equal(parseReviewProviderDefaults(value), null);
  assert.deepEqual(parseReviewProviderDefaults(["google", "openai"]), ["google", "openai"]);
});

test("personal Review defaults override platform defaults without adding providers", () => {
  assert.deepEqual(resolveReviewProviderDefaults({ personal: ["google"], platform: ["openai"], available: ["google", "openai"], maxProviders: 3 }), ["google"]);
});

test("inheritance uses the platform selection and an absent setting retains OpenAI", () => {
  assert.deepEqual(resolveReviewProviderDefaults({ personal: null, platform: ["anthropic"], available: ["openai", "anthropic"], maxProviders: 3 }), ["anthropic"]);
  assert.deepEqual(resolveReviewProviderDefaults({ personal: null, platform: null, available: ["openai"], maxProviders: 3 }), ["openai"]);
});

test("effective defaults respect provider eligibility and the plan count cap", () => {
  assert.deepEqual(resolveReviewProviderDefaults({ personal: ["google", "anthropic", "openai"], platform: ["openai"], available: ["google", "openai"], maxProviders: 1 }), ["google"]);
});

test("unavailable defaults do not silently substitute another provider", () => {
  assert.deepEqual(resolveReviewProviderDefaults({ personal: ["google"], platform: ["openai"], available: ["openai"], maxProviders: 3 }), []);
});

test("provider options exclude disabled and delisted catalog entries", () => {
  const model = AVAILABLE_MODELS.find(model => model.provider === "openai" && model.id === "gpt-6-luna");
  assert.ok(model);
  assert.deepEqual(reviewProviderOptions([{ ...model, enabled: false }], "Max"), []);
  assert.deepEqual(reviewProviderOptions([{ ...model, publiclyListed: false }], "Max"), []);
  assert.deepEqual(reviewProviderOptions([{ ...model, catalogDeleted: true }], "Max"), []);
  assert.deepEqual(reviewProviderOptions([model], "Max"), ["openai"]);
});
