import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bindAmuxOwnerSession, bindAmuxUnitDecisionReason } from
  "../lib/amux/ideaUnitDecisionBindingCore.ts";
import { AMUX_V4_UNIT_REJECT_CODE_LATCH, AMUX_V4_UNIT_REJECT_READ_CODE_LATCH,
  amuxV4UnitRejectWritePermitted, amuxV4UnitRejectReadPermitted,
  amuxUnitRejectErrorBody, amuxUnitRejectErrorStatus,
  amuxUnitRejectNeedsCommitReadback,
  deriveAmuxUnitRejectConfirmation,
  inspectAmuxUnitRejectRequest,
  mayExpireAmuxRejectionConfirmation } from "../lib/amux/ideaUnitRejectCore.ts";

const key = { digestKeyId: "digest_v1", digestKey: Buffer.alloc(32, 11) };
const routeSource = readFileSync(new URL(
  "../app/api/admin/amux/ideas/unit-rejection/route.ts", import.meta.url), "utf8");
const digest = (letter) => ({ digest: letter.repeat(64), keyId: "digest_v1" });
const input = () => ({
  ideaId: "idea_00000001", decisionId: "decision_00001",
  prepareRequestId: "00000000-0000-4000-8000-000000000001",
  actorUserId: "owner_0000001",
  ownerSession: bindAmuxOwnerSession({ actorUserId: "owner_0000001",
    authenticatedAt: "2026-10-03T01:02:03.456Z" }, key),
  draftUnitId: "draft_0000001", localRef: "c0:card-0",
  unitBody: digest("a"),
  proposal: { kind: "card", localId: "c0:card-0", cardType: "story",
    storyKind: "general" },
  previewId: "preview_00001", previewPayload: digest("b"),
  reason: bindAmuxUnitDecisionReason({ ideaId: "idea_00000001",
    draftUnitId: "draft_0000001", decisionId: "decision_00001",
    reason: "이 제안은 사용하지 않음" }, key),
});

test("one rejected unit binds source, session, body and reason without a cost receipt", () => {
  const value = input();
  const result = deriveAmuxUnitRejectConfirmation(value, key);
  assert.equal(result.ok, true);
  assert.match(result.confirmationDigest, /^[a-f0-9]{64}$/);
  for (const changed of [
    { ownerSession: digest("c") }, { unitBody: digest("d") },
    { previewPayload: digest("e") }, { reason: digest("f") },
  ]) {
    const next = deriveAmuxUnitRejectConfirmation({ ...value, ...changed }, key);
    assert.equal(next.ok, true);
    assert.notEqual(next.confirmationDigest, result.confirmationDigest);
  }
});

test("evidence and mismatched proposal refs cannot become a rejection receipt", () => {
  const value = input();
  assert.deepEqual(deriveAmuxUnitRejectConfirmation({ ...value,
    proposal: { kind: "evidence", localId: value.localRef },
  }, key), { ok: false, code: "semantic_conflict" });
  assert.deepEqual(deriveAmuxUnitRejectConfirmation({ ...value,
    proposal: { ...value.proposal, localId: "c0:card-1" },
  }, key), { ok: false, code: "semantic_conflict" });
});

test("the unit rejection writer stays dark despite an enabled environment", () => {
  assert.equal(AMUX_V4_UNIT_REJECT_CODE_LATCH, false);
  assert.equal(amuxV4UnitRejectWritePermitted("enabled"), false);
  assert.equal(amuxV4UnitRejectWritePermitted(undefined), false);
  assert.equal(AMUX_V4_UNIT_REJECT_READ_CODE_LATCH, false);
  assert.equal(amuxV4UnitRejectReadPermitted("enabled"), false);
});

