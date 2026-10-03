import assert from "node:assert/strict";
import test from "node:test";

import {
  bindAmuxOwnerSession,
  bindAmuxUnitDecisionReason,
  sameAmuxUnitDecisionBinding,
} from "../lib/amux/ideaUnitDecisionBindingCore.ts";

const key = { digestKeyId: "digest_v1", digestKey: Buffer.alloc(32, 9) };
const session = { actorUserId: "owner_0000001",
  authenticatedAt: "2026-10-03T01:02:03.456Z" };
const decision = { ideaId: "idea_00000001", draftUnitId: "unit_00000001",
  decisionId: "decision_00001", reason: "중복 제안이라 등록하지 않음" };

test("one owner sign-in has a stable keyed binding, while a new sign-in does not", () => {
  const first = bindAmuxOwnerSession(session, key);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.keyId, key.digestKeyId);
  assert.equal(sameAmuxUnitDecisionBinding(first, bindAmuxOwnerSession(session, key)), true);
  assert.equal(sameAmuxUnitDecisionBinding(first, bindAmuxOwnerSession({
    ...session, authenticatedAt: "2026-10-03T01:02:04.456Z",
  }, key)), false);
  assert.equal(sameAmuxUnitDecisionBinding(first, bindAmuxOwnerSession({
    ...session, actorUserId: "other_owner",
  }, key)), false);
});

test("a reason commitment cannot be replayed for a different unit or decision", () => {
  const first = bindAmuxUnitDecisionReason(decision, key);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.keyId, key.digestKeyId);
  assert.equal(first.digest.includes(decision.reason), false);
  assert.equal(sameAmuxUnitDecisionBinding(first,
    bindAmuxUnitDecisionReason(decision, key)), true);
  for (const changed of [
    { draftUnitId: "unit_00000002" }, { decisionId: "decision_00002" },
    { ideaId: "idea_00000002" }, { reason: "다른 사유" },
  ]) {
    assert.equal(sameAmuxUnitDecisionBinding(first,
      bindAmuxUnitDecisionReason({ ...decision, ...changed }, key)), false);
  }
});

test("malformed sessions, unsafe reasons and key drift fail closed", () => {
  assert.equal(bindAmuxOwnerSession({ ...session, authenticatedAt: "invalid" }, key), null);
  assert.equal(bindAmuxOwnerSession({ ...session, actorUserId: "owner\u202e" }, key), null);
  assert.equal(bindAmuxOwnerSession(session, { ...key, digestKey: Buffer.alloc(8) }), null);
  for (const reason of ["", " reason", "reason ", "unsafe\u202etext", "x".repeat(1_001)]) {
    assert.equal(bindAmuxUnitDecisionReason({ ...decision, reason }, key), null, reason.slice(0, 20));
  }
  const first = bindAmuxUnitDecisionReason(decision, key);
  assert.equal(sameAmuxUnitDecisionBinding(first,
    bindAmuxUnitDecisionReason(decision, { ...key, digestKeyId: "digest_v2" })), false);
  assert.equal(sameAmuxUnitDecisionBinding(first, null), false);
  assert.equal(sameAmuxUnitDecisionBinding({ digest: "invalid", keyId: "digest_v1" }, first), false);
});
