import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_V19_SYSTEM_REGISTRATION_CODE_ENABLED,
  AMUX_V19_SYSTEM_REGISTRATION_ENV,
  AMUX_V19_UNIT_REGISTRATION_AUTHORITY,
  amuxV19SystemRegistrationEnabled,
  amuxV19SystemRegistrationTestBoundary,
  deriveAmuxV19RegistrationRefusalRequestId,
  deriveAmuxV19SystemRegistrationBinding,
  isAmuxV19UnitRegistrationAuthority,
  matchesAmuxV19SystemRegistrationBinding,
} from "../lib/amux/ideaSystemRegistrationCore.ts";

const key = { digestKeyId: "amux-digest-v1",
  digestKey: Buffer.alloc(32, 7) };

const serviceSource = readFileSync(
  new URL("../lib/amux/ideaSystemRegistrationService.ts", import.meta.url),
  "utf8",
);

test("system registration needs the open code latch and every env switch, the dedicated one included", () => {
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
  // Owner approval in chat, 2026-10-21: the code latch is open; environments
  // still decide with their switches (production has none set).
  assert.equal(AMUX_V19_SYSTEM_REGISTRATION_CODE_ENABLED, true);
  assert.equal(amuxV19SystemRegistrationEnabled(env), true);
  for (const name of Object.keys(env)) {
    const missing = { ...env };
    delete missing[name];
    assert.equal(amuxV19SystemRegistrationEnabled(missing), false, name);
    assert.equal(amuxV19SystemRegistrationEnabled({ ...env, [name]: "true" }), false, name);
  }
  assert.equal(amuxV19SystemRegistrationEnabled({}), false);
});

test("the ungated system registration primitive accepts only an isolated local test DB", () => {
  const testUrl = "postgresql://postgres@127.0.0.1:55467/tomverse_test";
  assert.equal(amuxV19SystemRegistrationTestBoundary({ NODE_ENV: "test",
    TEST_DATABASE_URL: testUrl, DATABASE_URL: testUrl,
    DIRECT_DATABASE_URL: testUrl }), true);
  assert.equal(amuxV19SystemRegistrationTestBoundary({ NODE_ENV: "production",
    TEST_DATABASE_URL: testUrl, DATABASE_URL: testUrl }), false);
  assert.equal(amuxV19SystemRegistrationTestBoundary({ NODE_ENV: "test",
    TEST_DATABASE_URL: testUrl,
    DATABASE_URL: "postgresql://prod.example/tomverse" }), false);
  assert.equal(amuxV19SystemRegistrationTestBoundary({ NODE_ENV: "test",
    TEST_DATABASE_URL: "postgresql://postgres@db/tomverse_test",
    DATABASE_URL: "postgresql://postgres@db/tomverse_test" }), false);
  assert.doesNotMatch(serviceSource,
    /export async function commitAmuxV19CompletedIdeaSystemRegistration\(/);
  assert.ok(serviceSource.indexOf("assertSystemRegistrationReadyInTx(tx, plan)") <
    serviceSource.indexOf("createSystemRegistrationContentKeys(plan)"));
  assert.match(serviceSource, /if \(!callbackReturned\) throw error;/);
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
