import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  generateImageWithProvider,
  ImageProviderError,
  openAiEditInputTokens,
} from "../lib/imageProviderAdapter.ts";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_EDIT_MODEL_IDS,
  imageEditPricing,
  imageModelSupportsEdit,
} from "../lib/imageGenerationPricing.ts";
import { readChatImageTurnRequest } from "../lib/chatImageTurnCore.ts";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate.ts";

// Required, not imported: the adapter reaches the registry through tsx's
// CommonJS loader, and an ESM import is a second instance (see
// tests/imageProviderAdapter.test.mjs).
const { getImageModel, imageEditCredits, maxImageEditRequestCostMicroUsd, maxImageRequestCostMicroUsd } =
  createRequire(import.meta.url)("../lib/imageModelRegistry.ts");

test("every edit option stays under the per-credit ceiling with its surcharge", () => {
  const editing = IMAGE_EDIT_MODEL_IDS.filter(imageModelSupportsEdit);
  assert.ok(editing.length > 0);
  for (const modelId of editing) {
    const model = getImageModel(modelId);
    assert.ok(model, modelId);
    const edit = imageEditPricing(modelId);
    for (const price of model.prices) {
      const worst = maxImageEditRequestCostMicroUsd(model, price);
      assert.equal(worst, maxImageRequestCostMicroUsd(model, price) + edit.inputBudgetMicroUsd);
      const credits = price.credits + edit.surchargeCredits;
      assert.ok(
        worst / credits <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
        `${modelId} ${price.quality} ${price.size}: ${worst / credits} per credit`
      );
    }
  }
});

test("OpenAI, xAI and fal have edit adapters; Google direct does not", () => {
  assert.deepEqual([...IMAGE_EDIT_MODEL_IDS].sort(), [
    "fal-ai/nano-banana-2",
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
  assert.equal(imageModelSupportsEdit("gpt-image-2"), true);
  assert.equal(imageModelSupportsEdit("gemini-3.1-flash-image"), false);
  assert.equal(imageModelSupportsEdit("toString"), false);
});

test("each edit price is the measured one", () => {
  assert.deepEqual(imageEditPricing("gpt-image-2").inputTokens, { maxTokens: 10_000, usdPerMillionTokens: 8 });
  // Measured 2026-10-29: xAI billed US$0.06 for an edit, US$0.01 over its output price.
  const grok = imageEditPricing("grok-imagine-image-quality-20260403");
  assert.equal(grok.inputBudgetMicroUsd, 10_000);
  assert.equal(grok.surchargeCredits, 10);
  assert.equal(grok.inputTokens, null);
  // fal sells the edit at the generation price.
  const fal = imageEditPricing("fal-ai/nano-banana-2");
  assert.equal(fal.inputBudgetMicroUsd, 0);
  assert.equal(fal.surchargeCredits, 0);
  for (const modelId of IMAGE_EDIT_MODEL_IDS) {
    assert.equal(imageEditPricing(modelId).verification.verifiedAt, "2026-10-29", modelId);
  }
  // A model without edit pricing has no edit worst case.
  const gemini = getImageModel("gemini-3.1-flash-image");
  assert.equal(maxImageEditRequestCostMicroUsd(gemini, { quality: "medium", size: "1024x1024", credits: 1, outputCostMicroUsd: 1 }), null);
});

test("an edit's input splits text from image tokens, and a missing split bills as image", () => {
  assert.deepEqual(openAiEditInputTokens(4_400, { text_tokens: 40, image_tokens: 4_360 }), {
    textTokens: 40,
    imageTokens: 4_360,
  });
  assert.deepEqual(openAiEditInputTokens(4_400, { image_tokens: 4_360 }), {
    textTokens: 40,
    imageTokens: 4_360,
  });
  assert.deepEqual(openAiEditInputTokens(4_400, undefined), { textTokens: 0, imageTokens: 4_400 });
});

const editImage = {
  bytes: Buffer.from("png-bytes"),
  mimeType: "image/png",
  width: 1024,
  height: 768,
  sha256: "a".repeat(64),
};

const withFetch = async (fake, run) => {
  const original = globalThis.fetch;
  const key = process.env.OPENAI_IMAGE_API_KEY;
  globalThis.fetch = fake;
  process.env.OPENAI_IMAGE_API_KEY = "test-image-key";
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.OPENAI_IMAGE_API_KEY;
    else process.env.OPENAI_IMAGE_API_KEY = key;
  }
};

test("an edit is a multipart call to the edits endpoint carrying the photo", async () => {
  const calls = [];
  const result = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        data: [{ b64_json: Buffer.from("out").toString("base64") }],
        usage: { input_tokens: 4_420, output_tokens: 4_160, input_tokens_details: { text_tokens: 60, image_tokens: 4_360 } },
      });
    },
    () =>
      generateImageWithProvider({
        prompt: "make the pine tree 30% smaller",
        size: "1024x1024",
        quality: "medium",
        modelId: "gpt-image-2",
        editImage,
      })
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("prompt"), "make the pine tree 30% smaller");
  assert.equal(form.get("size"), "1024x1024");
  assert.equal(form.get("quality"), "medium");
  assert.equal(Buffer.from(await form.get("image").arrayBuffer()).toString(), "png-bytes");
  // fetch writes the multipart boundary; a JSON content type would break it.
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-image-key");
  assert.equal(result.inputTokens, 60);
  assert.equal(result.imageInputTokens, 4_360);
  // The audit record describes the photo and never carries it or the prompt.
  assert.equal(result.requestParams.endpoint, "edits");
  assert.deepEqual(result.requestParams.image, {
    mimeType: "image/png",
    width: 1024,
    height: 768,
    byteSize: 9,
    sha256: "a".repeat(64),
  });
  assert.equal(result.requestParams.prompt, undefined);
  assert.equal(JSON.stringify(result.requestParams).includes("png-bytes"), false);
});

