import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";

import {
  bearerTokenFromHeader,
  mintMobileAccessToken,
  parseCompactJws,
  verifyMobileAccessTokenString,
} from "../lib/mobileAccessToken.ts";
import { MOBILE_ACCESS_TOKEN_TTL_SECONDS } from "../lib/mobileAuthContract.ts";

/**
 * The crypto boundary: real Ed25519 keys, real signatures, the real sequence.
 *
 * `tests/mobileAccessTokenCore.test.mjs` beside this one settles the *order* of
 * the decision with injected ports. This settles that the ports it is given in
 * production actually do what the order assumes -- that a token this deployment
 * mints verifies, and that every way of altering one does not.
 *
 * Design D1 and section 5.2, approved 2026-08-31.
 */

const ed25519 = () =>
  generateKeyPairSync("ed25519").privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");

const SIGN_1 = ed25519();
const SIGN_2 = ed25519();
const PEPPER = randomBytes(32).toString("base64url");

const env = (overrides = {}) => ({
  MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-1",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-1",
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.app",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
  ...overrides,
});

const NOW = new Date("2026-08-31T12:00:00.000Z");
const SUBJECT = { userId: "user_1", deviceId: "device_1", familyId: "family_1" };

const mint = (environment = env(), now = NOW) =>
  mintMobileAccessToken({ ...SUBJECT, now }, environment);

