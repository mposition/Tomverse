import assert from "node:assert/strict";
import test from "node:test";

import { checkAmuxIdeaUnitConsume } from "../lib/amux/ideaUnitConsumeGuard.ts";

const digest = (letter) => letter.repeat(64);
const preparedAt = new Date("2026-10-01T01:00:00.000Z");
const expiresAt = new Date("2026-10-01T01:15:00.000Z");
const prepared = () => ({
  id: "decision_00001", ideaId: "idea_00000001",
  draftUnitId: "draft_0000001", actorUserId: "owner_0000001",
  state: "prepared", preparedAt, expiresAt, outcomeUnknownAt: null,
  ownerSessionDigest: digest("a"), ownerSessionDigestKeyId: "session_v1",
  confirmationDigest: digest("b"), confirmationDigestKeyId: "confirmation_v1",
});
const current = () => ({
  decisionId: "decision_00001", ideaId: "idea_00000001",
  draftUnitId: "draft_0000001", actorUserId: "owner_0000001",
  recentOwnerStepUp: true,
  ownerSessionDigest: digest("a"), ownerSessionDigestKeyId: "session_v1",
  databaseNow: new Date("2026-10-01T01:14:59.999Z"),
  currentConfirmation: {
    ok: true, confirmationDigest: digest("b"), digestKeyId: "confirmation_v1", bytes: 900,
  },
});

test("only current same-session, same-owner, unexpired evidence can consume", () => {
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), current()), { decision: "allow" });
  const atExpiry = current();
  atExpiry.databaseNow = expiresAt;
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), atExpiry),
    { decision: "reconfirm", reason: "receipt_expired" });
  const beforePrepare = current();
  beforePrepare.databaseNow = new Date("2026-10-01T00:59:59.999Z");
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), beforePrepare),
    { decision: "halt", reason: "receipt_clock_anomaly" });
});

test("unknown outcome halts even after the receipt deadline", () => {
  const receipt = prepared();
  receipt.outcomeUnknownAt = new Date("2026-10-01T01:03:00.000Z");
  const observed = current();
  observed.databaseNow = new Date("2026-10-02T01:00:00.000Z");
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, observed),
    { decision: "halt", reason: "outcome_unknown" });
  receipt.outcomeUnknownAt = null;
  receipt.state = "consumed";
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, observed),
    { decision: "reject", reason: "not_prepared" });
});

test("identity and session changes reject, step-up and evidence drift require reconfirmation", () => {
  const wrongOwner = current();
  wrongOwner.actorUserId = "another_owner";
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), wrongOwner),
    { decision: "reject", reason: "identity_mismatch" });
  const wrongSession = current();
  wrongSession.ownerSessionDigest = digest("c");
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), wrongSession),
    { decision: "reject", reason: "session_mismatch" });
  const noStepUp = current();
  noStepUp.recentOwnerStepUp = false;
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), noStepUp),
    { decision: "reconfirm", reason: "owner_step_up_required" });
  const changed = current();
  changed.currentConfirmation.confirmationDigest = digest("d");
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), changed),
    { decision: "reconfirm", reason: "confirmation_changed" });
  changed.currentConfirmation = { ok: false, code: "semantic_conflict" };
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), changed),
    { decision: "reconfirm", reason: "evidence_changed" });
});

test("invalid clocks or missing recomputation fail closed", () => {
  const missing = current();
  missing.currentConfirmation = undefined;
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), missing),
    { decision: "reconfirm", reason: "evidence_changed" });
  const badClock = current();
  badClock.databaseNow = new Date("invalid");
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), badClock),
    { decision: "halt", reason: "clock_or_receipt_unavailable" });
  const badReceipt = prepared();
  badReceipt.expiresAt = new Date("2026-10-01T01:16:00.000Z");
  assert.deepEqual(checkAmuxIdeaUnitConsume(badReceipt, current()),
    { decision: "halt", reason: "receipt_clock_anomaly" });
});

test("missing identities and malformed digests never authorize a decision", () => {
  for (const field of ["id", "ideaId", "draftUnitId", "actorUserId",
    "ownerSessionDigestKeyId", "confirmationDigestKeyId"]) {
    const receipt = prepared();
    receipt[field] = "  ";
    assert.equal(checkAmuxIdeaUnitConsume(receipt, current()).decision, "reject", field);
  }
  for (const field of ["decisionId", "ideaId", "draftUnitId", "actorUserId",
    "ownerSessionDigestKeyId"]) {
    const context = current();
    context[field] = undefined;
    assert.equal(checkAmuxIdeaUnitConsume(prepared(), context).decision, "reject", field);
  }
  const receipt = prepared();
  const context = current();
  receipt.id = undefined;
  context.decisionId = undefined;
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, context),
    { decision: "reject", reason: "identity_mismatch" });
  receipt.id = "decision_00001";
  receipt.ownerSessionDigest = "not-a-digest";
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, current()),
    { decision: "reject", reason: "session_mismatch" });
  receipt.ownerSessionDigest = digest("a");
  receipt.confirmationDigest = "not-a-digest";
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, current()),
    { decision: "reconfirm", reason: "confirmation_changed" });
});

test("wrong caller cannot observe receipt state or expiry", () => {
  const receipt = prepared();
  receipt.outcomeUnknownAt = new Date("2026-10-01T01:03:00.000Z");
  receipt.state = "expired";
  const context = current();
  context.actorUserId = "another_owner";
  context.databaseNow = new Date("2026-10-02T01:00:00.000Z");
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, context),
    { decision: "reject", reason: "identity_mismatch" });
  context.actorUserId = "owner_0000001";
  context.ownerSessionDigest = digest("c");
  assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, context),
    { decision: "reject", reason: "session_mismatch" });
});

test("non-prepared states and digest key changes fail closed", () => {
  for (const state of ["cancelled", "invalidated", "expired"]) {
    const receipt = prepared();
    receipt.state = state;
    assert.deepEqual(checkAmuxIdeaUnitConsume(receipt, current()),
      { decision: "reject", reason: "not_prepared" });
  }
  const wrongSessionKey = current();
  wrongSessionKey.ownerSessionDigestKeyId = "other_key";
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), wrongSessionKey),
    { decision: "reject", reason: "session_mismatch" });
  const wrongConfirmationKey = current();
  wrongConfirmationKey.currentConfirmation.digestKeyId = "other_key";
  assert.deepEqual(checkAmuxIdeaUnitConsume(prepared(), wrongConfirmationKey),
    { decision: "reconfirm", reason: "confirmation_changed" });
});
