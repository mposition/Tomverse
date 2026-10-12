import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  GUEST_CHAT_AUTO_AUTHORITY_MAX_TTL_SECONDS,
  GUEST_CHAT_AUTO_AUTHORITY_MIN_TTL_SECONDS,
  mintGuestChatAutoAuthority,
  verifyGuestChatAutoAuthority,
  type GuestChatAutoAuthorityBinding,
} from "../lib/guestChatAutoAuthority.ts";

const SECRET = "test-only-guest-chat-auto-secret";
const NOW_MS = Date.parse("2026-10-12T04:00:00.000Z");
const AUTHORITY_ID = "11111111-1111-4111-8111-111111111111";
const NONCE = "22222222-2222-4222-8222-222222222222";

const binding = (
  overrides: Partial<GuestChatAutoAuthorityBinding> = {}
): GuestChatAutoAuthorityBinding => ({
  subjectKey: `guest:${"a".repeat(64)}`,
  sourceCommitSha: "b".repeat(40),
  runtimeDeploymentId: "33333333-3333-4333-8333-333333333333",
  activationPairDigest: "c".repeat(64),
  configDigest: "d".repeat(64),
  ...overrides,
});

const mint = (overrides: Record<string, unknown> = {}) =>
  mintGuestChatAutoAuthority({
    secret: SECRET,
    binding: binding(),
    authorityId: AUTHORITY_ID,
    nonce: NONCE,
    nowMs: NOW_MS,
    ttlSeconds: 60,
    ...overrides,
  });

const verify = (
  token: string,
  overrides: Record<string, unknown> = {}
) =>
  verifyGuestChatAutoAuthority(token, {
    secret: SECRET,
    binding: binding(),
    nowMs: NOW_MS,
    ...overrides,
  });

const signWirePayload = (payload: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(`guest-chat-auto-authority.v1\0${body}`, "utf8")
    .digest("base64url");
  return `gca1.${body}.${signature}`;
};

const decodedPayload = (token = mint()) => {
  const [, body] = token.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
};

test("mints and verifies an exact Guest Chat Smart Adaptive authority", () => {
  const verdict = verify(mint());
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.equal(verdict.payload.authorityId, AUTHORITY_ID);
  assert.equal(verdict.payload.nonce, NONCE);
  assert.equal(verdict.payload.subjectKey, binding().subjectKey);
  assert.equal(verdict.payload.issuedAtMs, NOW_MS);
  assert.equal(verdict.payload.expiresAtMs, NOW_MS + 60_000);
  assert.equal(Object.isFrozen(verdict.payload), true);
});

test("keeps authorityId stable while a nonce makes independently minted tokens unique", () => {
  const first = mint();
  const second = mint({ nonce: "44444444-4444-4444-8444-444444444444" });
  assert.notEqual(first, second);

  const firstVerdict = verify(first);
  const secondVerdict = verify(second);
  assert.equal(firstVerdict.ok, true);
  assert.equal(secondVerdict.ok, true);
  if (!firstVerdict.ok || !secondVerdict.ok) return;
  assert.equal(firstVerdict.payload.authorityId, AUTHORITY_ID);
  assert.equal(secondVerdict.payload.authorityId, AUTHORITY_ID);
  assert.equal(firstVerdict.payload.subjectKey, secondVerdict.payload.subjectKey);
});

test("rejects tampering before trusting a payload", () => {
  const token = mint();
  const [prefix, body, signature] = token.split(".");
  const changedBody = `${body.slice(0, -1)}${body.endsWith("A") ? "B" : "A"}`;
  assert.deepEqual(verify(`${prefix}.${changedBody}.${signature}`), {
    ok: false,
    reason: "invalid_signature",
  });

  const changedSignature = `${signature.slice(0, -1)}${
    signature.endsWith("A") ? "B" : "A"
  }`;
  assert.deepEqual(verify(`${prefix}.${body}.${changedSignature}`), {
    ok: false,
    reason: "invalid_signature",
  });
});

test("rejects another Guest subject and another exact release", () => {
  assert.deepEqual(
    verify(mint(), {
      binding: binding({ subjectKey: `guest:${"e".repeat(64)}` }),
    }),
    { ok: false, reason: "subject_mismatch" }
  );
  assert.deepEqual(
    verify(mint(), {
      binding: binding({ sourceCommitSha: "e".repeat(40) }),
    }),
    { ok: false, reason: "release_mismatch" }
  );
  assert.deepEqual(
    verify(mint(), {
      binding: binding({
        runtimeDeploymentId: "55555555-5555-4555-8555-555555555555",
      }),
    }),
    { ok: false, reason: "release_mismatch" }
  );
});

