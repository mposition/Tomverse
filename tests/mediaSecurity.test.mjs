import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPdfTextSafely,
  validatePdfSafely,
} from "../lib/mediaSecurity.ts";
import { createQaPdfBuffer } from "./e2e/support/app-fixtures.ts";

test("extractPdfTextSafely reads text from a PDF using a standard, non-embedded font", async () => {
  const text = await extractPdfTextSafely(createQaPdfBuffer(), 5_000);
  assert.match(text, /QA PDF/);
});

test("validatePdfSafely accepts a PDF using a standard, non-embedded font", async () => {
  await assert.doesNotReject(() => validatePdfSafely(createQaPdfBuffer()));
});

test("extractPdfTextSafely rejects a buffer without a PDF signature", async () => {
  await assert.rejects(() =>
    extractPdfTextSafely(Buffer.from("not a pdf"), 5_000)
  );
});

test("validatePdfSafely rejects a buffer without a PDF signature", async () => {
  await assert.rejects(() => validatePdfSafely(Buffer.from("not a pdf")));
});
