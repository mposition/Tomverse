import "server-only";

/**
 * Minting and verifying mobile access tokens.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D1 (JWS + EdDSA, `kid` required, the token's own `alg` never trusted) and
 * section 5.2 (the verification sequence), approved 2026-08-31.
 *
 * The *decision* is not here. `lib/mobileAccessTokenCore.ts` holds it, without
 * crypto and without an environment, so the order of its steps can be tested
 * rather than reviewed. This file is the boundary: it does the two things that
 * are not decisions -- parsing compact JWS, and Ed25519 -- and hands them over
 * as ports.
 *
 * That split is why `verifySignature` is a function passed *into* the core and
 * called from inside step 3. If this file verified the signature and then
 * handed the core a boolean, a future edit here could compute that boolean
 * after reading a claim, and the core would have no way to know.
 *
 * Node-only. `node:crypto` and `server-only` both keep it out of any client
 * bundle; proxy may import it because Proxy runs on the Node.js runtime in
 * Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`).
 */

import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";

import {
  MOBILE_ACCESS_TOKEN_ALGORITHM,
  MOBILE_ACCESS_TOKEN_JOSE_TYPE,
  MOBILE_ACCESS_TOKEN_KIND,
  MOBILE_ACCESS_TOKEN_TTL_SECONDS,
} from "@/lib/mobileAuthContract";
import {
  activeMobileSigningKey,
  mobileSigningKeyById,
  mobileTokenAudience,
  mobileTokenIssuer,
} from "@/lib/mobileAuthKeyring";
import {
  verifyMobileAccessToken,
  type MobileAccessTokenVerdict,
  type MobileAccessTokenVerifierPorts,
  type ParsedCompactJws,
} from "@/lib/mobileAccessTokenCore";

type Environment = Record<string, string | undefined>;

const encodeSegment = (value: Buffer | string) =>
  Buffer.from(value as never).toString("base64url");

const encodeJson = (value: unknown) =>
  encodeSegment(Buffer.from(JSON.stringify(value), "utf8"));

/**
 * A JSON object from one base64url segment, or null.
 *
 * Null covers every way a segment can fail to be a JSON object -- bad base64,
 * bad JSON, a number, an array, `null`. The caller turns all of them into
 * `malformed`, because telling them apart tells a forger which byte to fix.
 */
