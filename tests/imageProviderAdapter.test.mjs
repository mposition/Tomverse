import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  classifyImageProviderFailure,
  generateImageForMeasurement,
  generateImageWithProvider,
  ImageProviderError,
  imageProviderRejectionDetail,
} from "../lib/imageProviderAdapter.ts";

// Required, not imported: the adapter reaches the registry through tsx's
// CommonJS loader, and an ESM import of the same file is a second instance
// whose active catalogue the adapter never sees.
const {
  IMAGE_MODEL_REGISTRY,
  resetActiveImageModelCatalog,
  setActiveImageModelCatalog,
  imageEditCredits,
  maxImageEditRequestCostMicroUsd,
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

test("a rejection detail names the provider's code and offending parameter, never free text", () => {
  assert.equal(
    imageProviderRejectionDetail(400, {
      error: { code: "invalid_value", type: "invalid_request_error", param: "size", message: "a red apple is bad" },
    }),
    "Image provider rejected the request (HTTP 400; code=invalid_value; type=invalid_request_error; param=size)."
  );
  // Google: numeric code plus a status string.
  assert.equal(
    imageProviderRejectionDetail(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "x" } }),
    "Image provider rejected the request (HTTP 400; code=400; status=INVALID_ARGUMENT)."
  );
  // fal's validation list.
  assert.equal(
    imageProviderRejectionDetail(422, { detail: [{ loc: ["body", "prompt"], type: "string_too_long", msg: "x" }] }),
    "Image provider rejected the request (HTTP 422; type=string_too_long; param=body.prompt)."
  );
  // A code that is not an identifier (could quote the prompt) is dropped.
  assert.equal(
    imageProviderRejectionDetail(400, { error: { code: "the prompt a red apple" } }),
    "Image provider rejected the request (HTTP 400)."
  );
  assert.equal(imageProviderRejectionDetail(400, null), "Image provider rejected the request (HTTP 400).");
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

  // The refusal carries what the imageless response billed, for settlement.
  {
    const originalFetch = globalThis.fetch;
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    globalThis.fetch = async () =>
      Response.json({ status: "incomplete", steps: [], usage: { total_output_tokens: 553, total_thought_tokens: 1_262 } });
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    try {
      setActiveImageModelCatalog([priced]);
      await assert.rejects(
        generateImageWithProvider({ prompt: "a red apple", size: "1024x1024", quality: "medium", modelId: priced.id }),
        (error) => error.nonImageBillableTokens === 1_815 && error.billedImageTokens === null && error.billedImageCount === 0
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (key === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      resetActiveImageModelCatalog();
    }
  }

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

test("a Google failure that may have been billed is never sent twice", async () => {
  // Review finding 2026-11-13: the reservation holds one request's worst case.
  // A lost response or a 5xx can follow a generation that was billed, so
  // neither is retried; fal's path makes the same choice.
  const flash = IMAGE_MODEL_REGISTRY.find((model) => model.id === "gemini-3.1-flash-image");
  const priced = {
    ...flash,
    disabledReason: null,
    prices: [{ quality: "medium", size: "1024x1024", credits: 94, outputCostMicroUsd: 67_200 }],
  };
  const attempt = async (respond) => {
    const originalFetch = globalThis.fetch;
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return respond();
    };
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    try {
      setActiveImageModelCatalog([priced]);
      await assert.rejects(
        generateImageWithProvider({ prompt: "a red apple", size: "1024x1024", quality: "medium", modelId: priced.id }),
        (error) => error.name === "ImageProviderError" && error.failurePhase === "provider_failed"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (key === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      resetActiveImageModelCatalog();
    }
    return calls;
  };
  assert.equal(
    await attempt(() => {
      throw new TypeError("fetch failed");
    }),
    1
  );
  assert.equal(await attempt(() => Response.json({ error: { message: "internal" } }, { status: 503 })), 1);
});

test("a refused Google response with two images carries both for settlement", async () => {
  const flash = IMAGE_MODEL_REGISTRY.find((model) => model.id === "gemini-3.1-flash-image");
  const priced = {
    ...flash,
    disabledReason: null,
    prices: [{ quality: "medium", size: "1024x1024", credits: 94, outputCostMicroUsd: 67_200 }],
  };
  const image = { type: "image", data: "AAAA", mime_type: "image/jpeg" };
  const originalFetch = globalThis.fetch;
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  globalThis.fetch = async () =>
    Response.json({
      status: "completed",
      steps: [{ type: "model_output", content: [image, image] }],
      usage: {
        total_output_tokens: 2_440,
        output_tokens_by_modality: [{ modality: "image", tokens: 2_240 }],
        total_thought_tokens: 0,
      },
    });
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
  try {
    setActiveImageModelCatalog([priced]);
    await assert.rejects(
      generateImageWithProvider({ prompt: "a red apple", size: "1024x1024", quality: "medium", modelId: priced.id }),
      (error) => error.billedImageTokens === 2_240 && error.billedImageCount === 2 && error.nonImageBillableTokens === 200
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    resetActiveImageModelCatalog();
  }
});

// The admin billing measurement (lib/imageBillingMeasurement.ts) calls an
// unpriced candidate profile; review findings 2026-11-13.
const candidate = (provider, apiModelId, extra = {}) => ({
  id: `measurement:${apiModelId}`,
  provider,
  apiModelId,
  name: apiModelId,
  lifecycle: "preview",
  disabledReason: null,
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [],
  latencyClass: "balanced",
  provenance: [],
  outputMimeTypes: ["image/png"],
  pricingVersion: "measurement",
  priceVerification: { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
  ...extra,
});

const withEnv = async (name, value, run) => {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
};

test("Google edits use the exact priced option and keep photo bytes out of the audit", async t => {
  const apiModelId = "gemini-3.1-flash-image";
  const price = { quality: "medium", size: "1024x1024", credits: 120, outputCostMicroUsd: 67_200 };
  const model = {
    ...IMAGE_MODEL_REGISTRY.find(entry => entry.id === apiModelId),
    disabledReason: null,
    prices: [price],
  };
  const photo = Buffer.from("private photo");
  const editImage = { bytes: photo, width: 1024, height: 768, mimeType: "image/png", sha256: "b".repeat(64) };
  const request = { prompt: "private brief", modelId: model.id, quality: price.quality, size: price.size, editImage };
  const network = t.mock.method(globalThis, "fetch");
  setActiveImageModelCatalog([model]);
  try {
    await withEnv("IMAGE_GOOGLE_EDIT_ENABLED", "false", () =>
      assert.rejects(generateImageWithProvider(request), /cannot edit/));
    assert.equal(network.mock.callCount(), 0);
    await withEnv("IMAGE_GOOGLE_EDIT_ENABLED", "true", () => withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key", async () => {
      const ceiling = maxImageEditRequestCostMicroUsd(model, price);
      assert.ok(ceiling > price.outputCostMicroUsd);
      assert.equal(imageEditCredits(model, price), 120);
      assert.equal(imageEditCredits(model, { ...price, outputCostMicroUsd: 67_199 }), null);
      assert.equal(imageEditCredits(model, { ...price, quality: "high" }), null);
      assert.equal(imageEditCredits(model, { ...price, size: "1536x1024" }), null);
      assert.equal(imageEditCredits(model, { ...price, credits: 1 }), null);
      const steps = [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "aW1hZ2U=" }] }];
      const usage = { total_input_tokens: 1491, total_output_tokens: 1120 };
      network.mock.mockImplementationOnce(async (url, init) => {
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
        const body = JSON.parse(init.body);
        assert.equal(body.store, false);
        assert.equal(body.response_format.mime_type, "image/jpeg");
        assert.deepEqual(body.input, [
          { type: "text", text: request.prompt },
          { type: "image", mime_type: "image/png", data: photo.toString("base64") },
        ]);
        return Response.json({ steps, usage: { ...usage, input_tokens_by_modality: [
          { modality: "image", tokens: 1100 },
          { modality: "text", tokens: 371 },
          { modality: "image", tokens: 20 },
        ] } });
      });
      const result = await generateImageWithProvider(request);
      assert.equal(result.inputTokens, 371);
      assert.equal(result.imageInputTokens, 1120);
      assert.equal(result.requestParams.image.sha256, editImage.sha256);
      assert.ok(!JSON.stringify(result.requestParams).includes(photo.toString("base64")));
      assert.ok(!JSON.stringify(result.requestParams).includes(request.prompt));

      network.mock.mockImplementationOnce(async () => Response.json({ steps, usage }));
      const missingSplit = await generateImageWithProvider(request);
      assert.equal(missingSplit.inputTokens, 1000);
      assert.equal(missingSplit.imageInputTokens, null);
    }));
  } finally {
    resetActiveImageModelCatalog();
  }
});

test("OpenAI 2.6 edits are opt-in with the measured quality, budget, and private multipart reference", async t => {
  const ids = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"];
  const price = { quality: "medium", size: "1024x1024", credits: 65, outputCostMicroUsd: 43_470 };
  const models = ids.map(id => candidate("openai", id, {
    id,
    prices: [price],
    priceVerification: { verifiedAt: "2026-11-25", sources: [], thinkingCapMicroUsd: 0 },
  }));
  const editImage = { bytes: Buffer.from("private photo"), width: 1024, height: 1024, mimeType: "image/png", sha256: "c".repeat(64) };
  const request = { prompt: "private brief", quality: price.quality, size: price.size, editImage };
  const network = t.mock.method(globalThis, "fetch");
  setActiveImageModelCatalog(models);
  try {
    await withEnv("IMAGE_OPENAI_2_6_EDIT_ENABLED", "false", async () => {
      for (const modelId of ids) await assert.rejects(generateImageWithProvider({ ...request, modelId }), /cannot edit/);
    });
    assert.equal(network.mock.callCount(), 0);
    await withEnv("IMAGE_OPENAI_2_6_EDIT_ENABLED", "true", () => withEnv("OPENAI_IMAGE_API_KEY", "test-key", async () => {
      for (const model of models) {
        assert.equal(maxImageEditRequestCostMicroUsd(model, price), 57_686);
        assert.equal(imageEditCredits(model, price), 65);
        assert.equal(imageEditCredits(model, { ...price, credits: 64 }), null);
        assert.equal(imageEditCredits(model, { ...price, outputCostMicroUsd: 43_469 }), null);
        assert.equal(imageEditCredits(model, { ...price, quality: "high" }), null);
        assert.equal(imageEditCredits(model, { ...price, size: "1536x1024" }), null);
        network.mock.mockImplementationOnce(async (url, init) => {
          assert.equal(url, "https://api.openai.com/v1/images/edits");
          assert.equal(init.body.get("model"), model.id);
          assert.equal(init.body.get("n"), "1");
          assert.deepEqual(Buffer.from(await init.body.get("image").arrayBuffer()), editImage.bytes);
          return Response.json({
            data: [{ b64_json: "aW1hZ2U=" }],
            usage: { input_tokens: 1583, input_tokens_details: { text_tokens: 559, image_tokens: 1024 }, output_tokens: 1449 },
          });
        });
        const result = await generateImageWithProvider({ ...request, modelId: model.id });
        assert.equal(result.imageInputTokens, 1024);
        assert.equal(result.inputTokens, 559);
        assert.equal(result.outputTokens, 1449);
        assert.equal(result.requestParams.image.sha256, editImage.sha256);
        assert.ok(!JSON.stringify(result.requestParams).includes(editImage.bytes.toString("base64")));
      }
      const failedEdit = { ...request, modelId: ids[0] };
      network.mock.mockImplementationOnce(async () => Response.json({}, { status: 503 }));
      await assert.rejects(generateImageWithProvider(failedEdit), error => error.status === 503);
      network.mock.mockImplementationOnce(async () => { throw new Error("lost response"); });
      await assert.rejects(generateImageWithProvider(failedEdit), /Image provider request failed/);
    }));
    assert.equal(network.mock.callCount(), 4);
  } finally {
    resetActiveImageModelCatalog();
  }
});

test("a measurement sample is one request: a 5xx is not retried into a second paid generation", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ error: { message: "upstream" } }, { status: 500 });
  };
  try {
    await withEnv("OPENAI_IMAGE_API_KEY", "test-openai-key", () =>
      assert.rejects(
        generateImageForMeasurement(candidate("openai", "gpt-image-2.6-flare"), { prompt: "p", size: "1024x1024", quality: "medium" }),
        (error) => error instanceof ImageProviderError && error.status === 500
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

test("a Qwen result that was generated but could not be downloaded is marked as generated", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return Response.json({
        request_id: "req-1",
        output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/a.png" }] } }] },
        usage: { image_count: 1, width: 1024, height: 1024 },
      });
    }
    return new Response(null, { status: 403 });
  };
  try {
    await withEnv("DASHSCOPE_API_KEY", "test-qwen-key", () =>
      assert.rejects(
        generateImageForMeasurement(candidate("qwen", "wan2.7-image"), { prompt: "p", size: "1024x1024", quality: "medium" }),
        (error) => error instanceof ImageProviderError && error.afterGeneration === true && error.status === 403
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(urls.length, 2);
});

test("a Google measurement sample is one request, a rate limit included; other providers are refused", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ error: { code: 429, message: "rate" } }, { status: 429 });
  };
  try {
    await withEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-google-key", () =>
      assert.rejects(
        generateImageForMeasurement(
          candidate("google", "gemini-nano-banana-2.1", { maxOutputTokens: 8_192, deliveryMimeType: "image/jpeg", outputMimeTypes: ["image/jpeg"] }),
          { prompt: "p", size: "1024x1024", quality: "medium" }
        ),
        (error) => error instanceof ImageProviderError && error.status === 429
      )
    );
    await assert.rejects(
      generateImageForMeasurement(candidate("xai", "grok-x"), { prompt: "p", size: "1024x1024", quality: "medium" }),
      /No billing measurement/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});

