import assert from "node:assert/strict";
import test from "node:test";

import { checkAmuxIdeaTransferReceipt } from "../lib/amux/ideaTransferReceiptCore.ts";

const digest = (letter) => letter.repeat(64);
const confirmedAt = new Date("2026-10-01T01:00:00.000Z");
const expiresAt = new Date("2026-10-01T01:15:00.000Z");
const receipt = () => ({
  id: "preview_00000001", ideaId: "idea_00000001", sourceScopeApprovalId: "scope_00000001",
  chunkIndex: 0, attempt: 1, state: "confirmed", modelId: "openai/frontier-approved",
  payloadDigest: digest("a"), payloadDigestKeyId: "payload_v1", expiresAt,
  confirmedAt, confirmExpiresAt: expiresAt, confirmedByUserId: "owner_0000001",
  confirmationAuditLogId: "audit_00000001", consumedAt: null,
  outcomeUnknownAt: null, payloadPurgedAt: null,
});
const current = () => ({
  previewId: "preview_00000001", ideaId: "idea_00000001",
  sourceScopeApprovalId: "scope_00000001", chunkIndex: 0, attempt: 1,
  actorUserId: "owner_0000001", modelId: "openai/frontier-approved",
  payloadDigest: digest("a"), payloadDigestKeyId: "payload_v1",
  databaseNow: new Date("2026-10-01T01:14:59.999Z"),
});

test("only an exact, unexpired and unconsumed confirmed receipt is current", () => {
  assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), current()),
    { decision: "receipt_current" });
  const atExpiry = current();
  atExpiry.databaseNow = expiresAt;
  assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), atExpiry),
    { decision: "reconfirm", reason: "receipt_expired" });
  const consumed = receipt();
  consumed.state = "in_flight";
  consumed.consumedAt = new Date("2026-10-01T01:05:00.000Z");
  assert.deepEqual(checkAmuxIdeaTransferReceipt(consumed, current()),
    { decision: "reject", reason: "receipt_not_claimable" });
});

test("unknown outcome halts even after deadline and may not be re-claimed", () => {
  const unknown = receipt();
  unknown.state = "outcome_unknown";
  unknown.outcomeUnknownAt = new Date("2026-10-01T01:05:00.000Z");
  const later = current();
  later.databaseNow = new Date("2026-10-02T01:00:00.000Z");
  assert.deepEqual(checkAmuxIdeaTransferReceipt(unknown, later),
    { decision: "halt", reason: "outcome_unknown" });
  unknown.state = "confirmed";
  assert.deepEqual(checkAmuxIdeaTransferReceipt(unknown, current()),
    { decision: "halt", reason: "outcome_unknown" });
});

test("changed owner, source scope, model or payload never reuse approval", () => {
  const changedOwner = current();
  changedOwner.actorUserId = "other_owner";
  assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), changedOwner),
    { decision: "reject", reason: "identity_mismatch" });
  for (const change of [
    { sourceScopeApprovalId: "scope_00000002" },
    { modelId: "anthropic/other-model" },
    { payloadDigest: digest("b") },
    { payloadDigestKeyId: "payload_v2" },
  ]) {
    assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), { ...current(), ...change }),
      { decision: "reconfirm", reason: "preview_changed" });
  }
});

test("every preview identity field is bound to the confirmed row", () => {
  for (const change of [
    { previewId: "preview_00000002" },
    { ideaId: "idea_00000002" },
    { chunkIndex: 1 },
    { attempt: 2 },
  ]) {
    assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), { ...current(), ...change }),
      { decision: "reject", reason: "identity_mismatch" });
  }
  const ideaOnly = receipt();
  ideaOnly.sourceScopeApprovalId = null;
  assert.deepEqual(checkAmuxIdeaTransferReceipt(ideaOnly,
    { ...current(), sourceScopeApprovalId: null }), { decision: "receipt_current" });
  assert.deepEqual(checkAmuxIdeaTransferReceipt(ideaOnly, current()),
    { decision: "reconfirm", reason: "preview_changed" });
});

test("confirmation expiry is independent of the preview expiry", () => {
  const shortConfirmation = receipt();
  shortConfirmation.confirmExpiresAt = new Date("2026-10-01T01:10:00.000Z");
  assert.deepEqual(checkAmuxIdeaTransferReceipt(shortConfirmation, current()),
    { decision: "reconfirm", reason: "receipt_expired" });
  const early = current();
  early.databaseNow = new Date("2026-10-01T00:59:59.999Z");
  assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), early),
    { decision: "halt", reason: "receipt_clock_anomaly" });
  const inverted = receipt();
  inverted.confirmExpiresAt = confirmedAt;
  assert.deepEqual(checkAmuxIdeaTransferReceipt(inverted, current()),
    { decision: "halt", reason: "receipt_clock_anomaly" });
});

test("non-confirmed states and malformed positions or digests fail closed", () => {
  for (const state of ["prepared", "completed", "owner_rejected", "provider_failed", "expired"]) {
    assert.deepEqual(checkAmuxIdeaTransferReceipt({ ...receipt(), state }, current()),
      { decision: "reject", reason: "receipt_not_claimable" });
  }
  for (const change of [
    { chunkIndex: -1 }, { attempt: 0 },
    { payloadDigest: digest("A") }, { payloadDigest: "a".repeat(63) },
  ]) {
    assert.deepEqual(checkAmuxIdeaTransferReceipt({ ...receipt(), ...change }, current()),
      { decision: "halt", reason: "receipt_malformed" });
  }
});

test("missing audit, purge and invalid clocks fail closed", () => {
  const noAudit = receipt();
  noAudit.confirmationAuditLogId = null;
  assert.deepEqual(checkAmuxIdeaTransferReceipt(noAudit, current()),
    { decision: "halt", reason: "receipt_malformed" });
  const purged = receipt();
  purged.payloadPurgedAt = confirmedAt;
  assert.deepEqual(checkAmuxIdeaTransferReceipt(purged, current()),
    { decision: "halt", reason: "payload_unavailable" });
  const badClock = current();
  badClock.databaseNow = new Date("invalid");
  assert.deepEqual(checkAmuxIdeaTransferReceipt(receipt(), badClock),
    { decision: "halt", reason: "receipt_or_clock_unavailable" });
  const future = receipt();
  future.confirmExpiresAt = new Date("2026-10-01T01:16:00.000Z");
  assert.deepEqual(checkAmuxIdeaTransferReceipt(future, current()),
    { decision: "halt", reason: "receipt_clock_anomaly" });
});
