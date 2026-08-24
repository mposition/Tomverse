import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingSendingConfigured,
  unsubscribeKeyringProblems,
  unsubscribeKeyringReadiness,
} from "../lib/emailUnsubscribeReadiness.ts";

// Whether the unsubscribe keyring has to work on a given deployment (EM-10).
//
// Contract: docs/policy/email-notifications.md §11.3,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-10.
//
// The point of the item is that /api/ready answered yes on a deployment where
// every marketing send would be refused. The point of it being *conditional* is
// that the opposite mistake -- refusing today's deployment for a capability
// nobody has turned on -- is also a real cost.

const KEYS = "v1:0123456789abcdef0123456789abcdef";
const MARKETING = "Tomverse <news@mail.tomverse.app>";

const codes = (env) => unsubscribeKeyringProblems(env).map((p) => p.code);
const severities = (env) =>
  Object.fromEntries(
    unsubscribeKeyringProblems(env).map((p) => [p.code, p.severity])
  );

test("with no marketing sending identity, a missing key is a warning", () => {
  // Today's deployment. Answering not-ready here would be refusing to serve
  // over a capability nobody has switched on.
  const env = {};
  const readiness = unsubscribeKeyringReadiness(env);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.required, false);
  assert.deepEqual(readiness.errors, []);
  assert.deepEqual(
    readiness.warnings.map((p) => p.code),
    ["EMAIL_UNSUBSCRIBE_KEYS_MISSING"]
  );
});

test("setting the marketing address turns that warning into an error", () => {
  // The state EM-10 names: ready would say yes while every marketing message is
  // refused for having no unsubscribe link.
  const env = { MARKETING_EMAIL_FROM: MARKETING };
  const readiness = unsubscribeKeyringReadiness(env);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.required, true);
  assert.deepEqual(
    readiness.errors.map((p) => p.code),
    ["EMAIL_UNSUBSCRIBE_KEYS_MISSING"]
  );
  // And the message names the variable to set, not the symptom.
  assert.match(readiness.errors[0].message, /EMAIL_UNSUBSCRIBE_KEYS/);
});

test("both configured is ready and required", () => {
  const readiness = unsubscribeKeyringReadiness({
    MARKETING_EMAIL_FROM: MARKETING,
    EMAIL_UNSUBSCRIBE_KEYS: KEYS,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.required, true);
  assert.deepEqual(readiness.warnings, []);
});

test("a keyring that is present and broken is an error either way", () => {
  // Somebody set it, so they meant it to work. Calling it "not required yet"
  // would hide a typo until the day marketing is switched on -- the worst
  // possible day to find it.
  for (const marketing of [undefined, MARKETING]) {
    const base = marketing ? { MARKETING_EMAIL_FROM: marketing } : {};

    assert.deepEqual(
      severities({ ...base, EMAIL_UNSUBSCRIBE_KEYS: "no-separator-here" }),
      { EMAIL_UNSUBSCRIBE_KEYS_INVALID: "error" },
      `marketing=${marketing}`
    );

    // A pinned version with no matching key: the reader throws, and the
    // readiness check has to report that rather than propagate it.
    assert.deepEqual(
      severities({
        ...base,
        EMAIL_UNSUBSCRIBE_KEYS: KEYS,
        EMAIL_UNSUBSCRIBE_KEY_VERSION: "v2",
      }),
      { EMAIL_UNSUBSCRIBE_KEYS_INVALID: "error" },
      `marketing=${marketing}`
    );
  }
});

test("an unpinned rotation is a warning, not a refusal", () => {
  // Sending still works and every token stays verifiable; what is wrong is that
  // which key signs new ones is decided by list order rather than by a choice.
  const env = {
    MARKETING_EMAIL_FROM: MARKETING,
    EMAIL_UNSUBSCRIBE_KEYS: `${KEYS},v2:fedcba9876543210fedcba9876543210`,
  };
  const readiness = unsubscribeKeyringReadiness(env);
  assert.equal(readiness.ready, true);
  assert.deepEqual(
    readiness.warnings.map((p) => p.code),
    ["EMAIL_UNSUBSCRIBE_ACTIVE_VERSION_UNPINNED"]
  );

  // Pinning it clears the warning.
  assert.deepEqual(
    unsubscribeKeyringReadiness({ ...env, EMAIL_UNSUBSCRIBE_KEY_VERSION: "v2" })
      .warnings,
    []
  );
});

test("whitespace-only values count as unset", () => {
  assert.equal(marketingSendingConfigured({ MARKETING_EMAIL_FROM: "   " }), false);
  assert.deepEqual(codes({ EMAIL_UNSUBSCRIBE_KEYS: "  " }), [
    "EMAIL_UNSUBSCRIBE_KEYS_MISSING",
  ]);
});

test("the condition is the sending identity, not the template table", () => {
  // A marketing template exists in every environment the moment one is written
  // -- model_launch already is. Keying on that would have made the keys
  // mandatory everywhere on the day it landed.
  assert.equal(marketingSendingConfigured({}), false);
  assert.equal(
    marketingSendingConfigured({ MARKETING_EMAIL_FROM: MARKETING }),
    true
  );
});
