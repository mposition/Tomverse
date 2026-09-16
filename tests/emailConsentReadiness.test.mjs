import assert from "node:assert/strict";
import { test } from "node:test";

import { consentKeyringReadiness } from "../lib/emailConsentReadiness.ts";

// docs/policy/email-double-opt-in.md §11 item 10: the consent keyring is
// required exactly when marketing sending is configured.

test("missing keys are a warning until MARKETING_EMAIL_FROM is set, then an error", () => {
  const off = consentKeyringReadiness({});
  assert.equal(off.ready, true);
  assert.equal(off.required, false);
  assert.deepEqual(off.warnings.map((problem) => problem.code), ["EMAIL_CONSENT_KEYS_MISSING"]);

  const on = consentKeyringReadiness({ MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>" });
  assert.equal(on.ready, false);
  assert.equal(on.required, true);
  assert.deepEqual(on.errors.map((problem) => problem.code), ["EMAIL_CONSENT_KEYS_MISSING"]);
});

test("a present keyring is ready, and a broken one is an error either way", () => {
  assert.equal(
    consentKeyringReadiness({
      MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>",
      EMAIL_CONSENT_KEYS: "v1:secret",
    }).ready,
    true
  );
  for (const env of [
    { EMAIL_CONSENT_KEYS: "nonsense" },
    { EMAIL_CONSENT_KEYS: "v1:a", EMAIL_CONSENT_KEY_VERSION: "v9" },
  ]) {
    assert.equal(consentKeyringReadiness(env).ready, false, JSON.stringify(env));
  }
});

test("two versions with no pin is a warning, not an error", () => {
  const result = consentKeyringReadiness({ EMAIL_CONSENT_KEYS: "v1:a,v2:b" });
  assert.equal(result.ready, true);
  assert.deepEqual(result.warnings.map((problem) => problem.code), [
    "EMAIL_CONSENT_ACTIVE_VERSION_UNPINNED",
  ]);
});