const decodeJsonObject = (segment: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8")
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const privateKeyFrom = (base64Pkcs8: string) =>
  createPrivateKey({
    key: Buffer.from(base64Pkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });

/**
 * The ports the core calls, bound to this deployment's keyring.
 *
 * `lookupKey` answers only with an id and an algorithm -- never key material.
 * The core has no use for the bytes and no way to leak what it never holds.
 */
const verifierPorts = (environment: Environment): MobileAccessTokenVerifierPorts => ({
  lookupKey: (kid) =>
    mobileSigningKeyById(kid, environment)
      ? { kid, algorithm: MOBILE_ACCESS_TOKEN_ALGORITHM }
      : null,
  verifySignature: ({ key, signingInput, signature }) => {
    const entry = mobileSigningKeyById(key.kid, environment);
    if (!entry) return false;
    try {
      // The public half is derived from the configured private key rather than
      // configured beside it: a deployment cannot then hold a public key that
      // does not match what it signs with.
      const publicKey = createPublicKey(privateKeyFrom(entry.secret));
      // `null` algorithm is how node:crypto expresses Ed25519, whose hash is
      // part of the scheme rather than a parameter.
      return verify(null, Buffer.from(signingInput, "utf8"), publicKey, signature);
    } catch {
      // A key that will not parse verifies nothing. Refusing is the only safe
      // reading: the alternative is treating a configuration error as a valid
      // signature.
      return false;
    }
  },
});

export type MintedMobileAccessToken = {
  token: string;
  /** Seconds until expiry, for the client's own scheduling. */
  expiresIn: number;
  expiresAt: Date;
  /** `jti`, so the caller can correlate without holding the token. */
  tokenId: string;
};

/**
 * Signs an access token for one device's family.
 *
 * `nbf` equals `iat`: this token is usable the moment it is issued, and a
 * deliberate delay would only be a way for the two to disagree.
 */
export const mintMobileAccessToken = (
  input: {
    userId: string;
    deviceId: string;
    familyId: string;
    now?: Date;
  },
  environment: Environment = process.env
): MintedMobileAccessToken => {
  const key = activeMobileSigningKey(environment);
  const issuedAt = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const expiresAtSeconds = issuedAt + MOBILE_ACCESS_TOKEN_TTL_SECONDS;
  const tokenId = randomUUID();

  const header = encodeJson({
    alg: MOBILE_ACCESS_TOKEN_ALGORITHM,
    typ: MOBILE_ACCESS_TOKEN_JOSE_TYPE,
    kid: key.keyId,
  });
  const claims = encodeJson({
    iss: mobileTokenIssuer(environment),
    aud: mobileTokenAudience(environment),
    sub: input.userId,
    did: input.deviceId,
    fid: input.familyId,
    jti: tokenId,
    tkn: MOBILE_ACCESS_TOKEN_KIND,
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAtSeconds,
  });
  const signingInput = `${header}.${claims}`;
  const signature = sign(
    null,
    Buffer.from(signingInput, "utf8"),
    privateKeyFrom(key.secret)
  );

  return {
    token: `${signingInput}.${signature.toString("base64url")}`,
    expiresIn: MOBILE_ACCESS_TOKEN_TTL_SECONDS,
    expiresAt: new Date(expiresAtSeconds * 1000),
    tokenId,
  };
};

/**
 * Splits a compact JWS into the parts the core judges.
 *
 * Exactly three segments, each non-empty. A five-segment JWE and a two-segment
 * unsecured JWT are both `malformed` here rather than reaching a branch that
 * has to decide what to do with them.
 */
export const parseCompactJws = (token: string): ParsedCompactJws | null => {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [headerSegment, claimsSegment, signatureSegment] = segments;
  if (!headerSegment || !claimsSegment || !signatureSegment) return null;

  const header = decodeJsonObject(headerSegment);
  const claims = decodeJsonObject(claimsSegment);
  if (!header || !claims) return null;

  const signature = Buffer.from(signatureSegment, "base64url");
  if (signature.length === 0) return null;

  return {
    header,
    claims,
    signingInput: `${headerSegment}.${claimsSegment}`,
    signature,
  };
};

/**
 * The whole verification, from a header value to a verdict.
 *
 * Takes the raw token rather than an `Authorization` header: deciding whether
 * a header is a bearer header is the caller's job, and a function that accepted
 * both shapes would eventually be handed the wrong one.
 */
export const verifyMobileAccessTokenString = (
  token: string,
  options: { now?: Date; environment?: Environment } = {}
): MobileAccessTokenVerdict => {
  const environment = options.environment ?? process.env;
  const parsed = parseCompactJws(token);
  if (!parsed) return { ok: false, failure: "malformed" };

  return verifyMobileAccessToken(parsed, {
    ports: verifierPorts(environment),
    expectedIssuer: mobileTokenIssuer(environment),
    expectedAudience: mobileTokenAudience(environment),
    nowSeconds: Math.floor((options.now?.getTime() ?? Date.now()) / 1000),
  });
};

/**
 * The token out of an `Authorization` header, or null.
 *
 * Case-insensitive on the scheme, because RFC 7235 says the scheme is, and
 * strict about everything else. Returning null for "there is no bearer header"
 * keeps that case distinct from "there is one and it is wrong": the first falls
 * through to the cookie path, the second is a 401 with no fallback (5.1.4).
 */
export const bearerTokenFromHeader = (header: string | null): string | null => {
  if (!header) return null;
  const match = /^Bearer[ ]+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};