for (const spec of [
  { provider: "byteplus", id: "dola-seedream-5-5-261028", env: "ARK_API_KEY", unit: 20_000, url: "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations" },
  { provider: "recraft", id: "recraftv4_pro", env: "RECRAFT_API_TOKEN", unit: 250_000, url: "https://external.api.recraft.ai/v1/images/generations" },
]) {
  test(`${spec.provider} serves the exact priced native PNG and submits at most once`, async t => {
    const seed = IMAGE_MODEL_REGISTRY.find(model => model.id === spec.id);
    assert.equal(seed.disabledReason, null);
    assert.ok(seed.prices.every(price => price.credits === (spec.provider === "byteplus" ? 45 : 350)));
    assert.ok(seed.prices.every(price => price.outputCostMicroUsd === spec.unit));
    const request = { prompt: "private brief", modelId: seed.id, quality: "medium", size: seed.sizes[0] };
    const editImage = { bytes: Buffer.from("private photo"), width: 45, height: 60, mimeType: "image/png", sha256: "a".repeat(64) };
    const network = t.mock.method(globalThis, "fetch");
    const sharp = (await import("sharp")).default;
    const png = async size => {
      const [width, height] = size.split("x").map(Number);
      return sharp({ create: { width, height, channels: 3, background: "yellow" } }).png().toBuffer();
    };
    setActiveImageModelCatalog([seed]);
    try {
      await withEnv(spec.env, "", () => assert.rejects(generateImageWithProvider(request), /key is not configured/));
      await withEnv(spec.env, "local-token", async () => {
        const wrongSize = spec.provider === "recraft" ? "1024x1024" : "2048x2048";
        await assert.rejects(generateImageWithProvider({ ...request, size: wrongSize }), /Unsupported direct/);
        await assert.rejects(generateImageWithProvider({ ...request, quality: "high" }), /Unsupported direct/);
        if (spec.provider === "recraft") {
          await assert.rejects(generateImageWithProvider({ ...request, editImage }), /cannot edit/);
        }
        assert.equal(network.mock.callCount(), 0);
        for (const size of seed.sizes) {
          const bytes = await png(size);
          network.mock.mockImplementation(async (url, init) => {
            assert.equal(url, spec.url);
            assert.equal(init.redirect, "error");
            assert.equal(init.method, "POST");
            assert.equal(init.headers.Authorization, "Bearer local-token");
            return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }, { headers: { "x-request-id": "local-job" } });
          });
          const result = await generateImageWithProvider({ ...request, size });
          const common = { model: seed.apiModelId, prompt: request.prompt, size, response_format: "b64_json" };
          assert.deepEqual(JSON.parse(network.mock.calls.at(-1).arguments[1].body), spec.provider === "recraft" ?
            { ...common, image_format: "png", n: 1 } : { ...common, output_format: "png", background: "opaque", layer_decomposition: false, watermark: false });
          assert.deepEqual(result.imageBytes, bytes);
          assert.equal(`${result.outputWidth}x${result.outputHeight}`, size);
          assert.equal(result.providerRequestId, "local-job");
          assert.ok(!Object.hasOwn(result.requestParams, "prompt"));
        }
        if (spec.provider === "byteplus") {
          const result = await generateImageWithProvider({ ...request, size: seed.sizes.at(-1), editImage });
          const data = JSON.parse(network.mock.calls.at(-1).arguments[1].body);
          assert.equal(data.image, "data:image/png;base64," + editImage.bytes.toString("base64"));
          assert.equal(result.requestParams.endpoint, "generations");
          assert.equal(result.requestParams.image.sha256, editImage.sha256);
          assert.ok(!JSON.stringify(result.requestParams).includes(editImage.bytes.toString("base64")));
        }
        const small = await png("64x64");
        const item = { b64_json: small.toString("base64") };
        for (const [reply, phase, produced] of [
          [() => Response.json({ data: [item] }), "provider_failed", true],
          [() => Response.json({ data: [item, item] }), "provider_failed", true],
          [() => Response.json({ data: [{ url: "https://invalid.example/file" }] }), "provider_failed", true],
          [() => Response.json({ data: [item] }, { headers: { "content-length": "30000000" } }), "provider_failed", true],
          [() => Response.json({ error: { code: "InputImageSensitiveContentDetected" } }, { status: 400 }), "provider_moderation_rejected", false],
          [() => Response.json({}, { status: 429 }), "provider_rate_limited", false],
          [() => { throw new Error("connection lost"); }, "provider_failed", false],
        ]) {
          network.mock.mockImplementation(reply);
          const before = network.mock.callCount();
          await assert.rejects(generateImageWithProvider(request), error => error.failurePhase === phase && error.afterGeneration === produced);
          assert.equal(network.mock.callCount(), before + 1);
        }
      });
    } finally {
      resetActiveImageModelCatalog();
    }
  });
}

