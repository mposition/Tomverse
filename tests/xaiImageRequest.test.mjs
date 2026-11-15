import assert from "node:assert/strict";
import test from "node:test";
import { imageFullProfileSchema } from "../lib/modelCatalogCore.ts";
import { runtimeImageProfileTemplate } from "../lib/runtimeImageProviders.ts";
import {
  buildXaiImageEditRequest,
  buildXaiImageRequest,
  parseXaiImageResponse,
  XAI_IMAGE_QUALITIES,
  XAI_IMAGES_URL,
  xaiModelTakesQuality,
} from "../lib/xaiImageRequest.ts";

// Contract tests for the xAI image path. The adapter itself is server-only and
// needs a network; everything that decides what is sent and what is believed
// lives here, where it can be pinned without either.

test("a 1K square request carries xAI's two resolution fields, not a size string", () => {
  const body = buildXaiImageRequest({
    apiModelId: "grok-imagine-image-quality-20260403",
    prompt: "a single red apple",
    size: "1024x1024",
  });
  assert.deepEqual(body, {
    model: "grok-imagine-image-quality-20260403",
    prompt: "a single red apple",
    resolution: "1k",
    aspect_ratio: "1:1",
    response_format: "b64_json",
    n: 1,
  });
});

test("a size with no mapping is refused rather than guessed", () => {
  // The approved credits price 1K. Sending a landscape as though it were the
  // same request would charge the 1K figure for an image xAI priced its own
  // way, and the user would never see the difference.
  for (const size of ["1536x1024", "1024x1536"]) {
    assert.equal(
      buildXaiImageRequest({
        apiModelId: "grok-imagine-image-quality-20260403",
        prompt: "x",
        size,
      }),
      null,
      size
    );
  }
});

test("the request pins the dated snapshot it is given, never an alias", () => {
  // Reproducibility: a -latest alias cannot carry a fixed price, because the
  // price was verified for one model.
  const body = buildXaiImageRequest({
    apiModelId: "grok-imagine-image-quality-20260403",
    prompt: "x",
    size: "1024x1024",
  });
  assert.match(String(body.model), /-\d{8}$/);
});

test("the endpoint is xAI's own, not a base-URL swap on OpenAI's", () => {
  assert.equal(XAI_IMAGES_URL, "https://api.x.ai/v1/images/generations");
});

test("the response's own MIME is what gets recorded", () => {
  // xAI is not told which format to emit and its documented example answers
  // JPEG. Filing those bytes as PNG would corrupt every consumer downstream
  // that trusts the recorded type.
  assert.deepEqual(
    parseXaiImageResponse({
      data: [{ b64_json: "AAAA", mime_type: "image/jpeg" }],
    }),
    { imageBase64: "AAAA", mimeType: "image/jpeg" }
  );
  assert.deepEqual(
    parseXaiImageResponse({
      data: [{ b64_json: "AAAA", mime_type: "image/webp" }],
    }),
    { imageBase64: "AAAA", mimeType: "image/webp" }
  );
});

test("a missing or unexpected MIME fails the response instead of defaulting", () => {
  // An absent type is not an invitation to assume one, and a type nobody has
  // seen before means the contract moved -- both are refusals, and the caller
  // refunds.
  const cases = [
    { data: [{ b64_json: "AAAA" }] },
    { data: [{ b64_json: "AAAA", mime_type: "" }] },
    { data: [{ b64_json: "AAAA", mime_type: "image/gif" }] },
    { data: [{ b64_json: "AAAA", mime_type: 7 }] },
  ];
  for (const payload of cases) {
    assert.equal(parseXaiImageResponse(payload), null, JSON.stringify(payload));
  }
});

test("an empty or malformed payload is refused, never half-read", () => {
  for (const payload of [null, undefined, {}, "nope", { data: [] }, { data: [{}] }, { data: [{ b64_json: "" }] }]) {
    assert.equal(parseXaiImageResponse(payload), null, JSON.stringify(payload ?? null));
  }
});

