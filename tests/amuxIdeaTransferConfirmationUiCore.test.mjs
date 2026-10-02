import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { clearRefusedConfirmationAttempt, definitiveConfirmationPrewriteRefusal,
  readConfirmedIdeaTransfer, readConfirmationAttempt, readConfirmationAttemptForPreview,
  readConfirmationWriteReply, readExpiredIdeaTransferConfirmation,
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

test("only named pre-write confirmation refusals release the attempt fence", async () => {
  for (const [status, body] of [
    [400, { error: "schema_rejected" }],
    [403, { error: "Forbidden." }],
    [404, { error: "not_found" }],
    [409, { error: "not_ready" }],
    [409, { error: "expired" }],
    [409, { error: "digest_changed" }],
    [409, { error: "browser_mismatch" }],
    [413, { code: "REQUEST_BODY_TOO_LARGE" }],
    [415, { error: "content_type_refused" }],
    [428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" }],
    [429, { code: "API_RATE_LIMITED" }],
    [503, { error: "confirmation_disabled" }],
  ]) assert.equal(definitiveConfirmationPrewriteRefusal(status, body), true);
  for (const [status, body] of [
    [409, { error: "outcome_unknown" }],
    [503, { error: "confirmation_unavailable" }],
    [404, null],
    [409, { error: "future_postwrite_error" }],
  ]) assert.equal(definitiveConfirmationPrewriteRefusal(status, body), false);

  const reply = await readConfirmationWriteReply(new Response(
    JSON.stringify({ error: "expired" }), { status: 409 }));
  assert.equal(reply.definitiveRefusal, true);
  assert.deepEqual(await reply.refusalResponse.json(), reply.body);
});

test("expired read-back distinguishes an unconfirmed preview from a recorded confirmation", () => {
  const base = { state: "expired", previewId, ideaId, modelCallStarted: false };
  assert.equal(readExpiredIdeaTransferConfirmation(200,
    { ...base, confirmationRecorded: false }, previewId, ideaId), "unconfirmed");
  assert.equal(readExpiredIdeaTransferConfirmation(200,
    { ...base, confirmationRecorded: true }, previewId, ideaId), "confirmed");
  assert.equal(readExpiredIdeaTransferConfirmation(200,
    { ...base, confirmationRecorded: true }, previewId, "other-idea"), null);
  assert.equal(readExpiredIdeaTransferConfirmation(200,
    { ...base, confirmationRecorded: "true" }, previewId, ideaId), null);
  const panel = readFileSync(new URL("../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /observed !== "not_confirmed" &&\s*observed !== "expired_unconfirmed"\) return;/,
    "an expired confirmed decision must retain its same-tab attempt fence");
});
