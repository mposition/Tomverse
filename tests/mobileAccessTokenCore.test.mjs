// Section 5.2 of the N2 approval packet, as executable vectors.
//
// The vectors named V-something come from section 7 of
// .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md. Those
// that need a database (rotation, revocation, deletion) wait for the service
// layer; these are the ones that are decisions about a token and nothing else.
//
// Every case asserts a *failure reason* as well as a refusal, because "it was
// rejected" is satisfied by a verifier that rejects everything, and one that
// rejects for the wrong reason is one whose order has quietly changed.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_ACCESS_TOKEN_ALGORITHM,
  MOBILE_ACCESS_TOKEN_JOSE_TYPE,
  MOBILE_ACCESS_TOKEN_KIND,
} from "../lib/mobileAuthContract.ts";
import { verifyMobileAccessToken } from "../lib/mobileAccessTokenCore.ts";

const ISSUER = "https://tomverse.app";
const AUDIENCE = "mobile-api";
const NOW = 1_800_000_000;

const KEY = { kid: "k1", algorithm: MOBILE_ACCESS_TOKEN_ALGORITHM };

/** Records whether the signature port was reached, and with what. */
const ports = (options = {}) => {
  const calls = [];
  return {
    calls,
    lookupKey: (kid) => (options.unknownKid ? null : kid === "k1" ? KEY : null),
    verifySignature: (input) => {
      calls.push(input);
      return options.signatureValid !== false;
    },
  };
};

const claims = (overrides = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "user_1",
  did: "device_1",
  fid: "family_1",
  jti: "token_1",
  tkn: MOBILE_ACCESS_TOKEN_KIND,
  iat: NOW - 60,
  nbf: NOW - 60,
  exp: NOW + 540,
  ...overrides,
});

const parsed = (overrides = {}) => ({
  header: {
    typ: MOBILE_ACCESS_TOKEN_JOSE_TYPE,
    alg: MOBILE_ACCESS_TOKEN_ALGORITHM,
    kid: "k1",
    ...(overrides.header ?? {}),
  },
  claims: claims(overrides.claims ?? {}),
  signingInput: "header.payload",
  signature: new Uint8Array([1, 2, 3]),
});

const verify = (token, options = {}) =>
  verifyMobileAccessToken(token, {
    ports: options.ports ?? ports(),
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    nowSeconds: options.nowSeconds ?? NOW,
    skewSeconds: options.skewSeconds,
  });

// --- V1: the ordinary case ------------------------------------------------

test("V1 -- a well-formed current token verifies and yields its identity", () => {
  const verdict = verify(parsed());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.identity, {
    subject: "user_1",
    device: "device_1",
    family: "family_1",
    tokenId: "token_1",
    expiresAtSeconds: NOW + 540,
  });
});

// --- V2: forged signature -------------------------------------------------

test("V2 -- a bad signature is refused as such", () => {
  const verdict = verify(parsed(), { ports: ports({ signatureValid: false }) });
  assert.deepEqual(verdict, { ok: false, failure: "signature_invalid" });
});

// --- V3: expiry -----------------------------------------------------------

test("V3 -- an expired token is refused, and skew is the only grace", () => {
  const token = parsed();
  // One second past exp is still inside the skew allowance.
  assert.equal(verify(token, { nowSeconds: NOW + 541 }).ok, true);
  // Past exp + skew it is not.
  assert.deepEqual(verify(token, { nowSeconds: NOW + 540 + 60 }), {
    ok: false,
    failure: "expired",
  });
});

test("a token that is not yet valid is refused, within skew", () => {
  const token = parsed({ claims: { nbf: NOW + 30, iat: NOW + 30 } });
  assert.equal(verify(token).ok, true, "30s early is inside 60s of skew");
  assert.deepEqual(
    verify(parsed({ claims: { nbf: NOW + 120, iat: NOW - 60 } })),
    { ok: false, failure: "not_yet_valid" }
  );
});

test("a token issued in the future is refused", () => {
  assert.deepEqual(
    verify(parsed({ claims: { iat: NOW + 120, nbf: NOW - 60 } })),
    { ok: false, failure: "issued_in_future" }
  );
});

test("exp must be after iat", () => {
  assert.deepEqual(
    verify(parsed({ claims: { iat: NOW, exp: NOW } })),
    { ok: false, failure: "expiry_not_after_issuance" }
  );
});

// --- V4: wrong deployment -------------------------------------------------

test("V4 -- a token for another issuer is refused", () => {
  assert.deepEqual(verify(parsed({ claims: { iss: "https://evil.example" } })), {
    ok: false,
    failure: "issuer_mismatch",
  });
});

// --- V30 / V31: audience is an exact match, never a substring -------------

