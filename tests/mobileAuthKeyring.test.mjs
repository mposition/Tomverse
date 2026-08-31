import assert from "node:assert/strict";
import test from "node:test";

import {
  MobileAuthKeyringError,
  activeMobileRefreshPepper,
  activeMobileSigningKey,
  mobileAuthConfigured,
  mobileRefreshPepperById,
  mobileSigningKeyById,
  mobileSigningKeyring,
  mobileTokenAudience,
  mobileTokenIssuer,
} from "../lib/mobileAuthKeyring.ts";

/**
 * The two rings, and the asymmetry that is the reason there are two.
 *
 * Design D6 and approved decision 3 of 2026-08-31.
 */

const KEY_A = "a".repeat(48);
const KEY_B = "b".repeat(48);
/** Deliberately not the word "short": the refusal says "too short" about it. */
const TOO_SHORT = "wxyz";

const env = (overrides = {}) => ({
  MOBILE_AUTH_SIGNING_KEYS: `sign-1:${KEY_A},sign-2:${KEY_B}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${KEY_A},pep-2:${KEY_B}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.app",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
  ...overrides,
});

test("a retired key stays in the ring while a newer one signs", () => {
  const ring = mobileSigningKeyring(env());
  assert.deepEqual([...ring.keys()], ["sign-1", "sign-2"]);
  assert.equal(activeMobileSigningKey(env()).keyId, "sign-2");
  // The point of the id: a token signed before the rotation still verifies.
  assert.equal(mobileSigningKeyById("sign-1", env())?.secret, KEY_A);
});

test("the two rings are independent, so rotating one cannot move the other", () => {
  // D6's asymmetry. A signing key outlives ten minutes of tokens; a pepper is
  // bound to every live refresh token, so retiring it on the signing key's
  // schedule would sign every account out.
  const rotatedSigning = env({
    MOBILE_AUTH_SIGNING_KEYS: `sign-3:${KEY_A}`,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-3",
  });
  assert.equal(activeMobileSigningKey(rotatedSigning).keyId, "sign-3");
  assert.equal(activeMobileRefreshPepper(rotatedSigning).keyId, "pep-2");
  assert.equal(mobileRefreshPepperById("pep-1", rotatedSigning)?.secret, KEY_A);
});

test("an unknown id answers null rather than the active key", () => {
  // Null is "this deployment cannot check it", which the verifier reports as
  // unknown_kid. Falling back to the active key would compare against material
  // the token was never signed with and report it as forged.
  assert.equal(mobileSigningKeyById("sign-9", env()), null);
  assert.equal(mobileRefreshPepperById("pep-9", env()), null);
  assert.equal(mobileSigningKeyById(null, env()), null);
  assert.equal(mobileSigningKeyById(undefined, env()), null);
});

test("an active id naming nothing throws instead of falling back", () => {
  assert.throws(
    () => activeMobileSigningKey(env({ MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-9" })),
    MobileAuthKeyringError
  );
  assert.throws(
    () => activeMobileSigningKey(env({ MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "" })),
    MobileAuthKeyringError
  );
  assert.throws(
    () =>
      activeMobileRefreshPepper(env({ MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-9" })),
    MobileAuthKeyringError
  );
});

test("one id cannot hold two secrets", () => {
  assert.throws(
    () => mobileSigningKeyring(env({ MOBILE_AUTH_SIGNING_KEYS: `k:${KEY_A},k:${KEY_B}` })),
    /configured twice/
  );
});

test("a malformed entry, a hostile id and a short secret are all refused", () => {
  assert.throws(
    () => mobileSigningKeyring(env({ MOBILE_AUTH_SIGNING_KEYS: "no-separator" })),
    /must be "keyId:secret"/
  );
  assert.throws(
    () => mobileSigningKeyring(env({ MOBILE_AUTH_SIGNING_KEYS: `a/b:${KEY_A}` })),
    /not a usable/
  );
  assert.throws(
    () => mobileSigningKeyring(env({ MOBILE_AUTH_SIGNING_KEYS: "k:short" })),
    /too short/
  );
});

test("no refusal ever quotes the secret it refused", () => {
  // A configuration error that prints the key is a configuration error that
  // ends up in a build log.
  const cases = [
    { MOBILE_AUTH_SIGNING_KEYS: `a/b:${KEY_A}` },
    { MOBILE_AUTH_SIGNING_KEYS: `k:${KEY_A},k:${KEY_B}` },
    { MOBILE_AUTH_SIGNING_KEYS: `k:${TOO_SHORT}` },
  ];
  for (const overrides of cases) {
    try {
      mobileSigningKeyring(env(overrides));
      assert.fail("expected a refusal");
    } catch (error) {
      for (const secret of [KEY_A, KEY_B, TOO_SHORT]) {
        assert.ok(!error.message.includes(secret), error.message);
      }
    }
  }
});

test("blank entries are skipped, so a trailing comma is not a configuration error", () => {
  const ring = mobileSigningKeyring(env({ MOBILE_AUTH_SIGNING_KEYS: `sign-1:${KEY_A}, ` }));
  assert.deepEqual([...ring.keys()], ["sign-1"]);
});

test("issuer and audience come from one place each", () => {
  assert.equal(mobileTokenIssuer(env()), "https://tomverse.app");
  assert.equal(mobileTokenAudience(env()), "tomverse-mobile-api");
  assert.throws(() => mobileTokenIssuer(env({ MOBILE_AUTH_TOKEN_ISSUER: "  " })), /not set/);
  assert.throws(() => mobileTokenAudience(env({ MOBILE_AUTH_TOKEN_AUDIENCE: "" })), /not set/);
});

test("a deployment missing any one of the four is not configured", () => {
  assert.equal(mobileAuthConfigured(env()), true);
  for (const missing of [
    "MOBILE_AUTH_SIGNING_KEYS",
    "MOBILE_AUTH_REFRESH_PEPPERS",
    "MOBILE_AUTH_TOKEN_ISSUER",
    "MOBILE_AUTH_TOKEN_AUDIENCE",
  ]) {
    assert.equal(mobileAuthConfigured(env({ [missing]: "" })), false, missing);
  }
});