const ideogramRequest = { modelId: "ideogram-4-6", prompt: "Grand opening", size: "1024x1024", quality: "medium" };
const ideogramAsset = "https://ideogram.ai/api/images/ephemeral/sample.png";
const ideogramItem = { is_image_safe: true, resolution: "1024x1024", url: ideogramAsset };

const withPricedIdeogram = run => withEnv("IDEOGRAM_API_KEY", "ideogram-test-key", run);

test("direct Ideogram sends one priced generation per tier, then downloads a verified image without the key", async t => {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "white" } }).png().toBuffer();
  const network = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === ideogramAsset) {
      assert.equal(init.headers, undefined);
      assert.equal(init.redirect, "manual");
      const asset = new Response(bytes, { headers: { "content-type": "image/png" } });
      Object.defineProperty(asset, "url", { value: url });
      return asset;
    }
    assert.equal(url, "https://api.ideogram.ai/v2/image/generate/ideogram-4-6");
    assert.equal(init.headers["Api-Key"], "ideogram-test-key");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    return Response.json({ generation_id: "sample-1", data: [ideogramItem] });
  });
  await withPricedIdeogram(async () => {
    for (const quality of ["low", "medium", "high"]) {
      const result = await generateImageWithProvider({ ...ideogramRequest, quality });
      const sent = JSON.parse(network.mock.calls.at(-2).arguments[1].body);
      assert.deepEqual(sent, {
        prompt: ideogramRequest.prompt, size: "1024x1024", quality, background: "opaque",
        magic_prompt: "off", async: false, num_images: 1,
      });
      assert.equal(result.providerRequestId, "sample-1");
      assert.deepEqual(result.imageBytes, bytes);
      assert.equal(result.outputWidth, 1024);
      assert.equal(result.outputHeight, 1024);
      assert.equal(result.mimeType, "image/png");
      assert.ok(!Object.hasOwn(result.requestParams, "prompt"));
    }
    const seed = IMAGE_MODEL_REGISTRY.find(model => model.id === ideogramRequest.modelId);
    assert.deepEqual(seed.prices.map(price => price.credits), [50, 90, 150]);
    setActiveImageModelCatalog([{ ...seed, prices: seed.prices.map(price => ({
      ...price, outputCostMicroUsd: price.outputCostMicroUsd - 1,
    })) }]);
    try {
      await assert.rejects(generateImageWithProvider(ideogramRequest), /Unsupported Ideogram/);
    } finally {
      resetActiveImageModelCatalog();
    }
    await assert.rejects(generateImageWithProvider({ ...ideogramRequest, size: "1536x1024" }), /Unsupported Ideogram/);
    await assert.rejects(generateImageWithProvider({ ...ideogramRequest, editImage: { bytes } }), /cannot edit/);
    await withEnv("IDEOGRAM_API_KEY", "", () => assert.rejects(generateImageWithProvider(ideogramRequest), /key is not configured/));
  });
  assert.equal(network.mock.callCount(), 6);
});

