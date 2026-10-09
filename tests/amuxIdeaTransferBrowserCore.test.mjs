import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  ideaTransferBrowserCookieName, ideaTransferBrowserDigest,
  matchesIdeaTransferBrowserDigest, newIdeaTransferBrowserNonce,
} from "../lib/amux/ideaTransferBrowserCore.ts";

const previewId = "123e4567-e89b-42d3-a456-426614174001";
const otherPreviewId = "123e4567-e89b-42d3-a456-426614174002";
const authenticatedAt = "2026-10-02T00:00:00.000Z";
const key = { digestKeyId: "synthetic", digestKey: randomBytes(32) };

test("a preview gets one bounded browser cookie and keyed session proof", () => {
  const nonce = newIdeaTransferBrowserNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ideaTransferBrowserCookieName(previewId), `amux-v4-preview-${previewId}`);
  const input = { previewId, nonce, authenticatedAt, key };
  const digest = ideaTransferBrowserDigest(input);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest.includes(nonce), false);
  assert.equal(matchesIdeaTransferBrowserDigest(digest, input), true);
  for (const changed of [
    { previewId: otherPreviewId },
    { nonce: newIdeaTransferBrowserNonce() },
    { authenticatedAt: "2026-10-02T00:00:01.000Z" },
    { key: { ...key, digestKey: randomBytes(32) } },
  ]) assert.equal(matchesIdeaTransferBrowserDigest(digest, { ...input, ...changed }), false);
});

test("malformed proof inputs fail closed", () => {
  const input = { previewId, nonce: newIdeaTransferBrowserNonce(), authenticatedAt, key };
  assert.equal(matchesIdeaTransferBrowserDigest("bad", input), false);
  assert.equal(matchesIdeaTransferBrowserDigest("a".repeat(64), { ...input, nonce: "bad" }), false);
  assert.throws(() => ideaTransferBrowserCookieName("../other"));
  assert.throws(() => ideaTransferBrowserDigest({ ...input, authenticatedAt: undefined }));
  assert.throws(() => ideaTransferBrowserDigest({ ...input, nonce: "bad" }));
});
