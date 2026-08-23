import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_EXPANSION_ESTIMATE,
  EXTRACTED_ATTACHMENT_ESTIMATED_TOKEN_CAP,
  estimateNativeAttachmentTokens,
  estimatePreflightAttachmentTokens,
} from "../lib/chatAttachmentTokens.ts";

const model = (nativePdf) => ({
  id: nativePdf ? "native-pdf" : "extracted-pdf",
  name: "Test model",
  apiModel: "test-model",
  provider: "openai",
  icon: "test",
  bestFor: "test",
  minimumPlan: "Free",
  usageClass: "standard",
  enabled: true,
  status: "enabled",
  inputCapabilities: {
    image: true,
    nativePdf,
  },
});

test("native images and PDFs use the same 16k estimate as the chat request", () => {
  const tokens = estimatePreflightAttachmentTokens(model(true), [
    { mediaType: "image/png", size: 9_000_000 },
    { mediaType: "application/pdf", size: 10_000_000 },
  ]);

  assert.equal(tokens, estimateNativeAttachmentTokens(2));
  assert.equal(tokens, 32_000);
});

test("documents requiring text extraction retain the bounded size estimate", () => {
  assert.equal(
    estimatePreflightAttachmentTokens(model(false), [
      { mediaType: "application/pdf", size: 10_000_000 },
    ]),
    75_000
  );
});

test("native and extracted attachments are estimated independently", () => {
  assert.equal(
    estimatePreflightAttachmentTokens(model(false), [
      { mediaType: "image/jpeg", size: 4_000_000 },
      { mediaType: "text/plain", size: 4_000 },
    ]),
    17_000
  );
});

test("an archive is estimated at what it expands to, not at what it weighs", () => {
  // A ZIP's readable contents are the point of it: estimating one at its
  // compressed size tells the router a 200KB upload is a small turn.
  const target = model(false);
  const zip = estimatePreflightAttachmentTokens(target, [
    { mediaType: "application/zip", size: 40_000 },
  ]);
  const text = estimatePreflightAttachmentTokens(target, [
    { mediaType: "text/plain", size: 40_000 },
  ]);
  assert.equal(zip, text * ARCHIVE_EXPANSION_ESTIMATE);
  // Still bounded by the shared cap rather than growing without limit.
  assert.equal(
    estimatePreflightAttachmentTokens(target, [
      { mediaType: "application/zip", size: 10 * 1024 * 1024 },
    ]),
    EXTRACTED_ATTACHMENT_ESTIMATED_TOKEN_CAP
  );
});
