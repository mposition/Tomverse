import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
} from "../lib/mobileAuthContract.ts";
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
const RETIRED_AT = "2026-09-02T10:00:00.000Z";
const retiredAtMs = Date.parse(RETIRED_AT);

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
  // The retirement line is required, not decoration: it is what says this key
  // is a *previous* key rather than one somebody left lying about. Without it
  // `sign-1` verifies nothing, which is the rule the mistyped-id test below
  // exists for.
  const rotated = env({ MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${RETIRED_AT}` });

  const ring = mobileSigningKeyring(rotated);
  assert.deepEqual([...ring.keys()], ["sign-1", "sign-2"]);
  assert.equal(activeMobileSigningKey(rotated).keyId, "sign-2");
  // The point of the id: a token signed before the rotation still verifies.
  assert.equal(mobileSigningKeyById("sign-1", rotated, retiredAtMs)?.secret, KEY_A);
});

test("the two rings are independent, so rotating one cannot move the other", () => {
  // D6's asymmetry. A signing key outlives ten minutes of tokens; a pepper is
  // bound to every live refresh token, so retiring it on the signing key's
  // schedule would sign every account out.
  const rotatedSigning = env({
    MOBILE_AUTH_SIGNING_KEYS: `sign-3:${KEY_A}`,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-3",
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${RETIRED_AT}`,
  });
  assert.equal(activeMobileSigningKey(rotatedSigning).keyId, "sign-3");
  assert.equal(activeMobileRefreshPepper(rotatedSigning).keyId, "pep-2");
  // The signing rotation did not touch the pepper's own window.
  assert.equal(
    mobileRefreshPepperById("pep-1", rotatedSigning, retiredAtMs)?.secret,
    KEY_A
  );
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

// --- retirement, which is what makes the approved windows real -------------

test("a retired signing key verifies through its grace and not past it", () => {
  // Before this existed the two windows were constants nothing read: a key left
  // in the ring after a rotation was trusted for ever, and "the previous key is
  // honoured for fifteen minutes" described an intention rather than the
  // system.
  const retired = env({ MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${RETIRED_AT}` });
  const grace = MOBILE_PREVIOUS_SIGNING_KEY_SECONDS * 1000;

  assert.equal(mobileSigningKeyById("sign-1", retired, retiredAtMs)?.secret, KEY_A);
  assert.equal(
    mobileSigningKeyById("sign-1", retired, retiredAtMs + grace - 1)?.secret,
    KEY_A
  );
  assert.equal(mobileSigningKeyById("sign-1", retired, retiredAtMs + grace), null);
});

test("a retired pepper keeps its own, much longer window", () => {
  // D6's asymmetry, enforced rather than described. A pepper is bound to every
  // refresh token still alive, so cutting it to the signing key's window signs
  // every account out.
  const retired = env({ MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${RETIRED_AT}` });
  const signingGrace = MOBILE_PREVIOUS_SIGNING_KEY_SECONDS * 1000;
  const pepperGrace = MOBILE_PREVIOUS_PEPPER_SECONDS * 1000;

  assert.ok(pepperGrace > signingGrace);
  assert.equal(
    mobileRefreshPepperById("pep-1", retired, retiredAtMs + signingGrace)?.secret,
    KEY_A,
    "a pepper must not expire on the signing key's schedule"
  );
  assert.equal(
    mobileRefreshPepperById("pep-1", retired, retiredAtMs + pepperGrace - 1)?.secret,
    KEY_A
  );
  assert.equal(
    mobileRefreshPepperById("pep-1", retired, retiredAtMs + pepperGrace),
    null
  );
});

test("a retired key cannot be the active one", () => {
  // The mistake the mechanism exists to catch: minting new credentials under a
  // key somebody has already decided to stop trusting.
  assert.throws(
    () =>
      activeMobileSigningKey(
        env({
          MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-1",
          MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${RETIRED_AT}`,
        })
      ),
    /is retired/
  );
  assert.throws(
    () =>
      activeMobileRefreshPepper(
        env({
          MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
          MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${RETIRED_AT}`,
        })
      ),
    /is retired/
  );
});

