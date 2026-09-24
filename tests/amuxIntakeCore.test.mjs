import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_INTAKE_APPLY_CODE_LATCH,
  amuxIntakeApplyPermitted,
  amuxIntakeDraftDigest,
  amuxIntakeSourceKey,
  guardAmuxIntake,
  parseAmuxIntakeDraft,
} from "../lib/amux/intakeCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const secret = "intake-hmac-secret-at-least-32-bytes";
const taskId = "codex-turn-explicit-1";
const workDigest = "ab".repeat(32);

const draft = (overrides = {}) => ({
  canonicalizationVersion: "amux-json-v1",
  policyVersion: 1,
  explicitRegistration: true,
  sourceTaskId: taskId,
  workItem: { id: "AMUX-INTAKE-01", version: "v1", digest: workDigest },
  proposal: {
    title: "Register one intake unit",
    scope: "Owner confirms a single backlog card",
    completion: "The card stays backlog",
    priority: "p2",
  },
  ...overrides,
});

const body = (value) => JSON.stringify(value);

test("the code latch ships false and one latch is not enough", () => {
  assert.equal(AMUX_INTAKE_APPLY_CODE_LATCH, false);
  assert.equal(amuxIntakeApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(amuxIntakeApplyPermitted({ envValue: "enabled", codeLatch: AMUX_INTAKE_APPLY_CODE_LATCH }), false);
  assert.equal(amuxIntakeApplyPermitted({ envValue: "true", codeLatch: true }), false);
  assert.equal(amuxIntakeApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
});

test("a conversation that is not an explicit registration produces no card", () => {
  const guarded = guardAmuxIntake(body(draft({ explicitRegistration: false })));
  assert.equal(guarded.outcome, "reject");
  assert.equal(guarded.code, "implicit_registration");
  assert.equal(guarded.card, null);
});

test("more than one completion unit is rejected", () => {
  const guarded = guardAmuxIntake(body({ ...draft(), proposals: [draft().proposal, draft().proposal] }));
  assert.equal(guarded.outcome, "reject");
  assert.equal(guarded.code, "multiple_units");
  assert.equal(guarded.card, null);
});

test("a valid draft waits for confirmation and does not write a card", () => {
  const guarded = guardAmuxIntake(body(draft()));
  assert.equal(guarded.outcome, "approval_required");
  assert.equal(guarded.card, null);
  assert.match(guarded.draftDigest, /^[a-f0-9]{64}$/);
  const parsed = parseAmuxIntakeDraft(body(draft()));
  assert.equal(parsed.ok, true);
  assert.equal(JSON.stringify(amuxIntakeDraftDigest(parsed.draft)).includes(taskId), false);
  assert.equal(guarded.draftDigest.includes(taskId), false);
});

test("confirmation allows one backlog card and does not keep the task id", () => {
  const parsed = parseAmuxIntakeDraft(body(draft()));
  assert.equal(parsed.ok, true);
  const digest = amuxIntakeDraftDigest(parsed.draft);
  const guarded = guardAmuxIntake(body(draft({ confirmationDigest: digest })));
  assert.equal(guarded.outcome, "allow");
  assert.equal(guarded.card.status, "backlog");
  assert.equal(guarded.card.kind, "unknown");
  assert.equal(guarded.card.owner, null);
  assert.equal(guarded.card.claimedAt, null);
  assert.equal(guarded.card.executionBrief, null);
  assert.equal(guarded.card.sourceSystem, "codex-conversation");
  assert.equal(JSON.stringify(guarded.card).includes(taskId), false);
});

test("a different digest is a conflict and a wrong confirmation is a mismatch", () => {
  const parsed = parseAmuxIntakeDraft(body(draft()));
  const digest = amuxIntakeDraftDigest(parsed.draft);
  const mismatch = guardAmuxIntake(body(draft({ confirmationDigest: "c".repeat(64) })));
  assert.equal(mismatch.outcome, "reject");
  assert.equal(mismatch.code, "digest_mismatch");
  const conflict = guardAmuxIntake(body(draft({ confirmationDigest: digest })), "d".repeat(64));
  assert.equal(conflict.outcome, "reject");
  assert.equal(conflict.code, "conflict");
  assert.equal(conflict.card, null);
});

test("a task id that contains sk- still parses when it is not stored", () => {
  const guarded = guardAmuxIntake(body(draft({ sourceTaskId: "codex-task-explicit-1" })));
  assert.equal(guarded.outcome, "approval_required");
  assert.equal(guarded.card, null);
  assert.equal(JSON.stringify(guarded).includes("codex-task-explicit-1"), false);
});

test("paths, urls, and an echoed task id are refused", () => {
  const slash = guardAmuxIntake(body(draft({
    proposal: { ...draft().proposal, scope: "lib/amux/intakeCore.ts" },
  })));
  assert.equal(slash.outcome, "reject");
  assert.equal(slash.code, "content_refused");
  const echoed = guardAmuxIntake(body(draft({
    proposal: { ...draft().proposal, title: taskId },
  })));
  assert.equal(echoed.outcome, "reject");
  assert.equal(echoed.code, "source_id_echo");
});

test("the source key is an hmac and a short secret produces none", () => {
  const key = amuxIntakeSourceKey(secret, taskId);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, taskId);
  assert.equal(amuxIntakeSourceKey(secret, taskId), key);
  assert.notEqual(amuxIntakeSourceKey(`${secret}-other-extra`, taskId), key);
  assert.equal(amuxIntakeSourceKey("short", taskId), null);
});

test("the pure module does not open a writer", () => {
  const source = read("lib/amux/intakeCore.ts");
  assert.equal(source.includes("AMUX_INTAKE_APPLY_CODE_LATCH = false"), true);
  assert.equal(source.includes("@prisma/client"), false);
  assert.equal(source.includes("lib/credit"), false);
  assert.equal(source.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(source.includes("codeLatch: true"), false);
});
