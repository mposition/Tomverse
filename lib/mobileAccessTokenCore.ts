// Whether a mobile access token is what it claims to be.
//
// Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
// section 5.2, approved 2026-08-31.
//
// ## Why the order is in this file rather than in its caller
//
// Section 5.2 is not a list of checks, it is a *sequence*. Everything after the
// signature step reads values an attacker wrote, so a verifier that inspects a
// claim before verifying the signature has already lost -- it is making a
// decision on attacker-supplied input and calling it authentication.
//
// Leaving that order to the caller means it is correct until someone reorders
// two lines for readability. So the sequence lives here, the crypto is injected
// as a port, and the port is called from inside step 3 rather than by whoever
// assembled the arguments. A caller cannot check a claim early because it never
// holds the claims until this function returns them.
//
// ## What a `pass` verdict means, and what it does not
//
// It means: cryptographically verified, correctly typed, in date, addressed to
// this deployment. That is enough to *replace the mutation-origin check*,
// because a bearer token is not an ambient credential and CSRF has no purchase
// on it.
//
// It is not authorization. Whether the account still exists, whether the family
// was revoked, whether the device was released, whether the user owns the row
// they are touching -- none of that is here, and all of it is checked again by
// the route (packet D2 and D12).
//
// No token material appears in any verdict. A caller logging the whole verdict
// must not thereby log a credential.

import {
  MOBILE_ACCESS_TOKEN_ALGORITHM,
  MOBILE_ACCESS_TOKEN_JOSE_TYPE,
  MOBILE_ACCESS_TOKEN_KIND,
  MOBILE_CLOCK_SKEW_SECONDS,
} from "@/lib/mobileAuthContract";

/** Why a token was refused. Machine-readable, carries no token bytes. */
export type MobileAccessTokenFailure =
  | "malformed"
  | "unexpected_jose_type"
  | "missing_kid"
  | "unknown_kid"
  | "algorithm_mismatch"
  | "signature_invalid"
  | "claim_missing_or_mistyped"
  | "wrong_token_kind"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "not_yet_valid"
  | "issued_in_future"
  | "expired"
  | "expiry_not_after_issuance";

export type MobileAccessTokenIdentity = {
  /** `sub` -- the account. */
  subject: string;
  /** `did` -- the device record. */
  device: string;
  /** `fid` -- the token family. */
  family: string;
  /** `jti` -- this token, for correlation and replay reporting. */
  tokenId: string;
  /**
   * `iat`, in seconds, as the token states it.
   *
   * Returned because the authorization layer needs it: a global sign-out
   * stamps `User.sessionsRevokedAt`, and the only way to tell a token minted
   * before that stamp from one minted after is to compare against when it was
   * issued. Safe to expose only because it is read *after* the signature
   * check, like every other claim here.
   */
  issuedAtSeconds: number;
  /** `exp`, in seconds, as the token states it. */
  expiresAtSeconds: number;
};

export type MobileAccessTokenVerdict =
  | { ok: true; identity: MobileAccessTokenIdentity }
  | { ok: false; failure: MobileAccessTokenFailure };

/**
 * A parsed compact JWS, before anything about it is believed.
 *
 * Parsing is the caller's (it needs base64url and JSON, neither of which is a
 * decision), but *nothing else* is: the caller hands over the three parts and
 * gets back a verdict.
 */
export type ParsedCompactJws = {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** The exact `header.payload` bytes the signature covers. */
  signingInput: string;
  /** The decoded signature. */
  signature: Uint8Array;
};

export type MobileAccessVerificationKey = {
  kid: string;
  /** The algorithm this key is for. The token's own `alg` is never trusted. */
  algorithm: string;
};