test("rejects foreign activation and configuration identities", () => {
  assert.deepEqual(
    verify(mint(), {
      binding: binding({ activationPairDigest: "e".repeat(64) }),
    }),
    { ok: false, reason: "activation_mismatch" }
  );
  assert.deepEqual(
    verify(mint(), {
      binding: binding({ configDigest: "e".repeat(64) }),
    }),
    { ok: false, reason: "config_mismatch" }
  );
});

test("rejects a not-yet-valid or expired authority at exact boundaries", () => {
  assert.deepEqual(verify(mint(), { nowMs: NOW_MS - 1 }), {
    ok: false,
    reason: "not_yet_valid",
  });
  assert.equal(verify(mint(), { nowMs: NOW_MS + 59_999 }).ok, true);
  assert.deepEqual(verify(mint(), { nowMs: NOW_MS + 60_000 }), {
    ok: false,
    reason: "expired",
  });
});

test("enforces the existing short admission TTL bounds without reading env", () => {
  assert.doesNotThrow(() =>
    mint({ ttlSeconds: GUEST_CHAT_AUTO_AUTHORITY_MIN_TTL_SECONDS })
  );
  assert.doesNotThrow(() =>
    mint({ ttlSeconds: GUEST_CHAT_AUTO_AUTHORITY_MAX_TTL_SECONDS })
  );
  for (const ttlSeconds of [
    GUEST_CHAT_AUTO_AUTHORITY_MIN_TTL_SECONDS - 1,
    GUEST_CHAT_AUTO_AUTHORITY_MAX_TTL_SECONDS + 1,
    60.5,
  ]) {
    assert.throws(
      () => mint({ ttlSeconds }),
      /guest_chat_auto_authority_input_invalid/
    );
  }
});

test("rejects Review, foreign purpose, policy, and comparison token shapes", () => {
  const source = decodedPayload();
  assert.deepEqual(
    verify(signWirePayload({ ...source, product: "review" })),
    { ok: false, reason: "product_mismatch" }
  );
  assert.deepEqual(
    verify(signWirePayload({ ...source, purpose: "model_compare" })),
    { ok: false, reason: "purpose_mismatch" }
  );
  assert.deepEqual(
    verify(signWirePayload({ ...source, policyVersion: 2 })),
    { ok: false, reason: "policy_mismatch" }
  );
  assert.deepEqual(verify("comparison-body.comparison-signature"), {
    ok: false,
    reason: "malformed",
  });
});

test("uses a strict canonical payload with no prompt, price, score, or secret", () => {
  const source = decodedPayload();
  assert.deepEqual(Object.keys(source), [
    "version",
    "purpose",
    "product",
    "policyVersion",
    "authorityId",
    "nonce",
    "subjectKey",
    "sourceCommitSha",
    "runtimeDeploymentId",
    "activationPairDigest",
    "configDigest",
    "issuedAtMs",
    "expiresAtMs",
  ]);
  assert.equal(JSON.stringify(source).includes(SECRET), false);
  for (const forbidden of ["prompt", "reason", "price", "score", "cookie"]) {
    assert.equal(Object.hasOwn(source, forbidden), false);
  }

  assert.deepEqual(verify(signWirePayload({ ...source, unexpected: true })), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(
    verify(signWirePayload({ ...source, purpose: "x".repeat(121) })),
    { ok: false, reason: "malformed" }
  );
});

test("fails closed for missing secrets, malformed inputs, and invalid bindings", () => {
  assert.throws(
    () => mint({ secret: "" }),
    /guest_chat_auto_authority_secret_unavailable/
  );
  assert.deepEqual(verify(mint(), { secret: "" }), {
    ok: false,
    reason: "secret_unavailable",
  });
  assert.deepEqual(verify("gca1.invalid.payload"), {
    ok: false,
    reason: "invalid_signature",
  });
  assert.deepEqual(verify(`gca1.${"a".repeat(4_096)}.signature`), {
    ok: false,
    reason: "malformed",
  });
  assert.throws(
    () => mint({ authorityId: "not-a-uuid" }),
    /guest_chat_auto_authority_input_invalid/
  );
  assert.throws(
    () => mint({ binding: binding({ subjectKey: "guest:raw-cookie" }) }),
    /guest_chat_auto_authority_input_invalid/
  );
  assert.deepEqual(
    verify(mint(), { binding: undefined }),
    { ok: false, reason: "malformed" }
  );
});