test("V30 -- an audience that merely starts with the expected one is refused", () => {
  for (const aud of ["mobile-api-other", "other-mobile-api", "mobile-ap"]) {
    assert.deepEqual(
      verify(parsed({ claims: { aud } })),
      { ok: false, failure: "audience_mismatch" },
      `${aud} must not satisfy an expected ${AUDIENCE}`
    );
  }
});

test("V31 -- an array audience matches element by element", () => {
  assert.equal(verify(parsed({ claims: { aud: ["other", AUDIENCE] } })).ok, true);
  assert.deepEqual(verify(parsed({ claims: { aud: ["other", "third"] } })), {
    ok: false,
    failure: "audience_mismatch",
  });
  // Not a string and not an array of strings: malformed, not "no audience".
  for (const aud of [[], [AUDIENCE, 1], {}, null, 42, ""]) {
    assert.deepEqual(
      verify(parsed({ claims: { aud } })),
      { ok: false, failure: "claim_missing_or_mistyped" },
      `${JSON.stringify(aud)} is a malformed aud`
    );
  }
});

// --- V4b / V4c: token kind and claim hygiene -----------------------------

test("V4b -- a token of another kind is refused even if otherwise perfect", () => {
  assert.deepEqual(verify(parsed({ claims: { tkn: "tomverse-mobile-refresh" } })), {
    ok: false,
    failure: "wrong_token_kind",
  });
});

test("V4c -- every required claim must be present and correctly typed", () => {
  for (const name of ["iss", "sub", "did", "fid", "jti", "tkn"]) {
    for (const bad of [undefined, "", 1, null, {}]) {
      assert.deepEqual(
        verify(parsed({ claims: { [name]: bad } })),
        { ok: false, failure: "claim_missing_or_mistyped" },
        `${name} = ${JSON.stringify(bad)}`
      );
    }
  }
  for (const name of ["iat", "nbf", "exp"]) {
    for (const bad of [undefined, "123", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(
        verify(parsed({ claims: { [name]: bad } })),
        { ok: false, failure: "claim_missing_or_mistyped" },
        `${name} = ${String(bad)}`
      );
    }
  }
});

// --- header: explicit typing and the algorithm the token does not choose --

test("the JOSE type must be the one this deployment mints", () => {
  assert.deepEqual(verify(parsed({ header: { typ: "JWT" } })), {
    ok: false,
    failure: "unexpected_jose_type",
  });
});

test("a missing or unknown kid is refused before any signature work", () => {
  const withoutKid = ports();
  assert.deepEqual(
    verifyMobileAccessToken(
      { ...parsed(), header: { typ: MOBILE_ACCESS_TOKEN_JOSE_TYPE, alg: MOBILE_ACCESS_TOKEN_ALGORITHM } },
      { ports: withoutKid, expectedIssuer: ISSUER, expectedAudience: AUDIENCE, nowSeconds: NOW }
    ),
    { ok: false, failure: "missing_kid" }
  );
  assert.equal(withoutKid.calls.length, 0);

  const unknown = ports({ unknownKid: true });
  assert.deepEqual(verify(parsed(), { ports: unknown }), {
    ok: false,
    failure: "unknown_kid",
  });
  assert.equal(unknown.calls.length, 0);
});

test("the algorithm the token names is never the one that decides", () => {
  // `alg: none` is the classic. So is an HMAC alg against an EdDSA key.
  for (const alg of ["none", "HS256", "RS256", undefined]) {
    assert.deepEqual(
      verify(parsed({ header: { alg } })),
      { ok: false, failure: "algorithm_mismatch" },
      `alg=${String(alg)}`
    );
  }
});

// --- the order itself -----------------------------------------------------

test("no claim is read before the signature is verified", () => {
  // Every claim is wrong at once. If the verifier looked at any of them first,
  // the failure would name a claim rather than the signature.
  const verdict = verify(
    parsed({
      claims: {
        iss: "https://evil.example",
        aud: "another",
        tkn: "something-else",
        sub: undefined,
        exp: NOW - 10_000,
      },
    }),
    { ports: ports({ signatureValid: false }) }
  );
  assert.deepEqual(verdict, { ok: false, failure: "signature_invalid" });
});

test("the signature port is reached exactly once, with the bytes it covers", () => {
  const p = ports();
  const token = parsed();
  verify(token, { ports: p });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].signingInput, "header.payload");
  assert.deepEqual(p.calls[0].signature, token.signature);
  assert.deepEqual(p.calls[0].key, KEY);
});

test("no verdict carries token material", () => {
  const verdict = verify(parsed());
  const serialised = JSON.stringify(verdict);
  for (const secret of ["header.payload", "1,2,3"]) {
    assert.equal(serialised.includes(secret), false);
  }
});