export type MobileAccessTokenVerifierPorts = {
  /** Returns the key for a `kid`, or null when it is not one this deployment knows. */
  lookupKey: (kid: string) => MobileAccessVerificationKey | null;
  /** Constant-time signature verification. Called only from step 3. */
  verifySignature: (input: {
    key: MobileAccessVerificationKey;
    signingInput: string;
    signature: Uint8Array;
  }) => boolean;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * `aud` as an exact-match list.
 *
 * A string, or an array of strings, and nothing else. Returns null for any
 * other shape so the caller refuses rather than coercing -- an `aud` of `{}` or
 * `["a", 1]` is a malformed token, not an empty audience.
 */
const audienceList = (value: unknown): string[] | null => {
  if (isNonEmptyString(value)) return [value];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString)
  ) {
    return value as string[];
  }
  return null;
};

const fail = (failure: MobileAccessTokenFailure): MobileAccessTokenVerdict => ({
  ok: false,
  failure,
});

/**
 * Section 5.2, steps 2 through 5, in that order.
 *
 * `nowSeconds` is passed in rather than read from a clock so the whole decision
 * is a function of its arguments and every vector in section 7 can be written
 * without waiting for time to pass.
 */
export const verifyMobileAccessToken = (
  parsed: ParsedCompactJws,
  options: {
    ports: MobileAccessTokenVerifierPorts;
    expectedIssuer: string;
    expectedAudience: string;
    nowSeconds: number;
    skewSeconds?: number;
  }
): MobileAccessTokenVerdict => {
  const skew = options.skewSeconds ?? MOBILE_CLOCK_SKEW_SECONDS;

  // --- 2. header: media type and key -------------------------------------
  if (parsed.header.typ !== MOBILE_ACCESS_TOKEN_JOSE_TYPE) {
    return fail("unexpected_jose_type");
  }
  const kid = parsed.header.kid;
  if (!isNonEmptyString(kid)) return fail("missing_kid");

  const key = options.ports.lookupKey(kid);
  if (!key) return fail("unknown_kid");

  // The token says which algorithm verified it; that claim is the attacker's.
  // Compare against the key's own algorithm, and require it to be the one
  // algorithm this deployment uses -- so a key record that somehow named
  // something else cannot widen what is accepted.
  if (
    key.algorithm !== MOBILE_ACCESS_TOKEN_ALGORITHM ||
    parsed.header.alg !== key.algorithm
  ) {
    return fail("algorithm_mismatch");
  }

  // --- 3. signature -------------------------------------------------------
  //
  // Nothing below this line was worth reading before it.
  if (
    !options.ports.verifySignature({
      key,
      signingInput: parsed.signingInput,
      signature: parsed.signature,
    })
  ) {
    return fail("signature_invalid");
  }

  // --- 4. claim presence and type ----------------------------------------
  const c = parsed.claims;
  for (const name of ["iss", "sub", "did", "fid", "jti", "tkn"]) {
    if (!isNonEmptyString(c[name])) return fail("claim_missing_or_mistyped");
  }
  for (const name of ["iat", "nbf", "exp"]) {
    if (!isFiniteNumber(c[name])) return fail("claim_missing_or_mistyped");
  }
  const audiences = audienceList(c.aud);
  if (!audiences) return fail("claim_missing_or_mistyped");

  // --- 5. values ----------------------------------------------------------
  if (c.tkn !== MOBILE_ACCESS_TOKEN_KIND) return fail("wrong_token_kind");
  if (c.iss !== options.expectedIssuer) return fail("issuer_mismatch");
  // Exact match, element by element. Never a substring or a prefix: an expected
  // `mobile-api` must not accept a token minted for `mobile-api-other`.
  if (!audiences.some((audience) => audience === options.expectedAudience)) {
    return fail("audience_mismatch");
  }

  const iat = c.iat as number;
  const nbf = c.nbf as number;
  const exp = c.exp as number;

  if (options.nowSeconds < nbf - skew) return fail("not_yet_valid");
  if (options.nowSeconds < iat - skew) return fail("issued_in_future");
  if (options.nowSeconds >= exp + skew) return fail("expired");
  if (exp <= iat) return fail("expiry_not_after_issuance");

  return {
    ok: true,
    identity: {
      subject: c.sub as string,
      device: c.did as string,
      family: c.fid as string,
      tokenId: c.jti as string,
      issuedAtSeconds: iat,
      expiresAtSeconds: exp,
    },
  };
};
