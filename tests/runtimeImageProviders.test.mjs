import assert from "node:assert/strict";
import test from "node:test";

import { imageFullProfileSchema } from "../lib/modelCatalogCore.ts";
import {
  RUNTIME_IMAGE_PROVIDERS,
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
