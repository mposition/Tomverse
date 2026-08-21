import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createUnsubscribeToken,
  readUnsubscribeKeyring,
  readUnsubscribeToken,
  redactUnsubscribeToken,
} from "../lib/unsubscribeToken.ts";
import {
  CONSENT_REQUIRED_PURPOSES,
  EMAIL_PURPOSES,
  LOCKED_EMAIL_PURPOSES,
  consentActionFor,
  defaultPreferenceEnabled,
  preferenceChangeDecision,
  recordsConsent,
} from "../lib/emailPreferenceCore.ts";

// Unsubscribe tokens and preference rules.
// Contract: docs/policy/email-notifications.md §11.2, §11.4, §17.1.

const keyring = { activeVersion: "v1", secrets: { v1: "unsubscribe-secret-v1" } };

test("a token round-trips and carries what the endpoint needs", () => {
  const token = createUnsubscribeToken(
    { userId: "user_abc", purpose: "newsletter", deliveryId: "del_1" },
    keyring
  );
  const read = readUnsubscribeToken(token, keyring);

  assert.equal(read.valid, true);
  assert.deepEqual(read.valid && read.payload, {
    userId: "user_abc",
    purpose: "newsletter",
    deliveryId: "del_1",
  });
});

test("the token reveals nothing about who it is for", () => {
  const token = createUnsubscribeToken(
    { userId: "user_abc", purpose: "newsletter" },
    keyring
  );

  // It travels in a URL, so it reaches referrer headers, access logs and
  // link previews. Anything readable in it is readable there.
  assert.equal(token.includes("user_abc"), false);
  assert.equal(token.includes("newsletter"), false);
});

test("a tampered token is refused rather than reinterpreted", () => {
  const token = createUnsubscribeToken(
    { userId: "user_abc", purpose: "newsletter" },
    keyring
  );
  const parts = token.split(".");

  const flipped = Buffer.from(parts[3], "base64url");
  flipped[0] ^= 0xff;
  parts[3] = flipped.toString("base64url");

  assert.deepEqual(readUnsubscribeToken(parts.join("."), keyring), {
    valid: false,
    reason: "invalid",
  });

  assert.deepEqual(readUnsubscribeToken("not-a-token", keyring), {
    valid: false,
    reason: "malformed",
  });
});

test("a token from another deployment does not open here", () => {
  const theirs = createUnsubscribeToken(
    { userId: "user_abc", purpose: "newsletter" },
    { activeVersion: "v1", secrets: { v1: "a-different-secret" } }
  );
  assert.deepEqual(readUnsubscribeToken(theirs, keyring), {
    valid: false,
    reason: "invalid",
  });
});

test("rotation keeps old links working, and dropping a key is distinguishable", () => {
  const old = createUnsubscribeToken(
    { userId: "user_abc", purpose: "promotions" },
    keyring
  );

  const rotated = {
    activeVersion: "v2",
    secrets: { ...keyring.secrets, v2: "unsubscribe-secret-v2" },
  };

  // People unsubscribe from mail far older than any expiry we could justify,
  // and a dead link's alternative is the spam button.
  assert.equal(readUnsubscribeToken(old, rotated).valid, true);
  assert.equal(
    createUnsubscribeToken({ userId: "u", purpose: "promotions" }, rotated).split(
      "."
    )[1],
    "v2"
  );

  // Dropping v1 breaks every link of that vintage. Reported as its own reason
  // because that is an operator error, not a user one.
  assert.deepEqual(
    readUnsubscribeToken(old, { activeVersion: "v2", secrets: { v2: "x" } }),
    { valid: false, reason: "unknown_key" }
  );
});

test("the keyring is read as version:secret pairs", () => {
  assert.deepEqual(
    readUnsubscribeKeyring({
      EMAIL_UNSUBSCRIBE_KEYS: "v1:one, v2:two",
      EMAIL_UNSUBSCRIBE_KEY_VERSION: "v2",
    }),
    { activeVersion: "v2", secrets: { v1: "one", v2: "two" } }
  );
  assert.equal(readUnsubscribeKeyring({}), null);
  assert.throws(
    () =>
      readUnsubscribeKeyring({
        EMAIL_UNSUBSCRIBE_KEYS: "v1:one",
        EMAIL_UNSUBSCRIBE_KEY_VERSION: "v9",
      }),
    /no matching key/
  );
});