test("a mistyped retirement id does not leave the previous key trusted", () => {
  // The regression this file previously failed to catch, and the third shape
  // this rule has taken.
  //
  // Ring `{sign-1, sign-2}`, active `sign-2`, and a retirement for `sign-l`
  // instead of `sign-1`. The earlier version reported the unknown id and
  // carried on, which left `sign-1` trusted for ever -- the approved fifteen
  // minutes did not apply, and a leaked previous key kept working. The version
  // before that threw, which answered 503 to everything.
  //
  // The rule now is about the key, not about the retirement line: a ring key
  // that is neither active nor explicitly retired verifies nothing. A typo
  // therefore makes the previous key stop verifying *immediately*, which is
  // stricter than the contract rather than laxer.
  const typo = env({ MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-l@${RETIRED_AT}` });

  assert.equal(mobileSigningKeyById("sign-1", typo, retiredAtMs), null);
  assert.equal(
    mobileSigningKeyById("sign-1", typo, Date.parse("2099-01-01T00:00:00Z")),
    null,
    "an undeclared key must never be trusted, at any time"
  );
  // And the deployment stays up: the active key still signs and verifies.
  assert.equal(activeMobileSigningKey(typo).keyId, "sign-2");
  assert.equal(mobileSigningKeyById("sign-2", typo)?.secret, KEY_B);
});

test("a mistyped pepper retirement is the same, and does not brick the ring", () => {
  const typo = env({ MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-l@${RETIRED_AT}` });

  assert.equal(
    mobileRefreshPepperById("pep-1", typo, Date.parse("2099-01-01T00:00:00Z")),
    null
  );
  assert.equal(activeMobileRefreshPepper(typo).keyId, "pep-2");
  assert.equal(mobileRefreshPepperById("pep-2", typo)?.secret, KEY_B);
});

test("an undeclared ring key verifies nothing even with no retirement list at all", () => {
  // The plain case: somebody adds a key and forgets to say what it is for.
  // Before it becomes active it has signed nothing, so refusing it costs
  // nothing and is the safe default.
  assert.equal(mobileSigningKeyById("sign-1", env()), null);
  assert.equal(mobileSigningKeyById("sign-2", env())?.secret, KEY_B);
});

test("deleting a ring entry without its retirement line keeps the deployment up", () => {
  // The exact operational sequence the review found. Whichever order the two
  // deletions land in, mobile auth stays answerable.
  const ringDeletedFirst = env({
    MOBILE_AUTH_SIGNING_KEYS: `sign-2:${KEY_B}`,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${RETIRED_AT}`,
  });
  assert.equal(activeMobileSigningKey(ringDeletedFirst).keyId, "sign-2");
  assert.equal(mobileSigningKeyById("sign-1", ringDeletedFirst), null);

  const bothDeleted = env({
    MOBILE_AUTH_SIGNING_KEYS: `sign-2:${KEY_B}`,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  });
  assert.equal(activeMobileSigningKey(bothDeleted).keyId, "sign-2");
});

test("a malformed retirement is refused rather than read as 'never'", () => {
  for (const value of ["sign-1", "sign-1@", "sign-1@not-a-date", "@2026-01-01T00:00:00Z", `sign-1@${RETIRED_AT},sign-1@${RETIRED_AT}`]) {
    assert.throws(
      () => mobileSigningKeyById("sign-1", env({ MOBILE_AUTH_RETIRED_SIGNING_KEYS: value })),
      MobileAuthKeyringError,
      value
    );
  }
});

test("the active key needs no declaration, and everything else does", () => {
  // The whole rule in two assertions. The active key is declared by being
  // active; any other ring key has to say what it is, or it verifies nothing.
  const far = Date.parse("2099-01-01T00:00:00Z");
  assert.equal(mobileSigningKeyById("sign-2", env(), far)?.secret, KEY_B);
  assert.equal(mobileRefreshPepperById("pep-2", env(), far)?.secret, KEY_B);
  assert.equal(mobileSigningKeyById("sign-1", env(), far), null);
  assert.equal(mobileRefreshPepperById("pep-1", env(), far), null);
});