test("a generation still goes to the generations endpoint as JSON", async () => {
  const calls = [];
  const result = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return Response.json({ data: [{ b64_json: Buffer.from("out").toString("base64") }], usage: { input_tokens: 12 } });
    },
    () => generateImageWithProvider({ prompt: "a cat", size: "1024x1024", quality: "low", modelId: "gpt-image-2" })
  );
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(calls[0].init.body).prompt, "a cat");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.imageInputTokens, undefined);
});

test("a model without an edit adapter refuses an edit before any call", async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return Response.json({});
    },
    () =>
      assert.rejects(
        generateImageWithProvider({
          prompt: "smaller tree",
          size: "1024x1024",
          quality: "medium",
          modelId: "gemini-3.1-flash-image",
          editImage,
        }),
        (error) => error instanceof ImageProviderError && /not available|cannot edit/.test(error.message)
      )
  );
  assert.equal(called, false);
});

test("the image-turn decision carries the edit flag and nothing else about the photo", () => {
  assert.deepEqual(readChatImageTurnRequest({ modelIds: ["gpt-image-2"], preset: "standard", edit: true }), {
    modelIds: ["gpt-image-2"],
    preset: "standard",
    edit: true,
  });
  assert.equal(readChatImageTurnRequest({ modelIds: [], preset: null, edit: "yes" }).edit, undefined);
});

test("native clients may ask the image-intent route only with parity on", () => {
  assert.equal(nativeParityBearerRoute("/api/chat/image-intent", "POST", true), true);
  assert.equal(nativeParityBearerRoute("/api/chat/image-intent", "GET", true), false);
  assert.equal(nativeParityBearerRoute("/api/chat/image-intent", "POST", false), false);
});

test("an edit keeps the photo's shape, read upright", async () => {
  const { imageEditOutputSize } = await import("../lib/imageGenerationPricing.ts");
  assert.equal(imageEditOutputSize(4032, 3024), "1536x1024");
  assert.equal(imageEditOutputSize(3024, 4032), "1024x1536");
  assert.equal(imageEditOutputSize(1000, 1050), "1024x1024");
  // EXIF orientation 6: stored landscape, shown portrait.
  assert.equal(imageEditOutputSize(4032, 3024, 6), "1024x1536");
  assert.equal(imageEditOutputSize(0, 0), "1024x1024");
});

test("an edit with no usage reported leaves the photo's tokens unknown, never zero", () => {
  assert.deepEqual(openAiEditInputTokens(null, undefined), { textTokens: 0, imageTokens: null });
});

