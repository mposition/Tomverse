import assert from "node:assert/strict";
import test from "node:test";
import {
  buildXaiImageRequest,
  parseXaiImageResponse,
  XAI_IMAGES_URL,
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
