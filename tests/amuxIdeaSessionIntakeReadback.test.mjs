import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
  AMUX_SESSION_INTAKE_READBACK_CODE_LATCH,
  AMUX_SESSION_INTAKE_READBACK_ENV,
  amuxSessionIntakeConflictingSecretValues,
  amuxSessionIntakeReadbackEnabled,
  amuxSessionIntakeReadbackReply,
  amuxSessionIntakeReadbackRequestId,
  isAmuxSessionIntakeConflictingSecretEnvName,
  isAmuxSessionIntakeClientAuthorized,
} from "../lib/amux/ideaSessionIntakeReadbackCore.ts";

const requestId = "34340477-7664-42f4-b3fe-845d10365051";
const ideaId = "8486a25b-919f-4714-a3d8-45ef5a18b175";
const secret = "session_intake_only_012345678901234567890123";
const request = (query = `?requestId=${requestId}`, token = secret,
  headers = {}) => new Request(
  `https://tomverse.test/api/internal/amux/ideas/session-intake${query}`,
  { headers: { authorization: `Bearer ${token}`, ...headers } },
);

test("session readback has an independent credential and two exact off-by-default switches", () => {
  assert.equal(AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
    "TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET");
  assert.equal(AMUX_SESSION_INTAKE_READBACK_ENV,
    "TOMVERSE_AMUX_SESSION_INTAKE_READBACK");
  assert.equal(AMUX_SESSION_INTAKE_READBACK_CODE_LATCH, true);
  assert.equal(amuxSessionIntakeReadbackEnabled(undefined, undefined), false);
  assert.equal(amuxSessionIntakeReadbackEnabled("enabled", undefined), false);
  assert.equal(amuxSessionIntakeReadbackEnabled(undefined, "enabled"), false);
  assert.equal(amuxSessionIntakeReadbackEnabled("ENABLED", "enabled"), false);
  assert.equal(amuxSessionIntakeReadbackEnabled("enabled", "enabled"), true);

  assert.equal(isAmuxSessionIntakeClientAuthorized(request(), secret, []), true);
  assert.equal(isAmuxSessionIntakeClientAuthorized(request("", secret), secret, []), true);
  assert.equal(isAmuxSessionIntakeClientAuthorized(request("", "wrong_credential_value_0123456789"),
    secret, []), false);
  assert.equal(isAmuxSessionIntakeClientAuthorized(request(), secret, [secret]), false);
  assert.equal(isAmuxSessionIntakeClientAuthorized(request(), undefined, []), false);
  assert.equal(isAmuxSessionIntakeClientAuthorized(request(), "short", []), false);
  assert.equal(isAmuxSessionIntakeClientAuthorized(new Request(request().url, {
    headers: { cookie: "authjs.session-token=synthetic-owner-cookie" },
  }), secret, []), false);
});

test("session readback rejects current and future secret-like environment collisions", () => {
  for (const name of [
    "ROUTING_FAULT_INJECTION_SECRET",
    "CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_SECRET",
    "ZERNIO_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "MOBILE_AUTH_SIGNING_KEYS",
    "OPENAI_API_KEY",
    "FUTURE_INTERNAL_CAPABILITY_SECRET",
    "FUTURE_PROVIDER_API_KEY",
    "FUTURE_WORKER_TOKEN",
    "FUTURE_KEYRING",
  ]) assert.equal(isAmuxSessionIntakeConflictingSecretEnvName(name), true, name);

  for (const name of [
    AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
    "PUBLIC_APP_URL",
    "RAILWAY_ENVIRONMENT",
    "TOMVERSE_AMUX_SESSION_INTAKE_READBACK",
  ]) assert.equal(isAmuxSessionIntakeConflictingSecretEnvName(name), false, name);

  assert.deepEqual(amuxSessionIntakeConflictingSecretValues({
    [AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV]: secret,
    FUTURE_INTERNAL_CAPABILITY_SECRET: secret,
    FUTURE_PROVIDER_API_KEY: "",
    PUBLIC_APP_URL: secret,
  }), [secret]);
});

test("session readback accepts one exact request ID and no lookup extensions", () => {
  assert.equal(amuxSessionIntakeReadbackRequestId(request()), requestId);
  for (const query of [
    "",
    "?requestId=not-an-id",
    `?requestId=${requestId}&requestId=${requestId}`,
    `?requestId=${requestId}&other=value`,
  ]) assert.equal(amuxSessionIntakeReadbackRequestId(request(query)), null);
});

test("session readback responses expose only closed metadata and never invite another write", () => {
  assert.deepEqual(amuxSessionIntakeReadbackReply(requestId,
    { requestId, status: "absent" }), {
    status: 404,
    body: { status: "absent", requestId, retryWrite: false },
  });
  assert.deepEqual(amuxSessionIntakeReadbackReply(requestId,
    { requestId, status: "partial", ideaId }), {
    status: 409,
    body: { status: "partial", requestId, ideaId, retryWrite: false },
  });
  const reply = amuxSessionIntakeReadbackReply(requestId,
    { requestId, status: "committed", ideaId,
    hasExternalSources: true, rawIdea: "must-not-leak", sourceProvenance: "must-not-leak",
    credential: secret });
  assert.deepEqual(reply, { status: 200, body: {
    status: "committed", requestId, ideaId, hasExternalSources: true,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${requestId}`,
  } });
  assert.doesNotMatch(JSON.stringify(reply), /must-not-leak|credential|sourceProvenance|rawIdea/);
  assert.throws(() => amuxSessionIntakeReadbackReply(requestId,
    { requestId: "a2e13249-c51b-4256-b77f-44b863d58690", status: "absent" }),
  /request ID mismatch/);
});
