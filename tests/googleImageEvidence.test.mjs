import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  redactGoogleImageRequestBody,
  redactGoogleImageResponseBody,
} from "../lib/googleImageEvidence.ts";

const digest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const requestBody = () => ({
  model: "gemini-3.1-flash-lite-image",
  input: "A cutaway technical illustration of a mechanical wristwatch movement",
  response_format: {
    type: "image",
    delivery: "inline",
    mime_type: "image/jpeg",
    aspect_ratio: "1:1",
    image_size: "1K",
  },
  generation_config: { max_output_tokens: 512, thinking_level: "high" },
});

test("the request keeps every field that decides the measurement", () => {
  const redacted = redactGoogleImageRequestBody(requestBody(), digest);

  // The numbers the verdict rests on must survive verbatim -- a report that
  // re-derived them from its own fields would be describing itself.
  assert.deepEqual(redacted.generation_config, {
    max_output_tokens: 512,
    thinking_level: "high",
  });
  assert.deepEqual(redacted.response_format, requestBody().response_format);
  assert.equal(redacted.model, "gemini-3.1-flash-lite-image");
});

test("the prompt is replaced by a digest, never carried", () => {
  const body = requestBody();
  const redacted = redactGoogleImageRequestBody(body, digest);

  assert.equal(
    redacted.input,
    `sha256:${digest(body.input)} (${body.input.length} chars)`
  );
  assert.ok(!JSON.stringify(redacted).includes("wristwatch"));
  // Same prompt, same digest: that is what makes two runs comparable without
  // either of them storing the text.
  assert.equal(
    redactGoogleImageRequestBody(requestBody(), digest).input,
    redacted.input
  );
});

test("a non-string prompt is left alone rather than half-redacted", () => {
  const redacted = redactGoogleImageRequestBody(
    { model: "m", input: { parts: ["a"] } },
    digest
  );
  assert.deepEqual(redacted.input, { parts: ["a"] });
});

const imageBytes = "A".repeat(1_400_000);

const responseBody = () => ({
  id: "interactions/abc123",
  steps: [
    { type: "thinking", content: [{ type: "text", text: "considering" }] },
    {
      type: "model_output",
      content: [
        { type: "image", mime_type: "image/jpeg", data: imageBytes },
      ],
    },
  ],
  status: "incomplete",
  usage: {
    total_input_tokens: 40,
    total_output_tokens: 300,
    total_thought_tokens: 212,
    total_tokens: 552,
  },
});

test("image bytes are replaced by a digest and a length", () => {
  const redacted = redactGoogleImageResponseBody(responseBody(), digest);
  const image = redacted.steps[1].content[0];

  assert.equal(image.data, `sha256:${digest(imageBytes)} (1400000 chars)`);
  assert.equal(image.mime_type, "image/jpeg");
  assert.ok(!JSON.stringify(redacted).includes("AAAA"));
});

test("everything the verdict reads survives the redaction", () => {
  const redacted = redactGoogleImageResponseBody(responseBody(), digest);

  assert.equal(redacted.id, "interactions/abc123");
  assert.equal(redacted.status, "incomplete");
  assert.deepEqual(redacted.usage, responseBody().usage);
  assert.deepEqual(
    redacted.steps.map((step) => step.type),
    ["thinking", "model_output"]
  );
  assert.equal(redacted.steps[0].content[0].text, "considering");
});

test("a payload that moved its bytes elsewhere is still redacted", () => {
  // The named `data` key is the documented location. This is the case that
  // rule alone would miss, and it is the one that would write a megabyte of
  // base64 into a file someone is expected to read.
  const redacted = redactGoogleImageResponseBody(
    { steps: [{ type: "model_output", inline: { bytes: imageBytes } }] },
    digest
  );
  assert.equal(
    redacted.steps[0].inline.bytes,
    `sha256:${digest(imageBytes)} (1400000 chars)`
  );
});

test("short strings under a data key are still redacted", () => {
  // Not a size heuristic dressed up: `data` is where bytes go, so a short one
  // is a small image, not a label.
  const redacted = redactGoogleImageResponseBody({ data: "iVBORw0KGgo=" }, digest);
  assert.equal(redacted.data, `sha256:${digest("iVBORw0KGgo=")} (12 chars)`);
});

test("primitives and nulls pass through unchanged", () => {
  assert.equal(redactGoogleImageResponseBody(null, digest), null);
  assert.equal(redactGoogleImageResponseBody(7, digest), 7);
  assert.deepEqual(redactGoogleImageResponseBody([1, "ok", true], digest), [
    1,
    "ok",
    true,
  ]);
});
