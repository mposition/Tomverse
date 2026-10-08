import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectIdeaTransferConfirmationRequest, transferConfirmReadPermitted,
  transferConfirmWritePermitted,
} from "../lib/amux/ideaTransferConfirmationCore.ts";
import { readIdeaTransferBrowserNonce } from "../lib/amux/ideaTransferBrowserCore.ts";

const previewId = "123e4567-e89b-42d3-a456-426614174001";
const ideaId = "123e4567-e89b-42d3-a456-426614174002";
const valid = { version: 1, previewId, ideaId,
  payloadDigest: "a".repeat(64), payloadDigestKeyId: "synthetic-key" };

test("transfer confirmation accepts only one exact reviewed digest", () => {
  assert.deepEqual(inspectIdeaTransferConfirmationRequest(JSON.stringify(valid)), {
    ok: true, request: { previewId, ideaId,
      payloadDigest: "a".repeat(64), payloadDigestKeyId: "synthetic-key" },
  });
  for (const changed of [
    { payloadDigest: "bad" }, { ideaId: "other" }, { extra: true }, { version: 2 },
  ]) assert.deepEqual(inspectIdeaTransferConfirmationRequest(JSON.stringify({ ...valid, ...changed })),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectIdeaTransferConfirmationRequest("{"),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectIdeaTransferConfirmationRequest("x".repeat(513)),
    { ok: false, code: "too_large" });
  assert.equal(transferConfirmWritePermitted(undefined), false);
  assert.equal(transferConfirmReadPermitted(undefined), false);
  assert.equal(transferConfirmWritePermitted("enabled"), true);
  assert.equal(transferConfirmReadPermitted("enabled"), true);
});

test("same-preview browser receipt is unique and cannot be taken from another cookie", () => {
  const name = `amux-v4-preview-${previewId}`;
  const nonce = "A".repeat(43);
  assert.equal(readIdeaTransferBrowserNonce(`${name}=${nonce}`, previewId), nonce);
  assert.equal(readIdeaTransferBrowserNonce(`${name}=${nonce}; ${name}=${nonce}`, previewId), null);
  assert.equal(readIdeaTransferBrowserNonce(`${name}=bad`, previewId), null);
  assert.equal(readIdeaTransferBrowserNonce(`other=${nonce}`, previewId), null);
  assert.equal(readIdeaTransferBrowserNonce(null, previewId), null);
});