test("a token this deployment mints verifies, and carries the identity back", () => {
  const minted = mint();
  const verdict = verifyMobileAccessTokenString(minted.token, {
    now: NOW,
    environment: env(),
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.identity.subject, "user_1");
  assert.equal(verdict.identity.device, "device_1");
  assert.equal(verdict.identity.family, "family_1");
  assert.equal(verdict.identity.tokenId, minted.tokenId);
  assert.equal(minted.expiresIn, MOBILE_ACCESS_TOKEN_TTL_SECONDS);
});

test("the header says at+jwt and names the key, and the payload says its own kind", () => {
  const parsed = parseCompactJws(mint().token);
  assert.equal(parsed.header.typ, "at+jwt");
  assert.equal(parsed.header.alg, "EdDSA");
  assert.equal(parsed.header.kid, "sign-1");
  // Two names on purpose: rev.2 of the design records that one name for both
  // let the two halves drift to different values unnoticed.
  assert.equal(parsed.claims.tkn, "tomverse-mobile-access");
  assert.equal(parsed.claims.iat, parsed.claims.nbf);
  assert.equal(parsed.claims.exp - parsed.claims.iat, MOBILE_ACCESS_TOKEN_TTL_SECONDS);
});

test("a token signed by another deployment's key is refused, not merely unknown", () => {
  // Same kid, different key material: the only thing that separates these two
  // deployments is the signature, so this is the case the whole scheme rests on.
  const other = env({ MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_2}` });
  const forged = mint(other);

  const verdict = verifyMobileAccessTokenString(forged.token, {
    now: NOW,
    environment: env(),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failure, "signature_invalid");
});

test("a retired key still verifies its own tokens while the new one signs", () => {
  const beforeRotation = mint();
  const afterRotation = env({
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  });

  assert.equal(
    verifyMobileAccessTokenString(beforeRotation.token, {
      now: NOW,
      environment: afterRotation,
    }).ok,
    true
  );
  assert.equal(parseCompactJws(mint(afterRotation).token).header.kid, "sign-2");
});

test("dropping the key from the ring is how those tokens stop working", () => {
  const minted = mint();
  const verdict = verifyMobileAccessTokenString(minted.token, {
    now: NOW,
    environment: env({ MOBILE_AUTH_SIGNING_KEYS: `sign-2:${SIGN_2}` }),
  });
  assert.equal(verdict.failure, "unknown_kid");
});

test("editing a claim invalidates the signature that covered it", () => {
  const [header, , signature] = mint().token.split(".");
  const tampered = Buffer.from(
    JSON.stringify({
      iss: "https://tomverse.app",
      aud: "tomverse-mobile-api",
      sub: "someone_else",
      did: "device_1",
      fid: "family_1",
      jti: "j",
      tkn: "tomverse-mobile-access",
      iat: Math.floor(NOW.getTime() / 1000),
      nbf: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 600,
    }),
    "utf8"
  ).toString("base64url");

  const verdict = verifyMobileAccessTokenString(
    `${header}.${tampered}.${signature}`,
    { now: NOW, environment: env() }
  );
  assert.equal(verdict.failure, "signature_invalid");
});

test("an unsecured JWT is malformed here rather than a token with no signature", () => {
  // alg:none is the classic. It never reaches the algorithm check, because a
  // two-segment token is not a compact JWS at all.
  const [header, claims] = mint().token.split(".");
  for (const token of [
    `${header}.${claims}`,
    `${header}.${claims}.`,
    `${header}.${claims}.a.b`,
    "not-a-token",
    "",
  ]) {
    assert.equal(
      verifyMobileAccessTokenString(token, { now: NOW, environment: env() }).failure,
      "malformed",
      token
    );
  }
});

test("a token for another audience or issuer is refused by exact match", () => {
  const otherAudience = mint(env({ MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api-other" }));
  assert.equal(
    verifyMobileAccessTokenString(otherAudience.token, { now: NOW, environment: env() })
      .failure,
    "audience_mismatch"
  );

  const otherIssuer = mint(env({ MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.app.evil" }));
  assert.equal(
    verifyMobileAccessTokenString(otherIssuer.token, { now: NOW, environment: env() })
      .failure,
    "issuer_mismatch"
  );
});

test("expiry is judged against the clock it is given, with the approved skew", () => {
  const minted = mint();
  const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);

  assert.equal(
    verifyMobileAccessTokenString(minted.token, { now: at(599), environment: env() }).ok,
    true
  );
  // Ten minutes plus the sixty-second skew is still inside; one second past is not.
  assert.equal(
    verifyMobileAccessTokenString(minted.token, { now: at(659), environment: env() }).ok,
    true
  );
  assert.equal(
    verifyMobileAccessTokenString(minted.token, { now: at(660), environment: env() })
      .failure,
    "expired"
  );
  // `not_yet_valid` rather than `issued_in_future`, and that is the minter
  // being honest: it sets `nbf` equal to `iat`, so the `nbf` check is reached
  // first and no token this file can produce distinguishes the two. The
  // `issued_in_future` branch is exercised where a token with `iat > nbf` can
  // actually be constructed, in tests/mobileAccessTokenCore.test.mjs.
  assert.equal(
    verifyMobileAccessTokenString(minted.token, { now: at(-61), environment: env() })
      .failure,
    "not_yet_valid"
  );
  assert.equal(
    verifyMobileAccessTokenString(minted.token, { now: at(-60), environment: env() }).ok,
    true
  );
});

test("two mints of the same identity are different tokens", () => {
  // `jti` is per token, so a replay is distinguishable from a reissue even when
  // every other claim matches.
  const first = mint();
  const second = mint();
  assert.notEqual(first.tokenId, second.tokenId);
  assert.notEqual(first.token, second.token);
});

test("the bearer header is parsed by scheme, and 'no header' stays distinct from 'bad header'", () => {
  assert.equal(bearerTokenFromHeader("Bearer abc"), "abc");
  assert.equal(bearerTokenFromHeader("bearer abc"), "abc");
  assert.equal(bearerTokenFromHeader("  Bearer   abc  "), "abc");
  // Null is "fall through to the cookie path"; the caller turns a present but
  // unusable header into a 401 with no fallback (design 5.1.4).
  assert.equal(bearerTokenFromHeader(null), null);
  assert.equal(bearerTokenFromHeader("Basic abc"), null);
  assert.equal(bearerTokenFromHeader("Bearer"), null);
  assert.equal(bearerTokenFromHeader("Bearer a b"), null);
});

test("no verdict and no minted value carries key material", () => {
  const minted = mint();
  const serialized = JSON.stringify({
    minted: { expiresIn: minted.expiresIn, tokenId: minted.tokenId },
    ok: verifyMobileAccessTokenString(minted.token, { now: NOW, environment: env() }),
    bad: verifyMobileAccessTokenString("x.y.z", { now: NOW, environment: env() }),
  });
  for (const secret of [SIGN_1, SIGN_2, PEPPER]) {
    assert.ok(!serialized.includes(secret));
  }
  assert.ok(!serialized.includes(minted.token));
});