test("the photo settles at the reservation's rate and budget, not the live constants", async () => {
  const { settledEditInputCostMicroUsd } = await import("../lib/imageGenerationService.ts");
  const snapshot = { edit: { inputUsdPerMillionTokens: 8, inputBudgetMicroUsd: 80_000 } };
  assert.equal(settledEditInputCostMicroUsd(snapshot, 4_360), 34_880);
  // A rate changed after the sale does not reach a job priced before it.
  assert.equal(settledEditInputCostMicroUsd({ edit: { inputUsdPerMillionTokens: 4, inputBudgetMicroUsd: 40_000 } }, 4_360), 17_440);
  // A photo billed per edit settles at its budget, whatever the usage says.
  assert.equal(settledEditInputCostMicroUsd({ edit: { inputUsdPerMillionTokens: null, inputBudgetMicroUsd: 20_000 } }, null), 20_000);
  assert.equal(settledEditInputCostMicroUsd({ edit: { inputUsdPerMillionTokens: null, inputBudgetMicroUsd: 0 } }, undefined), 0);
  assert.equal(settledEditInputCostMicroUsd({ edit: { inputUsdPerMillionTokens: null, inputBudgetMicroUsd: -1 } }, null), null);
  // No usage: the whole reserved photo budget, not a free photo.
  assert.equal(settledEditInputCostMicroUsd(snapshot, null), 80_000);
  assert.equal(settledEditInputCostMicroUsd(snapshot, undefined), 80_000);
  // A generation has no photo; unreadable edit pricing settles the reservation.
  assert.equal(settledEditInputCostMicroUsd({}, 4_360), 0);
  assert.equal(settledEditInputCostMicroUsd({ edit: { inputUsdPerMillionTokens: "8" } }, 4_360), null);
});

test("the switch is off unless set, and the gpt-image-2 budget rests on its measurement", async () => {
  const { imageEditEnabled } = await import("../lib/imageEditSource.ts");
  assert.equal(imageEditEnabled({ IMAGE_EDIT_ENABLED: "true" }), true);
  assert.equal(imageEditEnabled({}), false);
  assert.equal(imageEditEnabled({ IMAGE_EDIT_ENABLED: "1" }), false);
  // Measured 2026-10-29: a 1024px photo is at most 1,024 image tokens.
  assert.equal(imageEditPricing("gpt-image-2").verification.measuredMaxTokens, 1_024);
});

test("only EXIF orientations 5 to 8 turn the photo", async () => {
  const { imageEditOutputSize } = await import("../lib/imageGenerationPricing.ts");
  assert.equal(imageEditOutputSize(4032, 3024, 8), "1024x1536");
  assert.equal(imageEditOutputSize(4032, 3024, 9), "1536x1024");
});

