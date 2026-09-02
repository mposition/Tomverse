import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  mintMobileRefreshToken,
  mobileOneTimeSecretDigest,
  mobileRefreshSecretMatches,
  parseMobileRefreshToken,
} from "../lib/mobileRefreshToken.ts";
import { decideMobileRefresh } from "../lib/mobileRefreshRotationCore.ts";

/**
 * The refresh token's two halves, and what each is worth on its own.
 *
 * Design D5, approved 2026-08-31. The *order* the comparison happens in lives
 * in tests/mobileRefreshRotationCore.test.mjs; what this file settles is that
 * the comparison itself is sound, and that the half of the token which is not a
 * secret really is worth nothing without the half that is.
 */

const PEPPER_1 = randomBytes(32).toString("base64url");
const PEPPER_2 = randomBytes(32).toString("base64url");

const env = (overrides = {}) => ({
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
  ...overrides,
});

test("a minted token round-trips, and the row never holds the secret", () => {
  const minted = mintMobileRefreshToken(env());
  const parsed = parseMobileRefreshToken(minted.token);

  assert.equal(parsed.recordId, minted.recordId);
  assert.equal(minted.pepperKid, "pep-1");
  assert.equal(
    mobileRefreshSecretMatches(
      { secret: parsed.secret, storedDigest: minted.secretDigest, pepperKid: "pep-1" },
      env()
    ),
    true
  );
  // What is stored must not contain what was presented, in either direction.
  assert.ok(!minted.secretDigest.includes(parsed.secret));
  assert.ok(!minted.token.includes(minted.secretDigest));
});

test("the record id alone matches nothing", () => {
  // The premise of D5's order: an attacker holding a leaked id has the front
  // half of the token and no way to get past step 2.
  const minted = mintMobileRefreshToken(env());
  for (const guess of [minted.recordId, "", "guess", minted.secretDigest]) {
    assert.equal(
      mobileRefreshSecretMatches(
        { secret: guess, storedDigest: minted.secretDigest, pepperKid: "pep-1" },
        env()
      ),
      false,
      guess
    );
  }
});

test("two mints never share a secret or an id", () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const minted = mintMobileRefreshToken(env());
    assert.ok(!seen.has(minted.recordId), "duplicate record id");
    assert.ok(!seen.has(minted.secretDigest), "duplicate digest");
    seen.add(minted.recordId);
    seen.add(minted.secretDigest);
  }
});

test("a row under a retired pepper still verifies while that pepper is in the ring", () => {
  // D6's asymmetry, from the refresh side: retiring a pepper on the signing
  // key's schedule would sign every account out, so the old generation stays
  // verifiable and drains.
  const minted = mintMobileRefreshToken(env());
  const afterRotation = env({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1},pep-2:${PEPPER_2}`,
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
    // The retirement line is what keeps the old generation verifiable. Without
    // it a ring pepper that is not active verifies nothing -- which is why the
    // rotation runbook treats this line as part of the rotation, not a
    // follow-up.
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${new Date().toISOString()}`,
  });

  assert.equal(
    mobileRefreshSecretMatches(
      {
        secret: parseMobileRefreshToken(minted.token).secret,
        storedDigest: minted.secretDigest,
        pepperKid: minted.pepperKid,
      },
      afterRotation
    ),
    true
  );
  // And a fresh mint moves to the current generation, which is what makes the
  // old one drain rather than being cut off.
  assert.equal(mintMobileRefreshToken(afterRotation).pepperKid, "pep-2");
});

test("a pepper this deployment no longer holds refuses rather than retrying under the active one", () => {
  // Retrying would compare a digest against a key it was never computed with,
  // report a legitimate token as forged, and under D8 destroy the family.
  const minted = mintMobileRefreshToken(env());
  const dropped = env({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER_2}`,
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  });

  assert.equal(
    mobileRefreshSecretMatches(
      {
        secret: parseMobileRefreshToken(minted.token).secret,
        storedDigest: minted.secretDigest,
        pepperKid: "pep-1",
      },
      dropped
    ),
    false
  );
});

test("a digest of a different length is refused before the constant-time compare", () => {
  // timingSafeEqual throws on a length mismatch, so a stored value of another
  // shape has to be caught first or the refusal becomes a 500.
  const minted = mintMobileRefreshToken(env());
  const secret = parseMobileRefreshToken(minted.token).secret;
  for (const storedDigest of ["", "abc", `${minted.secretDigest}00`]) {
    assert.equal(
      mobileRefreshSecretMatches({ secret, storedDigest, pepperKid: "pep-1" }, env()),
      false,
      storedDigest
    );
  }
});

test("a token shaped like anything but two segments is not a refresh token", () => {
  // Three segments is an access token, and accepting one here would let a
  // token minted for one purpose be replayed into the other.
  for (const value of ["", "onlyone", "a.b.c", ".b", "a.", "a..b", null, undefined, 7]) {
    assert.equal(parseMobileRefreshToken(value), null, String(value));
  }
});

test("a wrong secret on a consumed record leaves the family alone, end to end", () => {
  // The same branch V24b covers with a stubbed comparison, driven here by the
  // real one: knowing a consumed record's id must not be a way to destroy a
  // family, and the two halves of that guarantee live in different files.
  const minted = mintMobileRefreshToken(env());
  const record = {
    id: minted.recordId,
    familyId: "family_1",
    pepperKid: minted.pepperKid,
    expiresAtMs: Date.now() + 86_400_000,
    consumedAtMs: Date.now() - 1_000,
    invalidatedAtMs: null,
  };

  const decision = decideMobileRefresh({
    record,
    secretMatches: (row) =>
      mobileRefreshSecretMatches(
        { secret: "not-the-secret", storedDigest: minted.secretDigest, pepperKid: row.pepperKid },
        env()
      ),
    family: null,
    nowMs: Date.now(),
    idleWindowMs: 30 * 86_400_000,
  });

  assert.deepEqual(decision, { kind: "reject", reason: "secret_mismatch" });
});

test("one-time secrets are digested with the same discipline", () => {
  // A login grant is the same kind of thing as a refresh token -- a one-time
  // bearer secret whose plaintext is never stored -- so it shares the ring
  // rather than acquiring a second rotation schedule for the same property.
  const secret = randomBytes(32).toString("base64url");
  const digest = mobileOneTimeSecretDigest(secret, env());

  assert.equal(mobileOneTimeSecretDigest(secret, env()), digest);
  assert.ok(!digest.includes(secret));
  assert.notEqual(
    mobileOneTimeSecretDigest(
      secret,
      env({
        MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER_2}`,
        MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
      })
    ),
    digest
  );
});

test("a pepper rotation that forgets the retirement line strands the old generation", () => {
  // Recorded rather than smoothed over. The safe default costs something here:
  // those refresh tokens stop verifying and those people sign in again. It is
  // still the right default -- the alternative is trusting a pepper nobody has
  // declared -- and `npm run check:mobile-auth-keyring` exists so this is found
  // before a deploy.
  const minted = mintMobileRefreshToken(env());
  const undeclared = env({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1},pep-2:${PEPPER_2}`,
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  });

  assert.equal(
    mobileRefreshSecretMatches(
      {
        secret: parseMobileRefreshToken(minted.token).secret,
        storedDigest: minted.secretDigest,
        pepperKid: "pep-1",
      },
      undeclared
    ),
    false
  );
  // A refusal, not a family destruction: the caller sees secret_mismatch and
  // the person signs in again.
  assert.equal(mintMobileRefreshToken(undeclared).pepperKid, "pep-2");
});