test("reconfirmation is a conflict, not an administrator sign-in challenge", () => {
  assert.equal(amuxUnitRejectErrorStatus("reconfirm"), 409);
  assert.equal(amuxUnitRejectErrorStatus("already_prepared"), 409);
  assert.equal(amuxUnitRejectErrorStatus("not_found"), 404);
  assert.equal(amuxUnitRejectErrorStatus("outcome_unknown"), 503);
  assert.match(routeSource, /amuxUnitRejectErrorStatus\(error\.code\)/);
  assert.match(routeSource, /amuxUnitRejectErrorBody\(error\.code, recovery\)/);
  assert.deepEqual(amuxUnitRejectErrorBody("outcome_unknown", {
    decisionId: "decision-1", prepareRequestId: "prepare-1",
  }), { error: "outcome_unknown", retryWrite: false,
    decisionId: "decision-1", prepareRequestId: "prepare-1" });
  assert.deepEqual(amuxUnitRejectErrorBody("reconfirm"), { error: "reconfirm" });
  assert.match(routeSource,
    /amuxV4UnitRejectReadPermitted\(process\.env\[AMUX_V4_UNIT_REJECT_READ_ENV\]\)/);
});

test("a callback failure is a known rollback, not an uncertain commit", () => {
  assert.equal(amuxUnitRejectNeedsCommitReadback(false), false);
  assert.equal(amuxUnitRejectNeedsCommitReadback(true), true);
});

test("one request admits exactly one owner decision, never a bulk card write", () => {
  const prepare = { stage: "prepare", ideaId: "idea_00000001",
    draftUnitId: "draft_0000001",
    decisionId: "00000000-0000-4000-8000-000000000002",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    reason: "이 단위는 범위 밖" };
  assert.deepEqual(inspectAmuxUnitRejectRequest(JSON.stringify(prepare)), prepare);
  const consume = { ...prepare, stage: "consume",
    consumeRequestId: "00000000-0000-4000-8000-000000000003",
    confirmationDigest: "a".repeat(64) };
  assert.deepEqual(inspectAmuxUnitRejectRequest(JSON.stringify(consume)), consume);
  for (const changed of [
    { cards: ["card-1"] }, { reason: "" }, { reason: "x".repeat(1_001) },
    { reason: " untrimmed" }, { reason: "e\u0301" },
    { reason: "unsafe\u0000text" },
    { decisionId: prepare.prepareRequestId }, { ideaId: "bad,ref" },
  ]) {
    assert.equal(inspectAmuxUnitRejectRequest(JSON.stringify({ ...prepare, ...changed })),
      null);
  }
  for (const changed of [
    { consumeRequestId: prepare.prepareRequestId },
    { consumeRequestId: prepare.decisionId },
    { confirmationDigest: "invalid" },
  ]) {
    assert.equal(inspectAmuxUnitRejectRequest(JSON.stringify({ ...consume, ...changed })),
      null);
  }
  assert.equal(inspectAmuxUnitRejectRequest("not JSON"), null);
});

test("only an expired prepared rejection with no uncertain outcome can be replaced", () => {
  const expiry = new Date("2026-10-03T00:15:00.000Z");
  const now = new Date("2026-10-03T00:15:00.000Z");
  const row = { action: "reject_unit", state: "prepared", expiresAt: expiry,
    outcomeUnknownAt: null, outcomeUnknownResolvedAt: null,
    outcomeUnknownResolution: null };
  assert.equal(mayExpireAmuxRejectionConfirmation(row, now), true);
  assert.equal(mayExpireAmuxRejectionConfirmation(row,
    new Date("2026-10-03T00:14:59.999Z")), false);
  assert.equal(mayExpireAmuxRejectionConfirmation({ ...row,
    outcomeUnknownAt: new Date("2026-10-03T00:10:00.000Z") }, now), false);
  assert.equal(mayExpireAmuxRejectionConfirmation({ ...row,
    outcomeUnknownAt: new Date("2026-10-03T00:10:00.000Z"),
    outcomeUnknownResolvedAt: new Date("2026-10-03T00:12:00.000Z"),
    outcomeUnknownResolution: "no_commit" }, now), false);
  assert.equal(mayExpireAmuxRejectionConfirmation({ ...row,
    action: "register_card" }, now), false);
  assert.equal(mayExpireAmuxRejectionConfirmation({ ...row,
    state: "consumed" }, now), false);
});