test("direct Ideogram rejects unsafe, malformed, or untrusted output and never retries a paid submit", async t => {
  const replies = [
    [422, {}, "provider_moderation_rejected"],
    [402, {}, "provider_failed"],
    [429, {}, "provider_rate_limited"],
    [503, {}, "provider_failed"],
    [200, { data: [{ ...ideogramItem, is_image_safe: false }] }, "provider_moderation_rejected"],
    [200, { data: [ideogramItem, ideogramItem] }, "provider_failed"],
    [200, { data: [{ ...ideogramItem, resolution: "2048x2048" }] }, "provider_failed"],
    [200, { data: [{ ...ideogramItem, url: "https://example.com/sample.png" }] }, "provider_failed"],
  ];
  let reply;
  const network = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ generation_id: "sample-1", ...reply[1] }, { status: reply[0] })
  );
  await withPricedIdeogram(async () => {
    for (reply of replies) {
      await assert.rejects(generateImageWithProvider(ideogramRequest),
        error => error instanceof ImageProviderError && error.failurePhase === reply[2]);
    }
  });
  assert.equal(network.mock.callCount(), replies.length);
});

test("Ideogram Medium photo edit uses one multipart reference and the existing 90-credit option", async t => {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "red" } }).png().toBuffer();
  const photo = Buffer.from("private source photo");
  const editImage = { bytes: photo, mimeType: "image/png", width: 640, height: 480, sha256: "d".repeat(64) };
  const network = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === ideogramAsset) {
      assert.equal(init.headers, undefined);
      const asset = new Response(bytes, { headers: { "content-type": "image/png" } });
      Object.defineProperty(asset, "url", { value: url });
      return asset;
    }
    assert.equal(url, "https://api.ideogram.ai/v2/image/generate/ideogram-4-6");
    assert.equal(init.headers["Api-Key"], "ideogram-test-key");
    assert.ok(!Object.hasOwn(init.headers, "Content-Type"));
    assert.deepEqual([...init.body.keys()], ["prompt", "size", "quality", "background", "num_images", "magic_prompt", "async", "images"]);
    assert.equal(init.body.get("quality"), "medium");
    assert.equal(init.body.get("size"), "1024x1024");
    assert.equal(init.body.get("num_images"), "1");
    assert.deepEqual(Buffer.from(await init.body.get("images").arrayBuffer()), photo);
    return Response.json({ generation_id: "sample-1", data: [ideogramItem] });
  });
  await withPricedIdeogram(() => withEnv("IMAGE_IDEOGRAM_EDIT_ENABLED", "true", async () => {
    const model = IMAGE_MODEL_REGISTRY.find(row => row.id === ideogramRequest.modelId);
    const medium = model.prices.find(price => price.quality === "medium");
    assert.equal(imageEditCredits(model, medium), 90);
    assert.equal(maxImageEditRequestCostMicroUsd(model, medium), 65_000);
    assert.equal(imageEditCredits(model, { ...medium, outputCostMicroUsd: 59_999 }), null);
    await assert.rejects(generateImageWithProvider({ ...ideogramRequest, quality: "high", editImage }), /cannot edit/);
    const result = await generateImageWithProvider({ ...ideogramRequest, editImage });
    assert.deepEqual(result.imageBytes, bytes);
    assert.equal(result.requestParams.image.sha256, editImage.sha256);
    const audit = JSON.stringify(result.requestParams);
    for (const privateValue of [photo.toString("base64"), photo.toString(), ideogramRequest.prompt, "ideogram-test-key"]) {
      assert.ok(!audit.includes(privateValue));
    }
  }));
  assert.equal(network.mock.callCount(), 2);
});

