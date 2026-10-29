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
  IMAGE_EDIT_INPUT_BUDGET_MICRO_USD,
  IMAGE_EDIT_MODEL_IDS,
  IMAGE_EDIT_SURCHARGE_CREDITS,
  imageModelSupportsEdit,
} from "../lib/imageGenerationPricing.ts";
import { readChatImageTurnRequest } from "../lib/chatImageTurnCore.ts";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate.ts";

// Required, not imported: the adapter reaches the registry through tsx's
// CommonJS loader, and an ESM import is a second instance (see
// tests/imageProviderAdapter.test.mjs).
const { getImageModel, maxImageEditRequestCostMicroUsd, maxImageRequestCostMicroUsd } =
  createRequire(import.meta.url)("../lib/imageModelRegistry.ts");

test("every edit option stays under the per-credit ceiling with its surcharge", () => {
  assert.ok(IMAGE_EDIT_MODEL_IDS.length > 0);
  for (const modelId of IMAGE_EDIT_MODEL_IDS) {
    const model = getImageModel(modelId);
    assert.ok(model, modelId);
    for (const price of model.prices) {
      const worst = maxImageEditRequestCostMicroUsd(model, price);
      assert.equal(worst, maxImageRequestCostMicroUsd(model, price) + IMAGE_EDIT_INPUT_BUDGET_MICRO_USD);
      const credits = price.credits + IMAGE_EDIT_SURCHARGE_CREDITS;
      assert.ok(
        worst / credits <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
        `${modelId} ${price.quality} ${price.size}: ${worst / credits} per credit`
      );
    }
  }
});

test("only the OpenAI edit endpoint is offered for edits", () => {
  assert.deepEqual(IMAGE_EDIT_MODEL_IDS, ["gpt-image-2"]);
  assert.equal(imageModelSupportsEdit("gpt-image-2"), true);
  assert.equal(imageModelSupportsEdit("grok-imagine-image-quality-20260403"), false);
  assert.equal(imageModelSupportsEdit("fal-ai/nano-banana-2"), false);
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
          modelId: "grok-imagine-image-quality-20260403",
          editImage,
        }),
        (error) => error instanceof ImageProviderError && /cannot edit/.test(error.message)
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
  // No usage: the whole reserved photo budget, not a free photo.
  assert.equal(settledEditInputCostMicroUsd(snapshot, null), 80_000);
  assert.equal(settledEditInputCostMicroUsd(snapshot, undefined), 80_000);
  // A generation has no photo; unreadable edit pricing settles the reservation.
  assert.equal(settledEditInputCostMicroUsd({}, 4_360), 0);
  assert.equal(settledEditInputCostMicroUsd({ edit: { inputUsdPerMillionTokens: "8" } }, 4_360), null);
});

test("the switch does nothing until the photo budget is backed by a measurement", async () => {
  const { imageEditEnabled } = await import("../lib/imageEditSource.ts");
  const { IMAGE_EDIT_INPUT_BUDGET_VERIFICATION, imageEditInputBudgetVerified } = await import(
    "../lib/imageGenerationPricing.ts"
  );
  // Measured 2026-10-29: a 1024px photo is at most 1,024 image tokens, inside
  // the 10,000 budget, so the switch alone now decides.
  assert.deepEqual(IMAGE_EDIT_INPUT_BUDGET_VERIFICATION, { verifiedAt: "2026-10-29", measuredMaxTokens: 1_024 });
  assert.equal(imageEditInputBudgetVerified(), true);
  assert.equal(imageEditEnabled({ IMAGE_EDIT_ENABLED: "true" }), true);
  assert.equal(imageEditEnabled({}), false);
  assert.equal(imageEditEnabled({ IMAGE_EDIT_ENABLED: "true" }, false), false);
  assert.equal(imageEditEnabled({ IMAGE_EDIT_ENABLED: "true" }, true), true);
  assert.equal(imageEditEnabled({}, true), false);
  // A measurement over the budget does not verify it.
  assert.equal(imageEditInputBudgetVerified({ verifiedAt: "2026-10-30", measuredMaxTokens: 6_000 }, 10_000), true);
  assert.equal(imageEditInputBudgetVerified({ verifiedAt: "2026-10-30", measuredMaxTokens: 12_000 }, 10_000), false);
  assert.equal(imageEditInputBudgetVerified({ verifiedAt: null, measuredMaxTokens: 6_000 }, 10_000), false);
});

test("only EXIF orientations 5 to 8 turn the photo", async () => {
  const { imageEditOutputSize } = await import("../lib/imageGenerationPricing.ts");
  assert.equal(imageEditOutputSize(4032, 3024, 8), "1024x1536");
  assert.equal(imageEditOutputSize(4032, 3024, 9), "1536x1024");
});
