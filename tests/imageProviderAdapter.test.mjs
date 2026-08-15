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
      modelId: "gemini-3.1-flash-image",
    }),
    (error) =>
      error.name === "ImageProviderError" &&
      error.failurePhase === "provider_failed" &&
      /not available for requests/.test(error.message)
  );
});

test("having an adapter is not what makes a model callable", async () => {
  // Every Google model has a working Interactions adapter and is still held,
  // because the hold is about whether the worst-case cost is finite, not about
  // whether the code to call it exists. The dispatch refuses on disabledReason
  // before it ever reaches a provider branch, so writing an adapter can never
  // be the thing that ships a model.
  for (const modelId of [
    "gemini-3.1-flash-lite-image",
    "gemini-3-pro-image",
  ]) {
    await assert.rejects(
      generateImageWithProvider({
        prompt: "a red apple",
        size: "1024x1024",
        quality: "medium",
        modelId,
      }),
      (error) =>
        error.name === "ImageProviderError" &&
        error.failurePhase === "provider_failed" &&
        /not available for requests/.test(error.message),
      modelId
    );
  }
});

test("an enabled model still refuses a size it has no mapping for", async () => {
  // Grok is enabled at 1K square only. A landscape passes the disabledReason
  // check and must still be refused by the request builder rather than sent as
  // though it were the priced request -- the approved credits are for one
  // resolution, and the user would never see the difference.
  //
  // Reaching this error at all proves the dispatch let an enabled model
  // through, which is the other half of the test above.
  await assert.rejects(
    generateImageWithProvider({
      prompt: "a red apple",
      size: "1536x1024",
      quality: "medium",
      modelId: "grok-imagine-image-quality-20260403",
    }),
    (error) =>
      error.name === "ImageProviderError" &&
      /no xAI resolution mapping/.test(error.message)
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