test("Recraft V4 Pro edits a square reference with zero data retention and delivers native 2K", async t => {
  const sharp = (await import("sharp")).default;
  const png = (width, height) => sharp({ create: { width, height, channels: 3, background: "blue" } }).png().toBuffer();
  const source = await png(640, 480);
  const editImage = { bytes: source, mimeType: "image/png", width: 640, height: 480, sha256: "e".repeat(64) };
  const model = IMAGE_MODEL_REGISTRY.find(row => row.id === "recraftv4_pro");
  const price = model.prices[0];
  const request = { modelId: model.id, quality: price.quality, size: price.size, prompt: "private edit brief", editImage };
  setActiveImageModelCatalog([model]);
  const network = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://external.api.recraft.ai/v1/images/imageToImage");
    assert.equal(init.redirect, "error");
    const { image_url, ...params } = JSON.parse(init.body);
    assert.deepEqual(params, {
      model: model.apiModelId, response_format: "b64_json", strength: 0.65, zdr: true, image_format: "png", n: 1, prompt: request.prompt,
    });
    assert.ok(image_url.startsWith("data:image/png;base64,"));
    const reference = image_url.split(",")[1];
    const photo = await sharp(Buffer.from(reference, "base64")).metadata();
    assert.equal(photo.width, 2048);
    assert.equal(photo.height, 2048);
    return Response.json({ credits: 250, data: [{ image_id: "recraft-edit-1", b64_json: reference }] });
  });
  try {
    await withEnv("IMAGE_RECRAFT_EDIT_ENABLED", "false", () => assert.rejects(generateImageWithProvider(request), /cannot edit/));
    await withEnv("IMAGE_RECRAFT_EDIT_ENABLED", "true", () => withEnv("RECRAFT_API_TOKEN", "test-key", async () => {
      assert.equal(imageEditCredits(model, price), 350);
      assert.equal(imageEditCredits(model, { ...price, size: "1024x1024" }), null);
      assert.equal(imageEditCredits(model, { ...price, outputCostMicroUsd: 249_999 }), null);
      const result = await generateImageWithProvider(request);
      assert.equal(result.outputWidth, 2048);
      assert.equal(result.outputHeight, 2048);
      assert.equal(result.reportedCostMicroUsd, 250_000);
      assert.equal(result.requestParams.image.width, 2048);
      assert.equal(result.requestParams.endpoint, "imageToImage");
      assert.ok(!JSON.stringify(result.requestParams).includes("base64"));
      assert.ok(!JSON.stringify(result.requestParams).includes(request.prompt));
    }));
  } finally {
    resetActiveImageModelCatalog();
  }
  assert.equal(network.mock.callCount(), 1);
});

