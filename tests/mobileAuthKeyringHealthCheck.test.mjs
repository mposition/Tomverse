// The assembly the standing check and the CLI share.
//
// `tests/mobileAuthKeyringHealthReport.test.mjs` beside this one runs the CLI
// as a subprocess and holds what an operator sees. This holds the function
// both callers reach for: which findings come out of an environment, and what
// may never come out with them.
//
// S1-S8 of `.github/audits/2026-09-10-mobile-auth-keyring-standing-check-approval.md`,
// approved 2026-09-10. Synthetic rings; no deployment, no credentials, no
// scheduler.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  MOBILE_AUTH_KEYRING_OPTIONAL_ENV,
  MOBILE_AUTH_KEYRING_REQUIRED_ENV,
  mobileAuthKeyringHealthReport,
  mobileAuthPepperIdentity,
  mobileKeyringFindingText,
} from "../lib/mobileAuthKeyringHealth.ts";

const ed25519 = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

const SIGN_1 = ed25519();
const SIGN_2 = ed25519();
const PEPPER_1 = "p".repeat(48);
const PEPPER_2 = "q".repeat(48);

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const isoAgo = (seconds) => new Date(NOW - seconds * 1_000).toISOString();

const configured = (overrides = {}) => ({
  MOBILE_AUTH_SIGNING_KEYS: `sign-2:${SIGN_2}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER_2}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.example",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
  ...overrides,
});

const report = (environment, nowMs = NOW) =>
  mobileAuthKeyringHealthReport({ environment, nowMs });

const codes = (result) => result.rings.flatMap((ring) => ring.findings.map((f) => f.code));

test("a healthy pair of rings produces no findings", () => {
  const result = report(configured());
  assert.deepEqual(codes(result), []);
  assert.equal(result.configuration.state, "configured");
  assert.equal(result.attention.length, 0);
  assert.equal(result.observedAt, "2026-09-10T12:00:00.000Z");
});

test("a retired key inside its window is not a finding, and past it is", () => {
  const inGrace = configured({
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(300)}`,
  });
  assert.deepEqual(codes(report(inGrace)), []);

  const spent = configured({
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(4_000)}`,
  });
  assert.deepEqual(codes(report(spent)), ["grace_over"]);
});

test("the same ring at two instants gives two answers", () => {
  // Why the cadence is a cost decision rather than a free one (S2): nobody
  // has to touch a variable for a finding to appear.
  const retiredAt = Date.parse("2026-09-10T00:00:00.000Z");
  const environment = configured({
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${new Date(retiredAt).toISOString()}`,
  });
  assert.deepEqual(codes(report(environment, retiredAt + 899_000)), []);
  assert.deepEqual(codes(report(environment, retiredAt + 900_000)), ["grace_over"]);
});

test("an active key that is also retired is reported, and the wording says minting stops now", () => {
  // Not when the retirement instant arrives: `activeEntry()` throws on the
  // presence of the line, whatever the time. Reproduced against the real
  // functions in tests/mobileAuthRollbackMaterial.test.mjs.
  const environment = configured({
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-2@${new Date(NOW + 3_600_000).toISOString()}`,
  });
  const result = report(environment);
  assert.equal(codes(result).includes("active_key_also_retired"), true);
  const line = result.attention.find((entry) => entry.includes("also retired"));
  assert.match(line, /minting is refused now/);
});

test("two ids holding one key are reported by id", () => {
  const result = report(
    configured({ MOBILE_AUTH_SIGNING_KEYS: `sign-2:${SIGN_2},sign-3:${SIGN_2}` })
  );
  const duplicate = result.rings
    .flatMap((ring) => ring.findings)
    .find((finding) => finding.code === "duplicate_material");
  assert.ok(duplicate);
  assert.equal(duplicate.keyId, "sign-3");
  assert.equal(duplicate.otherKeyId, "sign-2");
});

test("duplicate peppers are found the same way, and the digest is not the pepper", () => {
  const result = report(
    configured({ MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER_2},pep-3:${PEPPER_2}` })
  );
  assert.equal(codes(result).includes("duplicate_material"), true);
  assert.equal(JSON.stringify(result).includes(PEPPER_2), false);
});

test("no key material reaches the report, from any ring, in any state", () => {
  // The one thing this must never do. Every material value the environment
  // holds is checked against the whole serialised report, findings and
  // rendered wording included.
  const environment = configured({
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1},pep-2:${PEPPER_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(4_000)}`,
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${isoAgo(60)}`,
  });
  const serialised = JSON.stringify(report(environment));
  for (const material of [SIGN_1, SIGN_2, PEPPER_1, PEPPER_2]) {
    assert.equal(serialised.includes(material), false);
  }
});

