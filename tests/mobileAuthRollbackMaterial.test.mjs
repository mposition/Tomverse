import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";

import {
  mintMobileAccessToken,
  verifyMobileAccessTokenString,
} from "../lib/mobileAccessToken.ts";
import {
  mintMobileRefreshToken,
  mobileRefreshSecretMatches,
  parseMobileRefreshToken,
} from "../lib/mobileRefreshToken.ts";
import { decideMobileRefresh } from "../lib/mobileRefreshRotationCore.ts";
import { MOBILE_PREVIOUS_SIGNING_KEY_SECONDS } from "../lib/mobileAuthContract.ts";

/**
 * What a deployment answers when the material it holds is not the material
 * that minted the token in front of it.
 *
 * X10 · X10a of
 * .github/audits/2026-09-09-mobile-auth-undetermined-signing-half-approval.md,
 * plus the grace boundary the classifier's case-2 branch depends on. Real
 * mint, real verify, real refresh judgement, synthetic rings.
 *
 * **What these prove, exactly.** The server's behaviour after its material is
 * restored -- which verdict each half returns. They do NOT prove:
 *
 *   * that a rollback happened, or that E7 is measured. No deployment, no
 *     credentials and no store are touched here; the rings are two objects in
 *     this file;
 *   * that a person gets back into the app. Whether `unknown_kid` becomes a
 *     silent refresh or a sign-in screen is the bridge's renewal policy, which
 *     G11 leaves open.
 *
 * An earlier revision of that packet said these two vectors needed the same
 * permission as E7's measurement. They do not: nothing below has any.
 */

const ed25519 = () =>
  generateKeyPairSync("ed25519").privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");

const SIGN_1 = ed25519();
const SIGN_2 = ed25519();
const PEP_1 = randomBytes(32).toString("base64url");
const PEP_2 = randomBytes(32).toString("base64url");

const NOW = new Date("2026-09-10T12:00:00.000Z");
const SUBJECT = { userId: "user_1", deviceId: "device_1", familyId: "family_1" };

const NAMES = {
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.app",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
};

/** The ring an F2 rollback puts back: the previous generation, alone. */
const restored = {
  ...NAMES,
  MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-1",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEP_1}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
};

/** The ring that was rolled forward, in the two rotation shapes. */
const rolledForwardSigningOnly = {
  ...NAMES,
  MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEP_1}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
};
const rolledForwardBoth = {
  ...rolledForwardSigningOnly,
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEP_1},pep-2:${PEP_2}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
};

const accessVerdict = (environment, mintedWith) => {
  const minted = mintMobileAccessToken({ ...SUBJECT, now: NOW }, mintedWith);
  const verdict = verifyMobileAccessTokenString(minted.token, {
    now: NOW,
    environment,
  });
  return verdict.ok ? "accepted" : verdict.failure;
};

/**
 * The refresh half, judged by the real decision function.
 *
 * The row is built from what the mint returned, which is what the endpoint
 * writes: the digest and the pepper generation it was computed under. Nothing
 * about the family is in question here, so every state field is the healthy
 * one -- a rejection below can only come from the material.
 */
const refreshVerdict = (environment, mintedWith) => {
  const minted = mintMobileRefreshToken(mintedWith);
  const parsed = parseMobileRefreshToken(minted.token);
  const record = {
    id: parsed.recordId,
    familyId: "family_1",
    secretDigest: minted.secretDigest,
    pepperKid: minted.pepperKid,
    expiresAtMs: NOW.getTime() + 30 * 24 * 3_600 * 1_000,
    consumedAtMs: null,
    invalidatedAtMs: null,
  };
  const decision = decideMobileRefresh({
    record,
    secretMatches: (row) =>
      mobileRefreshSecretMatches(
        {
          secret: parsed.secret,
          storedDigest: row.secretDigest,
          pepperKid: row.pepperKid,
        },
        environment
      ),
    family: {
      familyId: "family_1",
      deviceId: "device_1",
      userId: "user_1",
      createdAtMs: NOW.getTime() - 1_000,
      lastRotatedAtMs: NOW.getTime() - 1_000,
      absoluteExpiresAtMs: NOW.getTime() + 90 * 24 * 3_600 * 1_000,
      revokedAtMs: null,
      deviceRevokedAtMs: null,
      accountStatus: "active",
    },
    nowMs: NOW.getTime(),
    idleWindowMs: 30 * 24 * 3_600 * 1_000,
  });
  return decision.kind === "reject" ? decision.reason : decision.kind;
};

test("X10: after a signing-only rollback, access is unknown_kid and refresh still rotates", () => {
  // The recovery path survives: the pepper never moved, so the token the
  // device holds is still the one this deployment can check, and it can mint
  // a successor under the restored signing key.
  assert.equal(accessVerdict(restored, rolledForwardSigningOnly), "unknown_kid");
  assert.equal(refreshVerdict(restored, rolledForwardSigningOnly), "rotate");
});

test("X10a: after a signing-and-pepper rollback, refresh is secret_mismatch", () => {
  // The row names a pepper generation the restored deployment does not hold.
  // It is refused rather than retried under the active pepper -- retrying
  // would report a legitimate token as forged, and D8 destroys a family for
  // that. So this is the sign-in-again shape, and the family is left alone.
  assert.equal(accessVerdict(restored, rolledForwardBoth), "unknown_kid");
  assert.equal(refreshVerdict(restored, rolledForwardBoth), "secret_mismatch");
});

test("the previous signing key verifies to the last second of its grace, and not past it", () => {
  // The boundary the classifier's case-2 branch rests on: a refusal at or
  // after this instant is the contract working, so it is not a rollback
  // reason. `withinGrace` is exclusive -- +899s accepts, +900s does not.
  const retiredAt = new Date("2026-09-10T00:00:00.000Z");
  const before = {
    ...NAMES,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1}`,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-1",
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEP_1}`,
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
  };
  const after = {
    ...rolledForwardSigningOnly,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${retiredAt.toISOString()}`,
  };

  // Minted late enough that its own `exp` outlives the window: otherwise the
  // token expires first and the boundary under test is never reached. That is
  // itself worth knowing -- the access TTL is shorter than the grace, so in a
  // real deployment the last token the previous key signed is `expired`, not
  // `unknown_kid`, well before +900s.
  const minted = mintMobileAccessToken(
    { ...SUBJECT, now: new Date(retiredAt.getTime() + 500 * 1_000) },
    before
  );
  const at = (offsetSeconds) =>
    verifyMobileAccessTokenString(minted.token, {
      now: new Date(retiredAt.getTime() + offsetSeconds * 1_000),
      environment: after,
    });

  assert.equal(MOBILE_PREVIOUS_SIGNING_KEY_SECONDS, 900);
  assert.equal(at(MOBILE_PREVIOUS_SIGNING_KEY_SECONDS - 1).ok, true);
  assert.equal(at(MOBILE_PREVIOUS_SIGNING_KEY_SECONDS).failure, "unknown_kid");
  assert.equal(at(MOBILE_PREVIOUS_SIGNING_KEY_SECONDS + 1).failure, "unknown_kid");
});
