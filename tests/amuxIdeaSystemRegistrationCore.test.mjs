import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V19_SYSTEM_REGISTRATION_CODE_ENABLED,
  AMUX_V19_SYSTEM_REGISTRATION_ENV,
  AMUX_V19_UNIT_REGISTRATION_AUTHORITY,
  amuxV19SystemRegistrationEnabled,
  deriveAmuxV19RegistrationRefusalRequestId,
  deriveAmuxV19SystemRegistrationBinding,
  isAmuxV19UnitRegistrationAuthority,
  matchesAmuxV19SystemRegistrationBinding,
} from "../lib/amux/ideaSystemRegistrationCore.ts";

const key = { digestKeyId: "amux-digest-v1",
  digestKey: Buffer.alloc(32, 7) };

test("system registration remains code-latched off when every env switch is enabled", () => {
  const env = {
    [AMUX_V19_SYSTEM_REGISTRATION_ENV]: "enabled",
    TOMVERSE_AMUX_SESSION_INTAKE: "enabled",
    TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ: "enabled",
    TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ: "enabled",
    TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE: "enabled",
    TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE: "enabled",
    TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ: "enabled",
    TOMVERSE_AMUX_V4_UNIT_WRITE: "enabled",
    TOMVERSE_AMUX_V4_PORTFOLIO_WRITE: "enabled",
  };
  assert.equal(AMUX_V19_SYSTEM_REGISTRATION_CODE_ENABLED, false);
  assert.equal(amuxV19SystemRegistrationEnabled(env), false);
});

test("system authorization binding is keyed, deterministic and identity-bound", () => {
  const input = { ideaId: "idea_00000001", decisionId: "decision_00001",
    actorUserId: "owner_0000001", key };
  const first = deriveAmuxV19SystemRegistrationBinding(input);
  assert.deepEqual(first, deriveAmuxV19SystemRegistrationBinding(input));
  assert.equal(matchesAmuxV19SystemRegistrationBinding(first, input), true);
  assert.equal(matchesAmuxV19SystemRegistrationBinding(first,
    { ...input, decisionId: "decision_00002" }), false);
  assert.equal(matchesAmuxV19SystemRegistrationBinding(
    { ...first, digest: "0".repeat(64) }, input), false);
});

test("system registration authority accepts only the exact closed marker", () => {
  assert.equal(isAmuxV19UnitRegistrationAuthority(
    AMUX_V19_UNIT_REGISTRATION_AUTHORITY), true);
  assert.equal(isAmuxV19UnitRegistrationAuthority({
    ...AMUX_V19_UNIT_REGISTRATION_AUTHORITY, extra: true }), false);
  assert.equal(isAmuxV19UnitRegistrationAuthority({
    ...AMUX_V19_UNIT_REGISTRATION_AUTHORITY, systemActor: "owner" }), false);
});

test("durable refusal request ids are deterministic UUIDs and bind the closed code", () => {
  const input = { ideaId: "idea_00000001", draftUnitId: "draft_0000001",
    analysisPreviewId: "preview_000001", refusalCode: "plan_dependency_cycle",
    key };
  const requestId = deriveAmuxV19RegistrationRefusalRequestId(input);
  assert.match(requestId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(deriveAmuxV19RegistrationRefusalRequestId(input), requestId);
  assert.notEqual(deriveAmuxV19RegistrationRefusalRequestId({ ...input,
    refusalCode: "plan_score_invalid" }), requestId);
});
