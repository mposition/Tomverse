import assert from "node:assert/strict";
import test from "node:test";

import {
  estimatedCountryFromHeader,
  signupConsentAttemptState,
  signupConsentRefusal,
} from "../lib/signupConsentCore.ts";

// The sign-up consent choice and when it may be consumed.
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.2 (S4).

const NOW = new Date("2026-09-29T10:00:00.000Z");
const minutes = (value) => new Date(NOW.getTime() + value * 60_000);

const attempt = (overrides = {}) => ({
  channel: "oauth",
  bindingProvider: "google",
  bindingEmail: null,
  createdAt: minutes(-5),
  consumedAt: null,
  supersededAt: null,
  expiresAt: minutes(55),
  ...overrides,
});

const account = (overrides = {}) => ({
  createdAt: minutes(-2),
  email: "new@example.test",
  providers: ["google"],
  alreadyConsumed: false,
  ...overrides,
});

const refusal = (input = {}) =>
  signupConsentRefusal({
    attempt: attempt(input.attempt),
    account: account(input.account),
    emailLoginSince: input.emailLoginSince === undefined ? null : input.emailLoginSince,
    now: NOW,
  });

test("the four states, and only pending may be consumed", () => {
  assert.equal(signupConsentAttemptState(attempt(), NOW), "pending");
  assert.equal(signupConsentAttemptState(attempt({ consumedAt: minutes(-1) }), NOW), "consumed");
  assert.equal(signupConsentAttemptState(attempt({ supersededAt: minutes(-1) }), NOW), "superseded");
  assert.equal(signupConsentAttemptState(attempt({ expiresAt: NOW }), NOW), "expired");
  for (const state of [{ consumedAt: minutes(-1) }, { supersededAt: minutes(-1) }, { expiresAt: NOW }]) {
    assert.equal(refusal({ attempt: state }), "not_pending");
  }
});

test("an OAuth account created by this flow consumes the choice", () => {
  assert.equal(refusal(), null);
});

test("an existing account's sign-in never consumes a choice", () => {
  // Created before the attempt: somebody signing in, not signing up.
  assert.equal(refusal({ account: { createdAt: minutes(-60) } }), "account_predates_attempt");
  // An account whose age nobody recorded is refused, not assumed new.
  assert.equal(refusal({ account: { createdAt: null } }), "account_age_unknown");
  // One that consumed a choice already.
  assert.equal(refusal({ account: { alreadyConsumed: true } }), "account_already_consumed");
});

test("the binding has to be the channel's own", () => {
  // Another provider, or more than one: not the account this OAuth flow made.
  assert.equal(refusal({ account: { providers: ["azure-ad"] } }), "binding_mismatch");
  assert.equal(refusal({ account: { providers: ["google", "azure-ad"] } }), "binding_mismatch");
  assert.equal(refusal({ account: { providers: [] } }), "binding_mismatch");
});

test("an email-code account needs its address and a code consumed since the choice", () => {
  const emailAttempt = { channel: "email_code", bindingProvider: null, bindingEmail: "new@example.test" };
  const emailAccount = { providers: [] };
  assert.equal(
    refusal({ attempt: emailAttempt, account: emailAccount, emailLoginSince: { id: "ela_1" } }),
    null
  );
  // No email login since the choice was made.
  assert.equal(
    refusal({ attempt: emailAttempt, account: emailAccount, emailLoginSince: null }),
    "binding_mismatch"
  );
  // Another address.
  assert.equal(
    refusal({
      attempt: emailAttempt,
      account: { ...emailAccount, email: "other@example.test" },
      emailLoginSince: { id: "ela_1" },
    }),
    "binding_mismatch"
  );
  // An account that already has an OAuth sign-in was made by the other channel.
  assert.equal(
    refusal({
      attempt: emailAttempt,
      account: { providers: ["google"] },
      emailLoginSince: { id: "ela_1" },
    }),
    "binding_mismatch"
  );
});

test("only a real country is an estimate", () => {
  assert.equal(estimatedCountryFromHeader("kr"), "KR");
  assert.equal(estimatedCountryFromHeader(" AU "), "AU");
  for (const value of ["XX", "ZZ", "T1", "", null, undefined, "KOR"]) {
    assert.equal(estimatedCountryFromHeader(value), null, String(value));
  }
});