test("the background remover sends only the padded photo and accepts only a same-size cut-out", async t => {
  const sharp = (await import("sharp")).default;
  const { getImageModel, imagePhotoToolAdmitted, isImagePhotoTool, listImageModels, minimumCreditsForImageOption } =
    createRequire(import.meta.url)("../lib/imageModelRegistry.ts");
  const id = "recraft-remove-background";
  const model = getImageModel(id);
  const price = model.prices[0];
  assert.ok(isImagePhotoTool(id));
  // Admission is the owning feature's word, never a model id the caller sent (a Chat edit carries a photo too).
  assert.equal(imagePhotoToolAdmitted(id, { hasPhoto: true }), false);
  assert.equal(imagePhotoToolAdmitted(id, { photoTools: ["bria/rmbg-3"], hasPhoto: true }), false);
  assert.equal(imagePhotoToolAdmitted(id, { photoTools: [id], hasPhoto: false }), false);
  assert.equal(imagePhotoToolAdmitted(id, { photoTools: [id, "bria/rmbg-3"], hasPhoto: true }), true);
  assert.equal(imagePhotoToolAdmitted("gpt-image-2", { hasPhoto: false }), true);
  // Never a catalogue row: no picker, router or comparison can list it.
  assert.ok(!IMAGE_MODEL_REGISTRY.some(row => row.id === id) && !listImageModels().some(row => row.id === id));
  assert.deepEqual([price.size, price.quality, price.credits, price.outputCostMicroUsd], ["1024x1024", "medium", 20, 10_000]);
  assert.equal(minimumCreditsForImageOption(model, price), 17);

  const source = await sharp({ create: { width: 640, height: 480, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer();
  const editImage = { bytes: source, mimeType: "image/png", width: 640, height: 480, sha256: "e".repeat(64) };
  const request = { modelId: id, quality: "medium", size: "1024x1024", prompt: "private label", editImage };
  const cutOut = (side, channels = 4) =>
    sharp({ create: { width: side, height: side, channels, background: { r: 9, g: 9, b: 9, alpha: 0 } } }).png().toBuffer();
  let answer = async () => ({ credits: 10, image: { image_id: "cut-1", b64_json: (await cutOut(1024)).toString("base64") } });
  const network = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://external.api.recraft.ai/v1/images/removeBackground");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    const { image_url, ...params } = JSON.parse(init.body);
    assert.deepEqual(params, { response_format: "b64_json", image_format: "png", zdr: true });
    const photo = await sharp(Buffer.from(image_url.replace("data:image/png;base64,", ""), "base64")).metadata();
    assert.deepEqual([photo.width, photo.height, photo.hasAlpha], [1024, 1024, false]);
    return Response.json(await answer());
  });
  const enabled = run => withEnv("IMAGE_RECRAFT_BACKGROUND_REMOVAL_ENABLED", "true", () => withEnv("RECRAFT_API_TOKEN", "test-key", run));

  await withEnv("IMAGE_RECRAFT_BACKGROUND_REMOVAL_ENABLED", "false", async () => {
    assert.equal(imageEditCredits(model, price), null);
    await assert.rejects(generateImageWithProvider(request), /cannot edit/);
  });
  await enabled(async () => {
    assert.equal(imageEditCredits(model, price), 20);
    assert.equal(imageEditCredits(model, { ...price, outputCostMicroUsd: 9_999 }), null);
    // A tool generates nothing: a request without a photo never reaches the provider.
    await assert.rejects(generateImageWithProvider({ ...request, editImage: undefined }), /Unsupported background removal/);
    assert.equal(network.mock.callCount(), 0);

    const result = await generateImageWithProvider(request);
    assert.deepEqual([result.outputWidth, result.outputHeight, result.mimeType], [1024, 1024, "image/png"]);
    assert.equal(result.reportedCostMicroUsd, 10_000);
    assert.equal(result.providerRequestId, "cut-1");
    assert.deepEqual([result.requestParams.endpoint, result.requestParams.image.width], ["removeBackground", 1024]);
    const audit = JSON.stringify(result.requestParams);
    assert.ok(!audit.includes("base64") && !audit.includes(request.prompt));

    // Nearly opaque comes back opaque; a real edge keeps its transparency.
    const raw = Buffer.alloc(1024 * 1024 * 4, 9);
    for (let i = 3; i < raw.length; i += 4) raw[i] = i < 4 * 1024 * 8 ? 100 : 245;
    const soft = await sharp(raw, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
    answer = async () => ({ credits: 10, image: { b64_json: soft.toString("base64") } });
    const solid = await sharp((await generateImageWithProvider(request)).imageBytes).raw().toBuffer();
    assert.deepEqual([solid[3], solid[4 * 1024 * 512 + 3]], [100, 255]);

    // Billed, then refused: another size, or a picture with no alpha channel.
    for (const bytes of [await cutOut(512), await cutOut(1024, 3)]) {
      answer = async () => ({ credits: 10, image: { b64_json: bytes.toString("base64") } });
      await assert.rejects(generateImageWithProvider(request),
        error => error instanceof ImageProviderError && error.afterGeneration === true);
    }
    answer = async () => ({ credits: 10, image: { url: "https://img.recraft.ai/cut.png" } });
    await assert.rejects(generateImageWithProvider(request), error => error.afterGeneration === true);
  });
  assert.equal(network.mock.callCount(), 5);
});

test("Bria's remover goes through fal with the platform headers and reads its cut-out from fal's CDN only", async t => {
  const sharp = (await import("sharp")).default;
  const { getImageModel, minimumCreditsForImageOption } = createRequire(import.meta.url)("../lib/imageModelRegistry.ts");
  const id = "bria/rmbg-3";
  const model = getImageModel(id);
  const price = model.prices[0];
  assert.deepEqual([model.provider, price.size, price.credits, price.outputCostMicroUsd], ["fal", "1024x1024", 26, 18_000]);
  assert.equal(minimumCreditsForImageOption(model, price), 26);
  const source = await sharp({ create: { width: 480, height: 640, channels: 3, background: "green" } }).png().toBuffer();
  const request = {
    modelId: id, quality: "medium", size: "1024x1024", prompt: "private label",
    editImage: { bytes: source, mimeType: "image/png", width: 480, height: 640, sha256: "f".repeat(64) },
  };
  const png = (side, channels = 4) =>
    sharp({ create: { width: side, height: side, channels, background: { r: 1, g: 2, b: 3, alpha: 0 } } }).png().toBuffer();
  let payload = { image: { url: "https://v3b.fal.media/files/cut.png", content_type: "image/png", width: 1024, height: 1024 } };
  let asset = async () => new Response(await png(1024), { headers: { "content-type": "image/png" } });
  const seen = [];
  const network = t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push(String(url));
    if (String(url) === "https://fal.run/bria/rmbg-3") {
      assert.equal(init.headers.Authorization, "Key test-fal-key");
      assert.equal(init.headers["X-Fal-No-Retry"], "1");
      assert.equal(init.headers["X-Fal-Store-IO"], "0");
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ["image_url"]);
      const photo = await sharp(Buffer.from(body.image_url.replace("data:image/png;base64,", ""), "base64")).metadata();
      assert.deepEqual([photo.width, photo.height, photo.hasAlpha], [1024, 1024, false]);
      return Response.json(payload, { headers: { "x-fal-request-id": "fal-cut-1" } });
    }
    assert.equal(init.redirect, "manual");
    const response = await asset();
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  });
  const billedThenRefused = error => error instanceof ImageProviderError && error.afterGeneration === true;
  await withEnv("IMAGE_FAL_BRIA_BACKGROUND_REMOVAL_ENABLED", "false", async () => {
    assert.equal(imageEditCredits(model, price), null);
    await assert.rejects(generateImageWithProvider(request), /cannot edit/);
  });
  await withEnv("IMAGE_FAL_BRIA_BACKGROUND_REMOVAL_ENABLED", "true", () => withEnv("FAL_KEY", "test-fal-key", async () => {
    assert.equal(imageEditCredits(model, price), 26);
    const result = await generateImageWithProvider(request);
    assert.deepEqual([result.outputWidth, result.outputHeight, result.mimeType, result.providerRequestId], [1024, 1024, "image/png", "fal-cut-1"]);
    // fal reports no cost: the fixed price is what settles.
    assert.equal(result.reportedCostMicroUsd, undefined);
    assert.equal(result.requestParams.endpoint, "removeBackground");
    assert.ok(!JSON.stringify(result.requestParams).includes("base64"));

    // Billed, then refused: an asset off fal's CDN is never fetched, and a wrong size or a picture without alpha is not a cut-out.
    payload = { image: { url: "https://example.invalid/cut.png", content_type: "image/png" } };
    await assert.rejects(generateImageWithProvider(request), billedThenRefused);
    assert.ok(!seen.some(url => url.includes("example.invalid")));
    payload = { image: { url: "https://v3b.fal.media/files/cut.png", content_type: "image/png" } };
    for (const bytes of [await png(512), await png(1024, 3)]) {
      asset = async () => new Response(bytes, { headers: { "content-type": "image/png" } });
      await assert.rejects(generateImageWithProvider(request), billedThenRefused);
    }
    payload = { images: [{ url: "https://v3b.fal.media/files/cut.png", content_type: "image/png" }] };
    await assert.rejects(generateImageWithProvider(request), billedThenRefused);
  }));
  assert.equal(network.mock.callCount(), 8);
});