test("an xAI edit is the generation's 1K square plus the photo as a data URL", async () => {
  const { buildXaiImageEditRequest, buildXaiImageRequest, xaiReportedCostMicroUsd } = await import(
    "../lib/xaiImageRequest.ts"
  );
  const request = { apiModelId: "grok-imagine-image-quality-20260403", prompt: "smaller tree", size: "1024x1024" };
  const body = buildXaiImageEditRequest({ ...request, image: { bytes: Buffer.from("png-bytes"), mimeType: "image/png" } });
  assert.deepEqual(body, {
    ...buildXaiImageRequest(request),
    image: { url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`, type: "image_url" },
  });
  // The priced scope does not widen for an edit.
  assert.equal(buildXaiImageEditRequest({ ...request, size: "1536x1024", image: { bytes: Buffer.from("x"), mimeType: "image/png" } }), null);
  // One USD is 10^10 ticks.
  assert.equal(xaiReportedCostMicroUsd({ usage: { cost_in_usd_ticks: 700_000_000 } }), 70_000);
  assert.equal(xaiReportedCostMicroUsd({ usage: {} }), null);
  assert.equal(xaiReportedCostMicroUsd(null), null);
});

test("a fal edit keeps every priced field and adds the photo as a data URI", async () => {
  const { buildFalImageEditRequest, buildFalImageRequest, FAL_EDIT_ENDPOINT_SUFFIX } = await import(
    "../lib/falImageRequest.ts"
  );
  const request = { prompt: "smaller tree", size: "1024x1024", outputFormat: "png" };
  const body = buildFalImageEditRequest({ ...request, image: { bytes: Buffer.from("png-bytes"), mimeType: "image/png" } });
  assert.deepEqual(body, {
    ...buildFalImageRequest(request),
    image_urls: [`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`],
  });
  assert.equal(body.aspect_ratio, "1:1");
  assert.equal(body.thinking_level, "high");
  assert.equal(body.enable_web_search, false);
  assert.equal(FAL_EDIT_ENDPOINT_SUFFIX, "/edit");
  assert.equal(buildFalImageEditRequest({ ...request, size: "1536x1024", image: { bytes: Buffer.from("x"), mimeType: "image/png" } }), null);
});

test("an xAI edit posts the photo to the edits endpoint and never audits its bytes", async () => {
  const calls = [];
  const result = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        data: [{ b64_json: Buffer.from("out").toString("base64"), mime_type: "image/jpeg" }],
        usage: { cost_in_usd_ticks: 600_000_000 },
      });
    },
    async () => {
      const key = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = "test-xai-key";
      try {
        return await generateImageWithProvider({
          prompt: "smaller tree",
          size: "1024x1024",
          quality: "medium",
          modelId: "grok-imagine-image-quality-20260403",
          editImage,
        });
      } finally {
        if (key === undefined) delete process.env.XAI_API_KEY;
        else process.env.XAI_API_KEY = key;
      }
    }
  );
  assert.equal(calls[0].url, "https://api.x.ai/v1/images/edits");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.image.url, `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
  assert.equal(body.resolution, "1k");
  assert.equal(body.aspect_ratio, "1:1");
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.reportedCostMicroUsd, 60_000);
  assert.equal(result.requestParams.endpoint, "edits");
  assert.equal(result.requestParams.image.sha256, "a".repeat(64));
  assert.equal(JSON.stringify(result.requestParams).includes(Buffer.from("png-bytes").toString("base64")), false);
});

test("a fal edit calls the /edit endpoint once and never audits the photo", async () => {
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#888" } }).png().toBuffer();
  const calls = [];
  const result = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      if (String(url).startsWith("https://fal.run/")) {
        return Response.json({ images: [{ url: "https://v3b.fal.media/files/out.png", content_type: "image/png" }] });
      }
      const asset = new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.byteLength) } });
      Object.defineProperty(asset, "url", { value: String(url) });
      return asset;
    },
    async () => {
      const key = process.env.FAL_KEY;
      process.env.FAL_KEY = "test-fal-key";
      try {
        return await generateImageWithProvider({
          prompt: "smaller tree",
          size: "1024x1024",
          quality: "medium",
          modelId: "fal-ai/nano-banana-2",
          editImage,
        });
      } finally {
        if (key === undefined) delete process.env.FAL_KEY;
        else process.env.FAL_KEY = key;
      }
    }
  );
  assert.equal(calls[0].url, "https://fal.run/fal-ai/nano-banana-2/edit");
  assert.equal(calls.filter((call) => String(call.url).startsWith("https://fal.run/")).length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.image_urls, [`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`]);
  assert.equal(body.thinking_level, "high");
  assert.equal(result.outputWidth, 1024);
  assert.equal(result.requestParams.endpoint, "edits");
  assert.equal("image_urls" in result.requestParams, false);
});

test("an edit is priced on the live option and refused where its photo breaks the ceiling", () => {
  const grok = getImageModel("grok-imagine-image-quality-20260403");
  assert.equal(imageEditCredits(grok, grok.prices[0]), 85);
  const gpt = getImageModel("gpt-image-2");
  const high = gpt.prices.find((price) => price.quality === "high" && price.size === "1024x1024");
  assert.equal(imageEditCredits(gpt, high), 340);
  // A catalogue revision to 62 credits still carries the generation
  // (55,000 / 62 = 887) but not the edit ((65,000) / 72 = 903).
  const lowered = { ...grok.prices[0], credits: 62 };
  assert.ok(maxImageRequestCostMicroUsd(grok, lowered) / 62 <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD);
  assert.equal(imageEditCredits(grok, lowered), null);
  assert.equal(imageEditCredits(getImageModel("gemini-3.1-flash-image"), { quality: "medium", size: "1024x1024", credits: 100, outputCostMicroUsd: 1 }), null);
});
