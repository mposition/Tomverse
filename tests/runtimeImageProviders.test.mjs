import assert from "node:assert/strict";
import test from "node:test";

import { imageFullProfileSchema } from "../lib/modelCatalogCore.ts";
import {
  RUNTIME_IMAGE_PROVIDERS,
  RUNTIME_IMAGE_QUALITIES,
  RUNTIME_IMAGE_SIZES,
  catalogImageDraftHref,
  discoveryDraftRequest,
  isRuntimeImageProvider,
  runtimeImageProfileTemplate,
} from "../lib/runtimeImageProviders.ts";

test("only providers with an image adapter can be added at runtime", () => {
  for (const provider of RUNTIME_IMAGE_PROVIDERS) assert.equal(isRuntimeImageProvider(provider), true);
  assert.equal(isRuntimeImageProvider("ideogram"), false);
  // The profile schema enforces the same list the panels show.
  const ideogram = imageFullProfileSchema.safeParse(runtimeImageProfileTemplate("ideogram", "ideogram-4.0"));
  assert.equal(ideogram.success, false);
});

test("qwen has an image adapter, so a discovered Qwen image model gets a catalogue draft", () => {
  assert.deepEqual([...RUNTIME_IMAGE_PROVIDERS], ["openai", "google", "xai", "fal", "qwen"]);
  assert.equal(isRuntimeImageProvider("qwen"), true);
  const parsed = imageFullProfileSchema.safeParse(runtimeImageProfileTemplate("qwen", "qwen-image-2.0"));
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.provider, "qwen");
});

test("a discovery link round-trips into the catalogue's draft request", () => {
  const href = catalogImageDraftHref("fal", "fal-ai/nano-banana-2.1");
  assert.ok(href.startsWith("/admin/models?"));
  const request = discoveryDraftRequest(href.slice(href.indexOf("?")));
  assert.deepEqual(request, { modelId: "fal-ai/nano-banana-2.1", provider: "fal", apiModelId: "fal-ai/nano-banana-2.1" });
  assert.equal(discoveryDraftRequest("?tab=catalog"), null);
  assert.equal(discoveryDraftRequest("?draft=image&model="), null);
});

test("the starting profile for an adapter provider passes the profile schema", () => {
  const parsed = imageFullProfileSchema.safeParse(runtimeImageProfileTemplate("fal", "fal-ai/nano-banana-2.1"));
  assert.equal(parsed.success, true);
});

test("the add form's name, sizes and qualities shape the starting profile; empty answers keep the defaults", () => {
  const chosen = runtimeImageProfileTemplate("openai", "gpt-image-3", {
    name: "  GPT Image 3 ",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["medium", "high"],
  });
  assert.equal(chosen.name, "GPT Image 3");
  assert.deepEqual(chosen.sizes, ["1024x1024", "1536x1024", "1024x1536"]);
  assert.deepEqual(chosen.qualities, ["medium", "high"]);
  assert.equal(imageFullProfileSchema.safeParse(chosen).success, true);

  const defaults = runtimeImageProfileTemplate("qwen", "qwen-image-2.0", { name: " ", sizes: [], qualities: [] });
  assert.deepEqual(defaults, runtimeImageProfileTemplate("qwen", "qwen-image-2.0"));
  assert.deepEqual([...RUNTIME_IMAGE_SIZES], imageFullProfileSchema.shape.sizes.element.options);
  assert.deepEqual([...RUNTIME_IMAGE_QUALITIES], imageFullProfileSchema.shape.qualities.element.options);
});

test("a provider whose request has one shape gets that shape, whatever the form chose", () => {
  // 2026-11-13: a runtime Google row (gemini-nano-banana-2.1) had no output
  // limit, asked for PNG and listed rectangles -- the Google request builder
  // refuses all three. Qwen maps 1024x1024 only.
  const all = { sizes: ["1024x1024", "1536x1024", "1024x1536"] };
  const google = runtimeImageProfileTemplate("google", "gemini-nano-banana-2.1", all);
  assert.deepEqual(google.sizes, ["1024x1024"]);
  assert.equal(google.deliveryMimeType, "image/jpeg");
  assert.ok(google.outputMimeTypes.includes("image/jpeg"));
  // The limit the measured bound holds for (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS).
  assert.equal(google.maxOutputTokens, 2_048);
  assert.deepEqual(google.provenance, ["synthid"]);
  assert.equal(imageFullProfileSchema.safeParse(google).success, true);

  const qwen = runtimeImageProfileTemplate("qwen", "wan2.7-image", all);
  assert.deepEqual(qwen.sizes, ["1024x1024"]);
  assert.equal(imageFullProfileSchema.safeParse(qwen).success, true);

  // Other providers keep what was chosen and carry no Google fields.
  const openai = runtimeImageProfileTemplate("openai", "gpt-image-3", all);
  assert.deepEqual(openai.sizes, all.sizes);
  assert.equal("maxOutputTokens" in openai, false);
});