test("the pepper comparator answers with a digest, so nothing keyed by material is needed", () => {
  // This is the property, and the earlier version of this test was not it.
  // Duplicate detection is done with a `seen` map built per call, so a
  // comparator that kept raw peppers in a module-level map produced exactly
  // the same findings -- the assertion passed while two peppers sat in
  // process memory. What separates the two implementations is the value the
  // comparator returns: the old one returned the secret itself as the map
  // key, this one returns a hash of it.
  const identity = mobileAuthPepperIdentity();
  const value = identity(PEPPER_1);
  assert.notEqual(value, PEPPER_1);
  assert.equal(value.includes(PEPPER_1), false);
  assert.match(value, /^[0-9a-f]{64}$/);

  // Equal material still compares equal, or duplicate detection would stop
  // working -- which is what makes the digest a substitute and not a change.
  assert.equal(identity(PEPPER_1), identity(PEPPER_1));
  assert.notEqual(identity(PEPPER_1), identity(PEPPER_2));

  // A fresh comparator per report, and each one stateless: a second factory
  // agrees with the first without either having been told.
  const second = mobileAuthPepperIdentity();
  assert.notEqual(second, identity);
  assert.equal(second(PEPPER_1), identity(PEPPER_1));
});

test("duplicate peppers are still found, report after report", () => {
  const first = configured({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1},pep-9:${PEPPER_1}`,
  });
  assert.equal(codes(report(first)).includes("duplicate_material"), true);

  const second = configured({ MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1}` });
  assert.equal(codes(report(second)).includes("duplicate_material"), false);
});

test("a ring pasted into the active-id variable is not echoed back", () => {
  // `normalizeMobileKeyId` only trims, and `KEY_ID_PATTERN` accepts what a
  // base64url pepper looks like, so the active-id variable's contents used to
  // arrive as a `keyId` in the report. Reproduced 2026-09-10.
  const environment = configured({
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: `pep-2:${PEPPER_2}`,
  });
  const result = report(environment);
  const finding = result.rings
    .flatMap((ring) => ring.findings)
    .find((entry) => entry.code === "active_key_not_in_ring");
  assert.ok(finding);
  assert.equal(finding.keyId, undefined);
  assert.equal(finding.unverifiedReference, true);
  assert.equal(JSON.stringify(result).includes(PEPPER_2), false);
  // The operator still learns which variable to look at.
  assert.match(result.attention.join(" "), /active id is not in the ring/);
});

test("a retirement naming something the ring does not hold is counted, not quoted", () => {
  const environment = configured({
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `${PEPPER_1}@${isoAgo(60)}`,
  });
  const result = report(environment);
  assert.equal(JSON.stringify(result).includes(PEPPER_1), false);
  const pepperRing = result.rings.find((ring) =>
    ring.variable === "MOBILE_AUTH_REFRESH_PEPPERS"
  );
  assert.equal(pepperRing.retirementsNamingNothing, 1);
  const finding = result.rings
    .flatMap((ring) => ring.findings)
    .find((entry) => entry.code === "retirement_names_nothing");
  assert.equal(finding.keyId, undefined);
  assert.equal(finding.unverifiedReference, true);
});

test("a partial configuration is a finding, not silence", () => {
  const environment = configured();
  delete environment.MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID;
  const result = report(environment);
  assert.equal(result.configuration.state, "partial");
  assert.equal(result.rings.length, 0);
  assert.match(result.attention.join(" "), /503/);
});

test("nothing configured at all says so and says nothing else", () => {
  const result = report({});
  assert.equal(result.configuration.state, "unconfigured");
  assert.deepEqual(result.attention, []);
  assert.deepEqual(
    result.configuration.missing.sort(),
    [...MOBILE_AUTH_KEYRING_REQUIRED_ENV].sort()
  );
  assert.equal(MOBILE_AUTH_KEYRING_OPTIONAL_ENV.length, 2);
});

test("a ring that will not parse throws rather than reporting a partial truth", () => {
  // Matched by constructor name rather than by the class itself: the class is
  // asserted where one module instance is guaranteed (the route), and a test
  // that imports the same file by a second specifier gets a second copy of
  // it. `MobileAuthKeyringError` extends `Error` without setting `name`, so
  // `error.name` is "Error" and only the constructor tells them apart.
  assert.throws(
    () => report(configured({ MOBILE_AUTH_SIGNING_KEYS: "no-separator-here" })),
    (error) => error.constructor.name === "MobileAuthKeyringError"
  );
});

test("every finding code has wording, and an unknown one still names itself", () => {
  for (const code of [
    "no_active_key_named",
    "active_key_not_in_ring",
    "active_key_also_retired",
    "active_key_cannot_sign",
    "undeclared",
    "retirement_in_future",
    "grace_over",
    "retirement_names_nothing",
    "duplicate_material",
  ]) {
    const text = mobileKeyringFindingText({ code, keyId: "k", otherKeyId: "o", retiredAtMs: NOW });
    assert.equal(typeof text, "string");
    assert.equal(text.includes("no wording for this code"), false, code);
  }
  assert.match(mobileKeyringFindingText({ code: "invented" }), /no wording for this code/);
});
