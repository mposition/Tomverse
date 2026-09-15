import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONSENT_CONFIRMATION_TTL_MS,
  consentAddressDigest,
  createConsentToken,
  readConsentKeyring,
  readConsentToken,
  redactConsentToken,
} from "../lib/emailConsentToken.ts";
import {
  createUnsubscribeToken,
  readUnsubscribeKeyring,
  readUnsubscribeToken,
} from "../lib/unsubscribeToken.ts";

// The consent confirmation token. Contract: docs/policy/email-double-opt-in.md
// §4.2, §4.3, §8.

const keyring = readConsentKeyring({ EMAIL_CONSENT_KEYS: "v1:consent-secret" });
const now = new Date("2026-09-15T00:00:00.000Z");

const payload = {
  userId: "user_1",
  purpose: "product_updates",
  requestedAt: now.toISOString(),
  requestId: "request_1",
  policyVersionId: "policy_1",
  addressDigest: consentAddressDigest("Person@Example.com"),
};

test("a token round-trips and names its kind and version", () => {
  const token = createConsentToken(payload, keyring);
  assert.match(token, /^c1\.v1\./);
  const read = readConsentToken(token, keyring, now);
  assert.equal(read.valid, true);
  assert.deepEqual(read.valid && read.payload, { kind: "consent", ...payload });
  assert.equal(read.valid && read.version, "v1");
});

test("the same request always yields the same token, and another request a different one", () => {
  // Deterministic so the lane can rebuild it at send time instead of storing it
  // (docs/policy/email-double-opt-in.md §13.1).
  assert.equal(createConsentToken(payload, keyring), createConsentToken(payload, keyring));
  assert.notEqual(
    createConsentToken(payload, keyring),
    createConsentToken({ ...payload, requestId: "request_2" }, keyring)
  );
});

test("a token without a request id is refused", () => {
  const { requestId, ...withoutId } = payload;
  assert.equal(requestId, "request_1");
  const token = createConsentToken(withoutId, keyring);
  assert.deepEqual(readConsentToken(token, keyring, now), { valid: false, reason: "invalid" });
});

test("the token is opaque: no user id, purpose or address digest in it", () => {
  const token = createConsentToken(payload, keyring);
  for (const value of ["user_1", "product_updates", payload.addressDigest]) {
    assert.equal(token.includes(value), false, value);
  }
});

test("it expires after seventy-two hours, and a future stamp is refused", () => {
  const token = createConsentToken(payload, keyring);
  assert.equal(
    readConsentToken(token, keyring, new Date(now.getTime() + CONSENT_CONFIRMATION_TTL_MS)).valid,
    true
  );
  assert.deepEqual(
    readConsentToken(token, keyring, new Date(now.getTime() + CONSENT_CONFIRMATION_TTL_MS + 1)),
    { valid: false, reason: "expired" }
  );
  const future = createConsentToken(
    { ...payload, requestedAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString() },
    keyring
  );
  assert.deepEqual(readConsentToken(future, keyring, now), { valid: false, reason: "invalid" });
});

test("a tampered token and an unknown key version are refused", () => {
  const token = createConsentToken(payload, keyring);
  const parts = token.split(".");
  parts[3] = `${parts[3].slice(0, -2)}AA`;
  assert.deepEqual(readConsentToken(parts.join("."), keyring, now), {
    valid: false,
    reason: "invalid",
  });
  const rotated = readConsentKeyring({ EMAIL_CONSENT_KEYS: "v2:other" });
  assert.deepEqual(readConsentToken(token, rotated, now), {
    valid: false,
    reason: "unknown_key",
  });
});

test("unsubscribe and consent tokens cannot be replayed as each other", () => {
  // §4.3: different prefixes, different keyrings, different key derivation --
  // even with the same secret pasted into both variables.
  const sameSecret = "shared-secret";
  const consentRing = readConsentKeyring({ EMAIL_CONSENT_KEYS: `v1:${sameSecret}` });
  const unsubscribeRing = readUnsubscribeKeyring({ EMAIL_UNSUBSCRIBE_KEYS: `v1:${sameSecret}` });

  const unsubscribe = createUnsubscribeToken(
    { userId: "user_1", purpose: "product_updates" },
    unsubscribeRing
  );
  assert.deepEqual(readConsentToken(unsubscribe, consentRing, now), {
    valid: false,
    reason: "malformed",
  });

  const consent = createConsentToken(payload, consentRing);
  assert.deepEqual(readUnsubscribeToken(consent, unsubscribeRing), {
    valid: false,
    reason: "malformed",
  });

  // Forcing the prefix does not help: the derived key differs.
  const disguised = `u1${consent.slice(2)}`;
  assert.equal(readUnsubscribeToken(disguised, unsubscribeRing).valid, false);
});

test("the address digest ignores case and surrounding space only", () => {
  assert.equal(
    consentAddressDigest(" Person@Example.com "),
    consentAddressDigest("person@example.com")
  );
  assert.notEqual(
    consentAddressDigest("person@example.com"),
    consentAddressDigest("other@example.com")
  );
});

test("a keyring with no usable pair is absent, and a missing pinned version throws", () => {
  assert.equal(readConsentKeyring({}), null);
  assert.equal(readConsentKeyring({ EMAIL_CONSENT_KEYS: "nonsense" }), null);
  assert.throws(() =>
    readConsentKeyring({ EMAIL_CONSENT_KEYS: "v1:a", EMAIL_CONSENT_KEY_VERSION: "v2" })
  );
});

test("the token is redacted from a logged URL", () => {
  assert.equal(
    redactConsentToken("https://tomverse.app/consent/confirm?t=c1.v1.a.b.c"),
    "https://tomverse.app/consent/confirm?t=[redacted]"
  );
  assert.equal(
    redactConsentToken("https://tomverse.app/consent/confirm#t=c1.v1.a.b.c"),
    "https://tomverse.app/consent/confirm#t=[redacted]"
  );
});
