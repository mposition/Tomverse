// D5, D7, D8 and section 4 option A, as executable vectors.
//
// Source: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
// sections 5, 7 and 8.1.1 (#4 -- strict single use).
//
// The vectors worth the most here are V24b and V24c. V24 alone -- a wrong
// secret against an *unconsumed* record -- never enters the branch D5 exists to
// guard, so an implementation that judged state before comparing the secret
// would pass it. b and c go into that branch.

import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMobileRefresh,
  rotationMigratedPepper,
  successorPepperKid,
} from "../lib/mobileRefreshRotationCore.ts";
import {
  MOBILE_REFRESH_IDLE_SECONDS,
  MOBILE_REFRESH_ABSOLUTE_SECONDS,
} from "../lib/mobileAuthContract.ts";

const NOW = 1_800_000_000_000;
const IDLE_MS = MOBILE_REFRESH_IDLE_SECONDS * 1000;

const record = (overrides = {}) => ({
  id: "rot_1",
  familyId: "fam_1",
  pepperKid: "p1",
  expiresAtMs: NOW + IDLE_MS,
  consumedAtMs: null,
  invalidatedAtMs: null,
  ...overrides,
});

const family = (overrides = {}) => ({
  familyId: "fam_1",
  deviceId: "dev_1",
  userId: "user_1",
  createdAtMs: NOW - 1000,
  lastRotatedAtMs: NOW - 1000,
  absoluteExpiresAtMs: NOW + MOBILE_REFRESH_ABSOLUTE_SECONDS * 1000,
  revokedAtMs: null,
  deviceRevokedAtMs: null,
  accountStatus: "active",
  ...overrides,
});

/** Counts comparisons so a test can prove one did or did not happen. */
const matcher = (result) => {
  const calls = [];
  const fn = (r) => {
    calls.push(r.id);
    return result;
  };
  fn.calls = calls;
  return fn;
};

const decide = (overrides = {}) =>
  decideMobileRefresh({
    record: overrides.record === undefined ? record() : overrides.record,
    secretMatches: overrides.secretMatches ?? matcher(true),
    family: overrides.family === undefined ? family() : overrides.family,
    nowMs: overrides.nowMs ?? NOW,
    idleWindowMs: overrides.idleWindowMs ?? IDLE_MS,
  });

// --- V8: the ordinary rotation -------------------------------------------

test("V8 -- an unused, in-date record on a healthy family rotates", () => {
  const decision = decide();
  assert.equal(decision.kind, "rotate");
  assert.equal(decision.record.id, "rot_1");
  assert.equal(decision.family.familyId, "fam_1");
});

// --- V24 family: the secret is compared before any state is judged --------

test("V24 -- a wrong secret on an unused record refuses and touches nothing", () => {
  const decision = decide({ secretMatches: matcher(false) });
  assert.deepEqual(decision, { kind: "reject", reason: "secret_mismatch" });
});

test("V24b -- a wrong secret on a CONSUMED record does not destroy the family", () => {
  const decision = decide({
    record: record({ consumedAtMs: NOW - 5000 }),
    secretMatches: matcher(false),
  });
  assert.deepEqual(
    decision,
    { kind: "reject", reason: "secret_mismatch" },
    "a consumed record with the wrong secret must not read as reuse"
  );
});

test("V24c -- a wrong secret on an INVALIDATED record does not destroy the family", () => {
  const decision = decide({
    record: record({ invalidatedAtMs: NOW - 5000 }),
    secretMatches: matcher(false),
  });
  assert.deepEqual(decision, { kind: "reject", reason: "secret_mismatch" });
});

test("V24d -- an unknown record id refuses without comparing anything", () => {
  const compare = matcher(true);
  const decision = decide({ record: null, secretMatches: compare });
  assert.deepEqual(decision, { kind: "reject", reason: "unknown_record" });
  assert.equal(compare.calls.length, 0);
});

test("the record id alone can never revoke a family", () => {
  // The whole point of D5's order: an attacker holding only the front half of
  // a token -- which is not a secret -- must not be able to name a family and
  // have it destroyed. Every state a record can be in, with a wrong secret.
  for (const state of [
    {},
    { consumedAtMs: NOW - 1 },
    { invalidatedAtMs: NOW - 1 },
    { consumedAtMs: NOW - 1, invalidatedAtMs: NOW - 1 },
    { expiresAtMs: NOW - 1 },
  ]) {
    const decision = decide({
      record: record(state),
      secretMatches: matcher(false),
    });
    assert.equal(
      decision.kind,
      "reject",
      `state ${JSON.stringify(state)} must refuse, not revoke`
    );
    assert.equal(decision.reason, "secret_mismatch");
  }
});

