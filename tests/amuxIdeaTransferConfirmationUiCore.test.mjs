import assert from "node:assert/strict";
import test from "node:test";

import { clearRefusedConfirmationAttempt, readConfirmedIdeaTransfer, readConfirmationAttempt,
  readConfirmationAttemptForPreview,
  reserveConfirmationAttempt } from "../lib/amux/ideaTransferConfirmationUiCore.ts";

const previewId = "123e4567-e89b-42d3-a456-426614174001";
const ideaId = "123e4567-e89b-42d3-a456-426614174002";
const digest = "a".repeat(64);
const digestKeyId = "synthetic-key";
const valid = { state: "confirmed", previewId, ideaId,
  payloadDigest: digest, payloadDigestKeyId: digestKeyId,
  confirmExpiresAt: new Date(Date.now() + 60_000).toISOString(), modelCallStarted: false };

test("confirmation UI accepts only the same server-confirmed no-model-call receipt", () => {
  assert.deepEqual(readConfirmedIdeaTransfer(201, valid,
    previewId, ideaId, digest, digestKeyId), {
    previewId, ideaId, payloadDigest: digest,
    payloadDigestKeyId: digestKeyId, confirmExpiresAt: valid.confirmExpiresAt,
  });
  for (const invalid of [
    { ...valid, previewId: "123e4567-e89b-42d3-a456-426614174002" },
    { ...valid, ideaId: previewId },
    { ...valid, payloadDigest: "b".repeat(64) },
    { ...valid, payloadDigestKeyId: "other-key" },
    { ...valid, modelCallStarted: true },
    { ...valid, confirmExpiresAt: "not-an-instant" },
    { ...valid, state: "not_confirmed" },
  ]) assert.equal(readConfirmedIdeaTransfer(200, invalid,
    previewId, ideaId, digest, digestKeyId), null);
  assert.equal(readConfirmedIdeaTransfer(503, valid,
    previewId, ideaId, digest, digestKeyId), null);
});

test("a same-tab confirmation attempt survives refresh and blocks a second client POST", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); } };
  assert.equal(readConfirmationAttempt(storage, "owner", previewId, ideaId,
    digest, digestKeyId), "absent");
  assert.equal(reserveConfirmationAttempt(storage, "owner", previewId, ideaId,
    digest, digestKeyId), true);
  assert.deepEqual(readConfirmationAttemptForPreview(storage, "owner", previewId, ideaId),
    { kind: "present", payloadDigest: digest, payloadDigestKeyId: digestKeyId });
  assert.equal(readConfirmationAttempt(storage, "owner", previewId, ideaId,
    digest, digestKeyId), "present");
  assert.equal(reserveConfirmationAttempt(storage, "owner", previewId, ideaId,
    digest, digestKeyId), false);
  assert.equal(readConfirmationAttempt(storage, "owner", previewId, ideaId,
    "b".repeat(64), digestKeyId),
    "unavailable");
  assert.equal(readConfirmationAttempt(null, "owner", previewId, ideaId,
    digest, digestKeyId),
    "unavailable");
  assert.equal(clearRefusedConfirmationAttempt(storage, "owner", previewId, ideaId,
    "b".repeat(64), digestKeyId), false);
  assert.equal(clearRefusedConfirmationAttempt(storage, "owner", previewId, ideaId,
    digest, digestKeyId), true);
  assert.equal(readConfirmationAttempt(storage, "owner", previewId, ideaId,
    digest, digestKeyId), "absent");
});
