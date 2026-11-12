import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  classifyImageProviderFailure,
  generateImageWithProvider,
  ImageProviderError,
} from "../lib/imageProviderAdapter.ts";

// Required, not imported: the adapter reaches the registry through tsx's
// CommonJS loader, and an ESM import of the same file is a second instance
// whose active catalogue the adapter never sees.
const {
  IMAGE_MODEL_REGISTRY,
  resetActiveImageModelCatalog,
  setActiveImageModelCatalog,
} = createRequire(import.meta.url)("../lib/imageModelRegistry.ts");

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

test("a held model whose thinking the request cannot bound is never dispatched", async () => {
  // A hold replaces the judge's reason with `operational_hold`, which the
  // dispatch lets through so admitted jobs can finish. A Google model with a
  // cap an operator wrote down must still not reach a provider that bills its
  // thinking per uncapped token -- and refusing happens before any key lookup
  // or network call. The same holds for a measured model whose cap is under
  // its bound or whose request is not the measured one.
  const price = [{ quality: "medium", size: "1024x1024", credits: 10_000, outputCostMicroUsd: 67_200 }];
  const withCap = (modelId, cap, extra = {}) => {
    const seed = IMAGE_MODEL_REGISTRY.find((model) => model.id === modelId);
    return { ...seed, prices: price, priceVerification: { ...seed.priceVerification, thinkingCapMicroUsd: cap }, ...extra };
  };
  const unheld = [
    withCap("gemini-3-pro-image", 2_000),
    withCap("gemini-3.1-flash-image", 12_287),
    withCap("gemini-3.1-flash-image", 12_288, { maxOutputTokens: 32_768 }),
    withCap("gemini-3.1-flash-image", 12_288, { thinkingLevel: "high" }),
  ];
  try {
    for (const model of unheld) {
      for (const disabledReason of ["operational_hold", null]) {
        setActiveImageModelCatalog([{ ...model, disabledReason }]);
        await assert.rejects(
          generateImageWithProvider({
            prompt: "a red apple",
            size: "1024x1024",
            quality: "medium",
            modelId: model.id,
          }),
          (error) =>
            error.name === "ImageProviderError" &&
            error.failurePhase === "provider_failed" &&
            /no thinking cap its request can enforce/.test(error.message),
          `${model.id} ${String(disabledReason)}`
        );
      }
    }
  } finally {
    resetActiveImageModelCatalog();
  }
});

// A runtime fal model on `apiModelId`, enabled as the resolver would after the
// judge. The price is a hypothetical fixture for the dispatch, not an approval.
const runtimeFal = (apiModelId, thinkingCapMicroUsd) => {
  const seed = IMAGE_MODEL_REGISTRY.find((model) => model.id === "fal-ai/nano-banana-2");
  return {
    ...seed,
    id: apiModelId,
    apiModelId,
    disabledReason: null,
    prices: [{ quality: "medium", size: "1024x1024", credits: 200, outputCostMicroUsd: 40_000 }],
    priceVerification: { ...seed.priceVerification, thinkingCapMicroUsd },
  };
};

const withFalFetch = async (run) => {
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#888" } }).png().toBuffer();
  const calls = [];
  const original = globalThis.fetch;
  const key = process.env.FAL_KEY;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://fal.run/")) {
      // Qwen's output shape: no width or height on the file.
      return Response.json({ images: [{ url: "https://v3b.fal.media/files/out.png", content_type: "image/png" }], seed: 1 });
    }
    const asset = new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.byteLength) } });
    Object.defineProperty(asset, "url", { value: String(url) });
    return asset;
  };
  process.env.FAL_KEY = "test-fal-key";
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = key;
    resetActiveImageModelCatalog();
  }
};

test("a fal model is sent its endpoint's body, not Nano Banana 2's", async () => {
  const qwen = runtimeFal("alibaba/qwen-image-3/text-to-image", 0);
  const { result, calls } = await withFalFetch(async () => {
    setActiveImageModelCatalog([qwen]);
    return generateImageWithProvider({ prompt: "a red apple", size: "1024x1024", quality: "medium", modelId: qwen.id });
  });
  const sent = calls.filter((call) => call.url.startsWith("https://fal.run/"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://fal.run/alibaba/qwen-image-3/text-to-image");
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.image_size, { width: 1024, height: 1024 });
  assert.equal(body.enable_prompt_expansion, false);
  assert.equal("thinking_level" in body, false);
  assert.equal("resolution" in body, false);
  // Measured from the bytes, since the response reported no dimensions.
  assert.equal(result.outputWidth, 1024);
  assert.equal(result.outputHeight, 1024);
  assert.equal(result.thinkingTokens, 0);
});

test("a fal model on a token-billed or unlisted endpoint is refused before any request", async () => {
  // Nano Banana 2.1 bills thinking per token with no cap parameter; an
  // unlisted endpoint has no row at all. Both are refused at dispatch even
  // with a cap written down and the model switched on.
  for (const model of [runtimeFal("google/nano-banana-2.1", 2_000), runtimeFal("fal-ai/flux/dev", 2_000)]) {
    const { calls } = await withFalFetch(async () => {
      setActiveImageModelCatalog([model]);
      await assert.rejects(
        generateImageWithProvider({ prompt: "a red apple", size: "1024x1024", quality: "medium", modelId: model.id }),
        (error) =>
          error.name === "ImageProviderError" && /no thinking cap its request can enforce/.test(error.message),
        model.id
      );
    });
    assert.equal(calls.length, 0, model.id);
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

test("a Google response past the measured bound is reported even when it carries no image", async () => {
  // Review finding 2026-11-13: the report used to run only after an image was
  // parsed, so a response that billed past the bound and stopped without one
  // -- the case the strict parser refuses -- went unreported.
  const flash = IMAGE_MODEL_REGISTRY.find((model) => model.id === "gemini-3.1-flash-image");
  const priced = {
    ...flash,
    disabledReason: null,
    prices: [{ quality: "medium", size: "1024x1024", credits: 94, outputCostMicroUsd: 67_200 }],
  };
  const run = async (usage) => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const logged = [];
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ status: "incomplete", steps: [], usage });
    };
    console.error = (line) => logged.push(String(line));
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    try {
      setActiveImageModelCatalog([priced]);
      await assert.rejects(
        generateImageWithProvider({ prompt: "a red apple", size: "1024x1024", quality: "medium", modelId: priced.id }),
        (error) => /no usable image payload/.test(error.message)
      );
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      if (key === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      resetActiveImageModelCatalog();
    }
    return { calls, events: logged.filter((line) => line.includes("image_google_output_over_measured_bound")) };
  };

  // 2 x 2,048 = 4,096 non-image tokens is the bound: one more is reported.
  const over = await run({ total_output_tokens: 600, total_thought_tokens: 3_497 });
  // Billed and imageless: sent once, never retried, with the measured request.
  assert.equal(over.calls.length, 1);
  assert.deepEqual(over.calls[0].body.generation_config, { max_output_tokens: 2_048 });
  assert.equal(over.events.length, 1);
  assert.equal(JSON.parse(over.events[0]).nonImageBillableTokens, 4_097);

  const within = await run({ total_output_tokens: 553, total_thought_tokens: 1_262 });
  assert.equal(within.events.length, 0);
});