test("the audit snapshot of a request excludes the prompt", () => {
  // The prompt is already on the generation row. A second copy inside a JSON
  // blob is a second place every deletion path would have to reach, and the
  // snapshot exists to answer "what did we ask for", not "what did they type".
  const body = buildXaiImageRequest({
    apiModelId: "grok-imagine-image-quality-20260403",
    prompt: "something a user typed",
    size: "1024x1024",
  });
  const audited = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "prompt")
  );
  assert.ok(!("prompt" in audited));
  // Everything that decides what was billed survives.
  assert.deepEqual(audited, {
    model: "grok-imagine-image-quality-20260403",
    resolution: "1k",
    aspect_ratio: "1:1",
    response_format: "b64_json",
    n: 1,
  });
});

test("a Grok Imagine Image 2.x request states the quality the user was quoted", () => {
  // xAI release notes, August 2026: omitted, quality is `auto` -- low for a
  // generation, medium for an edit -- and "images are billed at the quality
  // they are served at". Stating it is the only way the bill matches the quote.
  for (const quality of XAI_IMAGE_QUALITIES) {
    assert.deepEqual(
      buildXaiImageRequest({ apiModelId: "grok-imagine-image-2.0", prompt: "x", size: "1024x1024", quality }),
      {
        model: "grok-imagine-image-2.0",
        prompt: "x",
        quality,
        resolution: "1k",
        aspect_ratio: "1:1",
        response_format: "b64_json",
        n: 1,
      }
    );
  }
  assert.deepEqual([...XAI_IMAGE_QUALITIES], ["low", "medium"]);
});

test("a 2.x request with no documented quality is refused, never left to auto", () => {
  for (const quality of ["high", "auto", "", undefined]) {
    assert.equal(
      buildXaiImageRequest({ apiModelId: "grok-imagine-image-2.0", prompt: "x", size: "1024x1024", quality }),
      null,
      String(quality)
    );
  }
});

test("an older xAI model's request carries no quality field, whatever the product asked", () => {
  assert.equal(xaiModelTakesQuality("grok-imagine-image-quality-20260403"), false);
  assert.equal(xaiModelTakesQuality("grok-imagine-image"), false);
  assert.equal(xaiModelTakesQuality("grok-imagine-image-2.0"), true);
  const body = buildXaiImageRequest({
    apiModelId: "grok-imagine-image-quality-20260403",
    prompt: "x",
    size: "1024x1024",
    quality: "medium",
  });
  assert.equal("quality" in body, false);
});

test("an edit of a 2.x model states its quality too", () => {
  const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
  const body = buildXaiImageEditRequest({ apiModelId: "grok-imagine-image-2.0", prompt: "x", size: "1024x1024", quality: "medium", image });
  assert.equal(body.quality, "medium");
  assert.equal(buildXaiImageEditRequest({ apiModelId: "grok-imagine-image-2.0", prompt: "x", size: "1024x1024", image }), null);
});

test("the starting profile for an xAI model offers only what the request can send", () => {
  const profile = runtimeImageProfileTemplate("xai", "grok-imagine-image-2.0", {
    sizes: ["1024x1024", "1536x1024"],
    qualities: ["low", "medium", "high"],
  });
  assert.deepEqual(profile.sizes, ["1024x1024"]);
  assert.deepEqual(profile.qualities, [...XAI_IMAGE_QUALITIES]);
  assert.deepEqual(runtimeImageProfileTemplate("xai", "grok-imagine-image-2.0").qualities, [...XAI_IMAGE_QUALITIES]);
  assert.equal(imageFullProfileSchema.safeParse(profile).success, true);
  for (const size of profile.sizes) {
    for (const quality of profile.qualities) {
      assert.notEqual(buildXaiImageRequest({ apiModelId: profile.apiModelId, prompt: "x", size, quality }), null);
    }
  }
});