test("the token is kept out of anything that logs a URL", () => {
  assert.equal(
    redactUnsubscribeToken("https://tomverse.app/unsubscribe?t=u1.v1.aa.bb.cc"),
    "https://tomverse.app/unsubscribe?t=[redacted]"
  );
  assert.equal(
    redactUnsubscribeToken("/unsubscribe?lang=ko&t=abc&x=1"),
    "/unsubscribe?lang=ko&t=[redacted]&x=1"
  );
});

test("a token can only ever turn something off", () => {
  // The property that lets the link work with no login at all: a leaked token's
  // worst case is that somebody receives less mail.
  assert.deepEqual(
    preferenceChangeDecision({ purpose: "newsletter", enabled: false, viaToken: true }),
    { allowed: true }
  );
  assert.deepEqual(
    preferenceChangeDecision({ purpose: "newsletter", enabled: true, viaToken: true }),
    { allowed: false, reason: "token_cannot_enable" }
  );

  // Signed in, re-enabling is ordinary.
  assert.deepEqual(
    preferenceChangeDecision({ purpose: "newsletter", enabled: true }),
    { allowed: true }
  );
});

test("security and billing cannot be switched off by anyone", () => {
  for (const purpose of ["security", "billing"]) {
    assert.deepEqual(preferenceChangeDecision({ purpose, enabled: false }), {
      allowed: false,
      reason: "locked",
    });
    assert.deepEqual(
      preferenceChangeDecision({ purpose, enabled: false, viaToken: true }),
      { allowed: false, reason: "locked" }
    );
  }

  assert.deepEqual(
    preferenceChangeDecision({ purpose: "not_a_purpose", enabled: false }),
    { allowed: false, reason: "unknown_purpose" }
  );
});

test("a new account starts with nothing consent-based switched on", () => {
  for (const purpose of EMAIL_PURPOSES) {
    assert.equal(
      defaultPreferenceEnabled(purpose),
      !CONSENT_REQUIRED_PURPOSES.has(purpose),
      `${purpose} default is wrong`
    );
  }

  // Nobody has agreed to anything at signup, and a default-on marketing
  // preference is the opt-out model section 5.1 declines to use.
  assert.equal(defaultPreferenceEnabled("promotions"), false);
  assert.equal(defaultPreferenceEnabled("newsletter"), false);
  // Contract performance, so on and still switchable.
  assert.equal(defaultPreferenceEnabled("service_status"), true);
});

test("locked purposes are a subset of the ones that need no consent", () => {
  for (const purpose of LOCKED_EMAIL_PURPOSES) {
    assert.equal(
      CONSENT_REQUIRED_PURPOSES.has(purpose),
      false,
      `${purpose} cannot both require consent and be unswitchable`
    );
  }
});

test("only consent-based purposes write consent history", () => {
  assert.equal(recordsConsent("newsletter"), true);
  assert.equal(recordsConsent("promotions"), true);

  // An outage notice is contract performance. Recording it as consent would put
  // entries in an evidence table for something nobody asked consent for.
  assert.equal(recordsConsent("service_status"), false);
  assert.equal(recordsConsent("security"), false);
});

test("re-agreeing is a different event from agreeing", () => {
  assert.equal(consentActionFor({ wasEnabled: null, nowEnabled: true }), "granted");
  assert.equal(consentActionFor({ wasEnabled: false, nowEnabled: true }), "granted");
  // A history that records both as `granted` cannot answer when consent began.
  assert.equal(consentActionFor({ wasEnabled: true, nowEnabled: true }), "reconfirmed");
  assert.equal(consentActionFor({ wasEnabled: true, nowEnabled: false }), "withdrawn");
});
