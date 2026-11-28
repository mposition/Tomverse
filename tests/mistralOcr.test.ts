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
    pageNumbers: [1, 2],
    truncatedPage: null,
    truncated: false,
    modelId: MISTRAL_OCR_MODEL_ID,
  });
});

test("OCR 4 reads only the pages it is asked for, counted from 0 on the wire", async () => {
  let body: { pages?: number[] } = {};
  const fetchMock: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ pages: [{ index: 2, markdown: "Scanned" }] });
  };
  const result = await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 1_000, {
    fetch: fetchMock,
    apiKey: "test-key",
    pages: [3],
  });
  assert.deepEqual(body.pages, [2]);
  assert.equal(result?.text, "## Page 3\n\nScanned");
  assert.equal(result?.pageCount, 1);

  await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 1_000, {
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ pages: [] });
    },
    apiKey: "test-key",
  });
  assert.equal("pages" in body, false);
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

test("OCR 4 reports which of the requested pages came back with text", async () => {
  // Pages 2 and 4 were asked for; the provider answers page 2, and page 4 empty.
  const fetchMock: typeof fetch = async () =>
    Response.json({
      pages: [
        { index: 1, markdown: "Second" },
        { index: 3, markdown: "   " },
        { index: 5, markdown: "Not asked for" },
      ],
    });
  const result = await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 1_000, {
    fetch: fetchMock,
    apiKey: "test-key",
    pages: [2, 4],
  });
  assert.equal(result?.text, "## Page 2\n\nSecond");
  assert.deepEqual(result?.pageNumbers, [2]);
  assert.equal(result?.truncated, false);
  // What the provider billed is what it returned, not what was kept.
  assert.equal(result?.pageCount, 3);
});

test("OCR 4 with no page index places each page among the ones asked for", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({ pages: [{ markdown: "A" }, { markdown: "B" }] });
  const result = await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 1_000, {
    fetch: fetchMock,
    apiKey: "test-key",
    pages: [3, 7],
  });
  assert.deepEqual(result?.pageNumbers, [3, 7]);
});

test("OCR 4 says when the text was cut, which page it cut, and counts only whole pages as read", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({
      pages: [
        { index: 0, markdown: "a".repeat(30) },
        { index: 1, markdown: "b".repeat(30) },
        { index: 2, markdown: "c".repeat(30) },
      ],
    });
  const result = await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 60, {
    fetch: fetchMock,
    apiKey: "test-key",
  });
  assert.equal(result?.truncated, true);
  assert.equal(result?.text.length <= 60, true);
  // Page 1 is whole; page 2 is cut in the middle and page 3 never reached.
  assert.deepEqual(result?.pageNumbers, [1]);
  assert.equal(result?.truncatedPage, 2);
  const whole = await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 10_000, {
    fetch: fetchMock,
    apiKey: "test-key",
  });
  assert.equal(whole?.truncated, false);
  assert.deepEqual(whole?.pageNumbers, [1, 2, 3]);
  assert.equal(whole?.truncatedPage, null);
});

test("OCR 4 gives no text for a document of empty pages", async () => {
  const fetchMock: typeof fetch = async () => Response.json({ pages: [{ index: 0, markdown: "" }] });
  const result = await extractPdfTextWithMistralOcr(Buffer.from("%PDF"), 100, {
    fetch: fetchMock,
    apiKey: "test-key",
  });
  assert.equal(result?.text, "");
  assert.deepEqual(result?.pageNumbers, []);
});
