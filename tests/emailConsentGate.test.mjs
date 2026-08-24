import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CONSENT_REQUIRED_PURPOSES,
  EMAIL_PURPOSES,
  consentGateVerdict,
  defaultPreferenceEnabled,
} from "../lib/emailPreferenceCore.ts";

const gate = (overrides = {}) =>
  consentGateVerdict({
    classification: "marketing",
    purpose: "product_updates",
    hasAccount: true,
    storedEnabled: null,
    ...overrides,
  });

test("an account with no row has not agreed to anything", () => {
  // The measured gap: ensureDefaultPreferences runs on a settings read, so an
  // account that never opened the preference centre has no rows, and the
  // previous check read that silence as consent.
  for (const purpose of CONSENT_REQUIRED_PURPOSES) {
    assert.deepEqual(
      gate({ purpose, storedEnabled: null }),
      { allowed: false, skipReason: "no_consent" },
      `${purpose} must fail closed`
    );
  }
});

test("a missing row still means on for the purposes nobody consents to", () => {
  // service_status defaults on and is contract performance; refusing an outage
  // notice because a row was never materialised withholds mail we owe.
  assert.deepEqual(
    gate({ classification: "service", purpose: "service_status", storedEnabled: null }),
    { allowed: true }
  );
});

test("every purpose's absent-row answer matches its own default", () => {
  for (const purpose of EMAIL_PURPOSES) {
    const verdict = gate({
      classification: CONSENT_REQUIRED_PURPOSES.has(purpose) ? "marketing" : "service",
      purpose,
      storedEnabled: null,
    });
    assert.equal(
      verdict.allowed,
      defaultPreferenceEnabled(purpose),
      `${purpose}: absent row and default disagree`
    );
  }
});

test("a stored row decides, in both directions", () => {
  assert.deepEqual(gate({ storedEnabled: true }), { allowed: true });
  assert.deepEqual(gate({ storedEnabled: false }), {
    allowed: false,
    skipReason: "no_consent",
  });
});

test("ungated mail is unaffected by any of it", () => {
  // A login code has no purpose and must never be gated by one.
  assert.deepEqual(
    gate({ classification: "transactional", purpose: null, storedEnabled: false }),
    { allowed: true }
  );
  assert.deepEqual(
    gate({ classification: "legal", purpose: null, hasAccount: false }),
    { allowed: true }
  );
});

test("marketing to an address with no account is refused", () => {
  // Consent attaches to a person, and no unsubscribe token can be minted for a
  // delivery with no userId -- so the message could not carry the link its
  // classification requires even if somebody had agreed.
  assert.deepEqual(gate({ hasAccount: false, storedEnabled: true }), {
    allowed: false,
    skipReason: "no_consent",
  });
});

test("transactional to an address with no account still sends", () => {
  // The credential lane resolves no user on purpose: a login request is
  // answered identically whether or not an account exists.
  assert.deepEqual(
    gate({ classification: "transactional", purpose: null, hasAccount: false }),
    { allowed: true }
  );
});

test("an unknown purpose does not silently gate anything", () => {
  assert.deepEqual(
    gate({ classification: "service", purpose: "not_a_purpose" }),
    { allowed: true }
  );
});

test("the backfill migration writes exactly what the code would have", () => {
  // The migration hard-codes six purpose/enabled pairs because SQL cannot call
  // defaultPreferenceEnabled(). Two sources for one decision drift, so this
  // reads the migration back and compares them: a change to
  // CONSENT_REQUIRED_PURPOSES that leaves the backfill behind would ship rows
  // that disagree with the send-time gate for every account it touched.
  const sql = readFileSync(
    new URL(
      "../prisma/migrations/20260822140000_email_preference_backfill/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  const values = [...sql.matchAll(/\('([a-z_]+)',\s*(true|false)\)/g)].map(
    ([, purpose, enabled]) => [purpose, enabled === "true"]
  );

  assert.deepEqual(
    values.map(([purpose]) => purpose).sort(),
    [...EMAIL_PURPOSES].sort(),
    "the backfill covers every purpose, and only real ones"
  );
  for (const [purpose, enabled] of values) {
    assert.equal(
      enabled,
      defaultPreferenceEnabled(purpose),
      `${purpose}: the migration and defaultPreferenceEnabled disagree`
    );
  }

  // The one thing docs/policy/email-notifications.md §17.1 asks the backfill
  // not to do. A `granted` row for a
  // default is a false statement in the table whose purpose is to be true
  // about consent, and it is the sender who has to prove consent.
  assert.doesNotMatch(
    sql,
    /INSERT INTO "ConsentRecord"/,
    "the backfill must not manufacture consent history"
  );
});