// --- V9: reuse, once the secret is right ---------------------------------

test("V9 -- a correct secret on a consumed record is reuse", () => {
  const decision = decide({ record: record({ consumedAtMs: NOW - 5000 }) });
  assert.deepEqual(decision, {
    kind: "reuse_detected",
    familyId: "fam_1",
    reason: "consumed",
  });
});

test("a correct secret on an invalidated record is also reuse", () => {
  const decision = decide({ record: record({ invalidatedAtMs: NOW - 5000 }) });
  assert.deepEqual(decision, {
    kind: "reuse_detected",
    familyId: "fam_1",
    reason: "invalidated",
  });
});

test("reuse outranks expiry -- a replayed token is a replay either way", () => {
  const decision = decide({
    record: record({ consumedAtMs: NOW - 5000, expiresAtMs: NOW - 1 }),
  });
  assert.equal(decision.kind, "reuse_detected");
});

// --- option A: no window, no idempotency ---------------------------------

test("option A -- nothing in this module can re-deliver or re-mint on replay", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("lib/mobileRefreshRotationCore.ts", "utf8")
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of ["idempotency", "idempotent", "graceWindow", "replayWindow"]) {
    assert.equal(
      new RegExp(forbidden, "i").test(code),
      false,
      `option A was approved; ${forbidden} has no place in the rotation decision`
    );
  }
});

// --- family, device and account state ------------------------------------

test("a revoked family, released device or inactive account refuses", () => {
  assert.deepEqual(decide({ family: family({ revokedAtMs: NOW - 1 }) }), {
    kind: "reject",
    reason: "family_revoked",
  });
  assert.deepEqual(decide({ family: family({ deviceRevokedAtMs: NOW - 1 }) }), {
    kind: "reject",
    reason: "device_revoked",
  });
  assert.deepEqual(decide({ family: family({ accountStatus: "suspended" }) }), {
    kind: "reject",
    reason: "account_not_active",
  });
  assert.deepEqual(decide({ family: null }), {
    kind: "reject",
    reason: "family_missing",
  });
});

test("idle and absolute windows are separate refusals", () => {
  assert.deepEqual(
    decide({ family: family({ lastRotatedAtMs: NOW - IDLE_MS }) }),
    { kind: "reject", reason: "family_idle_expired" }
  );
  assert.deepEqual(
    decide({ family: family({ absoluteExpiresAtMs: NOW }) }),
    { kind: "reject", reason: "family_absolute_expired" }
  );
  assert.deepEqual(decide({ record: record({ expiresAtMs: NOW }) }), {
    kind: "reject",
    reason: "record_expired",
  });
});

// --- 8.1.1 #3: a rotation migrates the family onto the current pepper -----

test("a successor is always minted under the current pepper generation", () => {
  assert.equal(
    successorPepperKid({ recordPepperKid: "p1", currentPepperKid: "p2" }),
    "p2"
  );
  assert.equal(
    rotationMigratedPepper({ recordPepperKid: "p1", currentPepperKid: "p2" }),
    true
  );
  assert.equal(
    rotationMigratedPepper({ recordPepperKid: "p2", currentPepperKid: "p2" }),
    false
  );
});

test("a record verified under a retired pepper still rotates", () => {
  const decision = decide({ record: record({ pepperKid: "p_old" }) });
  assert.equal(decision.kind, "rotate");
});

test("no decision carries secret material", () => {
  const serialised = JSON.stringify([
    decide(),
    decide({ secretMatches: matcher(false) }),
    decide({ record: record({ consumedAtMs: NOW }) }),
  ]);
  // The digest is the secret-derived value, and it is absent because the record
  // type this module accepts has no field for it -- the comparison happens
  // behind the `secretMatches` port, so the digest never reaches the decision.
  assert.equal(/secretDigest|"secret"/i.test(serialised), false);

  // `pepperKid` does appear, and should: it is a generation label of the same
  // class as a JWS `kid`, which D15 lists among the fields structured logs may
  // carry. It says which pepper, never what it is.
  assert.match(serialised, /pepperKid/);
});

test("the rotation record type has no field a digest could travel in", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("lib/mobileRefreshRotationCore.ts", "utf8");
  const start = source.indexOf("export type MobileRefreshRecord = {");
  assert.notEqual(start, -1, "MobileRefreshRecord should be declared");
  // Comments stripped first: the type's own doc comment mentions `secretDigest`
  // to say which pepper generation it was computed under, and a comment naming
  // a field is not a field.
  const block = source
    .slice(start, source.indexOf("\n};", start))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const name of ["secretDigest", "secret", "token"]) {
    assert.equal(
      new RegExp(name, "i").test(block),
      false,
      `MobileRefreshRecord must not carry ${name}`
    );
  }
});
