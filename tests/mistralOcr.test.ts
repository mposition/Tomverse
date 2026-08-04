import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPdfTextWithMistralOcr,
  MISTRAL_OCR_ENDPOINT,
  MISTRAL_OCR_MODEL_ID,
  MistralOcrError,
} from "../lib/mistralOcr";

test("OCR 4 sends a bounded text-only document request", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({
      pages: [
        { index: 0, markdown: "# First" },
        { index: 1, markdown: "Second page" },
      ],
    });
  };

  const result = await extractPdfTextWithMistralOcr(
    Buffer.from("%PDF-1.7 test"),
    1_000,
    { fetch: fetchMock, apiKey: "test-key", signal: new AbortController().signal }
  );

  assert.equal(capturedUrl, MISTRAL_OCR_ENDPOINT);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>).Authorization,
    "Bearer test-key"
  );
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, MISTRAL_OCR_MODEL_ID);
  assert.equal(body.include_blocks, false);
  assert.equal(body.include_image_base64, false);
  assert.equal(body.table_format, "markdown");
  assert.match(body.document.document_url, /^data:application\/pdf;base64,/);
  assert.deepEqual(result, {
    text: "## Page 1\n\n# First\n\n## Page 2\n\nSecond page",
    pageCount: 2,
    modelId: MISTRAL_OCR_MODEL_ID,
  });
});

test("OCR 4 is optional when no Mistral key is configured", async () => {
  const original = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  try {
    assert.equal(
      await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 100),
      null
    );
  } finally {
    if (original === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = original;
  }
});

test("OCR 4 rejects provider errors without retaining their body", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response('{"secret":"do not surface"}', { status: 429 });

  await assert.rejects(
    extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 100, {
      fetch: fetchMock,
      apiKey: "test-key",
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MistralOcrError);
      assert.equal(error.statusCode, 429);
      assert.doesNotMatch(error.message, /secret|do not surface/);
      return true;
    }
  );
});
