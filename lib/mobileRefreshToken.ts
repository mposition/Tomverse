import "server-only";

/**
 * Minting, parsing and comparing mobile refresh tokens.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D5, approved 2026-08-31.
 *
 * The token is `<recordId>.<secret>`.
 *
 *   * `recordId` is a lookup handle and **is not a secret**. It is the front
 *     half of a string that ends up in the odd log line, and D5 is built so
 *     that knowing it is worth nothing: an attacker who presents a real id with
 *     the wrong secret is refused with the family untouched.
 *   * `secret` is 256 bits of CSPRNG, and is never written down anywhere. What
 *     the row holds is `HMAC-SHA256(pepper, secret)`.
 *
 * The comparison lives here, but *when* it happens does not:
 * `lib/mobileRefreshRotationCore.ts` calls it as a thunk from step 2 of D5's
 * order, before any state is judged. This file must therefore never be used to
 * answer "is this record consumed" -- it answers one question, and answering it
 * is a prerequisite for asking the others.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  activeMobileRefreshPepper,
  mobileRefreshPepperById,
} from "@/lib/mobileAuthKeyring";

type Environment = Record<string, string | undefined>;

/** 256 bits, per D5. */
const SECRET_BYTES = 32;
/** Enough that two ids never collide; not a secret, so not sized like one. */
const RECORD_ID_BYTES = 16;

const digestSecret = (pepper: string, secret: string) =>
  createHmac("sha256", pepper).update(secret).digest("hex");

export type MintedMobileRefreshToken = {
  /** What the device stores. Never persisted, never logged. */
  token: string;
  recordId: string;
  secretDigest: string;
  pepperKid: string;
};

/**
 * A new refresh token and the row that will remember it.
 *
 * Returns the digest rather than writing it: the row is created inside the
 * caller's transaction, alongside the family update it has to be atomic with
 * (D7), and a mint that wrote its own row would have to be undone when that
 * transaction rolled back.
 */
export const mintMobileRefreshToken = (
  environment: Environment = process.env
): MintedMobileRefreshToken => {
  const pepper = activeMobileRefreshPepper(environment);
  const recordId = randomBytes(RECORD_ID_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    token: `${recordId}.${secret}`,
    recordId,
    secretDigest: digestSecret(pepper.secret, secret),
    pepperKid: pepper.keyId,
  };
};

export type ParsedMobileRefreshToken = { recordId: string; secret: string };

/**
 * The two halves of a presented token, or null.
 *
 * Exactly two non-empty segments. A token with three is not a refresh token
 * with an extra dot, it is something else -- most likely an access token, which
 * has three segments and must never be accepted here.
 */
export const parseMobileRefreshToken = (
  value: string | null | undefined
): ParsedMobileRefreshToken | null => {
  if (typeof value !== "string") return null;
  const segments = value.split(".");
  if (segments.length !== 2) return null;
  const [recordId, secret] = segments;
  if (!recordId || !secret) return null;
  return { recordId, secret };
};

/**
 * Whether a presented secret is the one a row was minted with.
 *
 * Three refusals, all returning the same `false`:
 *
 *   * the row names a pepper generation this deployment no longer holds. It is
 *     *not* retried under the active pepper: that would compare a digest
 *     against a key it was never computed with and report a legitimate token as
 *     forged, which under D8 destroys a family;
 *   * the digests are different lengths, checked before `timingSafeEqual`,
 *     which throws on a length mismatch (the same guard `lib/emailLogin.ts`
 *     uses);
 *   * the digests differ, compared in constant time.
 */
export const mobileRefreshSecretMatches = (
  input: { secret: string; storedDigest: string; pepperKid: string },
  environment: Environment = process.env
): boolean => {
  const pepper = mobileRefreshPepperById(input.pepperKid, environment);
  if (!pepper) return false;

  const computed = Buffer.from(digestSecret(pepper.secret, input.secret), "utf8");
  const stored = Buffer.from(input.storedDigest, "utf8");
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
};

/**
 * The digest of a one-time secret -- a login grant, or its client binding.
 *
 * Same pepper ring as refresh tokens, and deliberately so: both are one-time
 * bearer secrets with the same rule that the plaintext is never stored. A
 * separate ring would be a second rotation schedule for the same property.
 */
export const mobileOneTimeSecretDigest = (
  secret: string,
  environment: Environment = process.env
) => {
  const pepper = activeMobileRefreshPepper(environment);
  return digestSecret(pepper.secret, secret);
};
