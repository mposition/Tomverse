import assert from "node:assert/strict";
import test from "node:test";

import {
  SIGNUP_INTENT_PROVIDERS,
  isSessionCookieName,
  isSignupIntentProvider,
  oauthSignupGate,
  signupRedirectPath,
} from "../lib/sessionRevocationCore.ts";

// Whether an OAuth sign-in may create an account.
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.2a (v25).

const gate = (overrides = {}) =>
  oauthSignupGate({
    provider: "google",
    accountExists: false,
    addressHasUser: false,
    hasSession: false,
    intentProvider: null,
    ...overrides,
  });

test("a provider account already here signs in, whatever else is true", () => {
  assert.deepEqual(gate({ accountExists: true }), { allow: true, reason: "existing_account" });
  assert.deepEqual(gate({ accountExists: true, intentProvider: "google" }), {
    allow: true,
    reason: "existing_account",
  });
});

test("a new provider account from the sign-in screen goes to sign-up", () => {
  assert.deepEqual(gate(), { allow: false, reason: "no_account" });
});

test("only the sign-up screen's intent for this provider creates an account", () => {
  assert.deepEqual(gate({ intentProvider: "google" }), { allow: true, reason: "signup_intent" });
  // An intent set for the other provider is not an intent for this one.
  assert.deepEqual(gate({ intentProvider: "azure-ad" }), { allow: false, reason: "no_account" });
  assert.deepEqual(gate({ intentProvider: "" }), { allow: false, reason: "no_account" });
});

test("an address that already has an account keeps NextAuth's own refusal", () => {
  // Sending it to sign-up would only meet OAuthAccountNotLinked again there.
  assert.deepEqual(gate({ addressHasUser: true }), { allow: true, reason: "address_has_user" });
});

test("a callback with a session is a link, not a sign-up", () => {
  assert.deepEqual(gate({ hasSession: true }), { allow: true, reason: "session_link" });
});

test("the redirect is a fixed path that carries only a known provider", () => {
  assert.equal(signupRedirectPath("google"), "/auth/signup?notice=no_account&provider=google");
  assert.equal(signupRedirectPath("azure-ad"), "/auth/signup?notice=no_account&provider=azure-ad");
  assert.equal(signupRedirectPath("https://evil.example"), "/auth/signup?notice=no_account");
  for (const provider of SIGNUP_INTENT_PROVIDERS) assert.ok(isSignupIntentProvider(provider));
  assert.equal(isSignupIntentProvider("email-code"), false);
});

test("the session cookie is recognised with and without the secure prefix and chunks", () => {
  for (const name of [
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
    "__Secure-next-auth.session-token.0",
  ]) {
    assert.ok(isSessionCookieName(name), name);
  }
  for (const name of ["next-auth.callback-url", "next-auth.csrf-token", "session-token"]) {
    assert.equal(isSessionCookieName(name), false, name);
  }
});
