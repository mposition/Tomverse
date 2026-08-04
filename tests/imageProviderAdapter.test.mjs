import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyImageProviderFailure,
  generateImageWithProvider,
  ImageProviderError,
} from "../lib/imageProviderAdapter.ts";

test("429 is rate limited, 5xx is provider failure", () => {
  assert.equal(classifyImageProviderFailure(429, null), "provider_rate_limited");
  assert.equal(classifyImageProviderFailure(500, null), "provider_failed");
  assert.equal(classifyImageProviderFailure(503, {}), "provider_failed");
});

test("moderation and content-policy rejections classify as moderation, never user error", () => {
  for (const body of [
    { error: { code: "moderation_blocked", message: "x" } },
    { error: { type: "image_generation_user_error", message: "Rejected by content_policy" } },
    { error: { message: "Your request was rejected by the safety system." } },
    { error: { message: "This prompt violates our content policy." } },
  ]) {
    assert.equal(
      classifyImageProviderFailure(400, body),
      "provider_moderation_rejected",
      JSON.stringify(body)
    );
  }
});

test("plain 4xx is a user error; auth failures are Tomverse's fault", () => {
  assert.equal(
    classifyImageProviderFailure(400, { error: { message: "Invalid size." } }),
    "provider_user_error"
  );
  assert.equal(classifyImageProviderFailure(422, null), "provider_user_error");
  assert.equal(classifyImageProviderFailure(401, null), "provider_failed");
  assert.equal(classifyImageProviderFailure(403, null), "provider_failed");
});

test("ImageProviderError carries phase, status and provider request id", () => {
  const error = new ImageProviderError(
    "provider_rate_limited",
    "slow down",
    429,
    "req_123"
  );
  assert.equal(error.failurePhase, "provider_rate_limited");
  assert.equal(error.status, 429);
  assert.equal(error.providerRequestId, "req_123");
  assert.equal(error.name, "ImageProviderError");
});

test("a model on a fail-closed hold is refused by the adapter itself", async () => {
  // The adapter is the last place a request could still reach a provider we
  // cannot price, so it re-checks the registry rather than trusting admission.
  await assert.rejects(
    generateImageWithProvider({
      prompt: "a red apple",
      size: "1024x1024",
      quality: "medium",
      modelId: "gemini-3.1-flash-image-preview",
    }),
    (error) =>
      error.name === "ImageProviderError" &&
      error.failurePhase === "provider_failed" &&
      /not available for requests/.test(error.message)
  );
});

test("an unknown model never reaches a provider", async () => {
  await assert.rejects(
    generateImageWithProvider({
      prompt: "a red apple",
      size: "1024x1024",
      quality: "low",
      modelId: "not-a-registered-model",
    }),
    (error) => error.name === "ImageProviderError"
  );
});
