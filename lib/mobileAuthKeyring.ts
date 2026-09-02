/**
 * The two key rings mobile bearer authentication runs on, and why they are two.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D6, and approved decision 3 of 2026-08-31.
 *
 * A **signing key** signs access tokens. It only has to outlive the tokens it
 * signed, which is ten minutes plus skew, so a retired one is kept for fifteen
 * (`MOBILE_PREVIOUS_SIGNING_KEY_SECONDS`).
 *
 * A **pepper** keys the HMAC over a refresh token's secret. It is bound to
 * every refresh token still alive, so retiring one on the signing key's
 * schedule would sign every account out. A retired pepper stays verifiable for
 * the idle window plus skew, and each successful refresh mints its successor
 * under the current generation, so the old one drains rather than being cut.
 *
 * Getting that asymmetry wrong is the failure D6 names, and it is why these are
 * separate rings with separate active-id variables rather than one ring with
 * two uses.
 *
 * ## Shape
 *
 * `lib/manifestHashKeyring.ts` is the precedent and this deliberately mirrors
 * it: `id:secret` pairs, a separate variable naming the active id, old ids left
 * in the ring after a rotation, and a throw rather than a fallback when the
 * active id is missing or unknown. A fallback here would be a silent downgrade
 * to a key nobody can name, and a token signed by a key nobody can name is
 * worse than no token at all -- the first looks like authentication.
 *
 * No secret in this file is ever logged, returned in a response, or written to
 * a row. What is written down is the *id*, which is what makes a rotation
 * survivable.
 *
 * `environment` is a parameter rather than a read of `process.env` so the
 * refusals below can be tested without setting variables on the test process.
 */

/** `MOBILE_AUTH_SIGNING_KEYS=id:base64Pkcs8,id2:base64Pkcs8` (Ed25519). */
export const MOBILE_SIGNING_KEYS_ENV = "MOBILE_AUTH_SIGNING_KEYS";
/** Which id new access tokens are signed with. Must name a key above. */
export const MOBILE_ACTIVE_SIGNING_KEY_ENV = "MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID";
/** `MOBILE_AUTH_REFRESH_PEPPERS=id:secret,id2:secret2`. */
export const MOBILE_REFRESH_PEPPERS_ENV = "MOBILE_AUTH_REFRESH_PEPPERS";
/** Which id new refresh digests are computed under. Must name a pepper above. */
export const MOBILE_ACTIVE_REFRESH_PEPPER_ENV =
  "MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID";
/** `iss`. Exact-matched at verification, so mint and verify read this one name. */
export const MOBILE_TOKEN_ISSUER_ENV = "MOBILE_AUTH_TOKEN_ISSUER";
/** `aud`. Exact-matched, element by element -- never a prefix or a substring. */
export const MOBILE_TOKEN_AUDIENCE_ENV = "MOBILE_AUTH_TOKEN_AUDIENCE";
/** `MOBILE_AUTH_RETIRED_SIGNING_KEYS=id@2026-09-02T10:00:00Z,...` */
export const MOBILE_RETIRED_SIGNING_KEYS_ENV = "MOBILE_AUTH_RETIRED_SIGNING_KEYS";
/** `MOBILE_AUTH_RETIRED_REFRESH_PEPPERS=id@2026-09-02T10:00:00Z,...` */
export const MOBILE_RETIRED_REFRESH_PEPPERS_ENV =
  "MOBILE_AUTH_RETIRED_REFRESH_PEPPERS";

import {
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
} from "@/lib/mobileAuthContract";

export class MobileAuthKeyringError extends Error {}

export type MobileKeyringEntry = { keyId: string; secret: string };

/**
 * The id alphabet.
 *
 * The id travels in a JOSE header and is stored in `MobileRefreshRotation.
 * pepperKid`. Keeping it boring means nothing that reads it next has to escape
 * it, and a `kid` that could carry a quote or a slash is a `kid` somebody will
 * eventually interpolate into something.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const parseRing = (
  raw: string,
  variable: string,
  minimumSecretLength: number
): ReadonlyMap<string, string> => {
  const entries = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new MobileAuthKeyringError(
        `${variable} entries must be "keyId:secret".`
      );
    }
    const keyId = trimmed.slice(0, separator);
    const secret = trimmed.slice(separator + 1);
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new MobileAuthKeyringError(
        `"${keyId}" is not a usable ${variable} key id.`
      );
    }
    if (secret.length < minimumSecretLength) {
      // Never quotes the secret, only the id it was filed under.
      throw new MobileAuthKeyringError(
        `The ${variable} entry "${keyId}" is too short to be a key.`
      );
    }
    if (entries.has(keyId)) {
      // Two secrets under one id would make the id meaningless, and every
      // token or digest written under it verifiable against neither.
      throw new MobileAuthKeyringError(
        `The ${variable} key id "${keyId}" is configured twice.`
      );
    }
    entries.set(keyId, secret);
  }
  return entries;
};

/**
 * When each retired key stopped being current.
 *
 * A second variable rather than a third field on the ring entry, because a
 * pepper is an operator-chosen secret and may legitimately contain a colon --
 * a third field would make the parse ambiguous for exactly the value nobody
 * wants misread. Absence means "not retired", so an existing deployment needs
 * no change until it rotates.
 *
 * Errors rather than ignores an unknown id: a retirement naming a key that is
 * not in the ring is a typo, and a typo here silently protects nothing while
 * looking like it does.
 */
const parseRetirements = (
  raw: string,
  variable: string,
  ring: ReadonlyMap<string, string>,
  ringVariable: string
): ReadonlyMap<string, number> => {
  const retirements = new Map<string, number>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("@");
    if (separator <= 0) {
      throw new MobileAuthKeyringError(
        `${variable} entries must be "keyId@<ISO 8601 instant>".`
      );
    }
    const keyId = trimmed.slice(0, separator);
    const retiredAt = Date.parse(trimmed.slice(separator + 1));
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new MobileAuthKeyringError(`"${keyId}" is not a usable ${variable} key id.`);
    }
    if (!Number.isFinite(retiredAt)) {
      throw new MobileAuthKeyringError(
        `${variable} gives "${keyId}" a retirement time that is not an instant.`
      );
    }
    if (!ring.has(keyId)) {
      throw new MobileAuthKeyringError(
        `${variable} retires "${keyId}", which is not in ${ringVariable}.`
      );
    }
    if (retirements.has(keyId)) {
      throw new MobileAuthKeyringError(`${variable} retires "${keyId}" twice.`);
    }
    retirements.set(keyId, retiredAt);
  }
  return retirements;
};

/**
 * Whether a retired key may still be used to verify.
 *
 * This is what turns `MOBILE_PREVIOUS_SIGNING_KEY_SECONDS` and
 * `MOBILE_PREVIOUS_PEPPER_SECONDS` from numbers in a document into something
 * the code enforces. Without it a key left in the ring after a rotation is
 * trusted for ever, and "the previous key is honoured for fifteen minutes"
 * describes an intention rather than the system.
 *
 * The two windows are different on purpose, and D6 says why: a signing key only
 * has to outlive the access tokens it signed, while a pepper is bound to every
 * refresh token still alive.
 */
const withinGrace = (retiredAtMs: number, graceSeconds: number, nowMs: number) =>
  nowMs < retiredAtMs + graceSeconds * 1000;

const activeEntry = (
  ring: ReadonlyMap<string, string>,
  retirements: ReadonlyMap<string, number>,
  keyId: string,
  activeVariable: string,
  ringVariable: string
): MobileKeyringEntry => {
  if (keyId === "") {
    throw new MobileAuthKeyringError(`${activeVariable} is not set.`);
  }
  const secret = ring.get(keyId);
  if (!secret) {
    throw new MobileAuthKeyringError(
      `${activeVariable} names "${keyId}", which is not in ${ringVariable}.`
    );
  }
  if (retirements.has(keyId)) {
    // A retired key that is also the active one is the mistake this whole
    // mechanism exists to catch: it would keep minting new credentials under a
    // key somebody has already decided to stop trusting.
    throw new MobileAuthKeyringError(
      `${activeVariable} names "${keyId}", which is retired.`
    );
  }
  return { keyId, secret };
};

/**
 * Every configured signing key, by id.
 *
 * A retired key stays in the ring so the access tokens it signed keep verifying
 * for their remaining minutes. Removing one is the deliberate act of deciding
 * those tokens should stop working now.
 *
 * The secret is a base64 PKCS#8 Ed25519 private key. The public half is derived
 * from it at verification time rather than configured separately: two variables
 * that must agree are two variables that can disagree, and a deployment holding
 * a public key that does not match its private one fails on the first token it
 * ever issues.
 */
export const mobileSigningKeyring = (
  environment: Record<string, string | undefined> = process.env
) => parseRing(environment[MOBILE_SIGNING_KEYS_ENV] ?? "", MOBILE_SIGNING_KEYS_ENV, 32);

/** When each retired signing key stopped being current. */
export const mobileSigningKeyRetirements = (
  environment: Record<string, string | undefined> = process.env
) =>
  parseRetirements(
    environment[MOBILE_RETIRED_SIGNING_KEYS_ENV] ?? "",
    MOBILE_RETIRED_SIGNING_KEYS_ENV,
    mobileSigningKeyring(environment),
    MOBILE_SIGNING_KEYS_ENV
  );

/** The key new access tokens are signed with. Throws rather than falling back. */
export const activeMobileSigningKey = (
  environment: Record<string, string | undefined> = process.env
) =>
  activeEntry(
    mobileSigningKeyring(environment),
    mobileSigningKeyRetirements(environment),
    environment[MOBILE_ACTIVE_SIGNING_KEY_ENV] ?? "",
    MOBILE_ACTIVE_SIGNING_KEY_ENV,
    MOBILE_SIGNING_KEYS_ENV
  );

/**
 * The signing key a presented token names, or null.
 *
 * Null is an answer, not a mismatch: it means this deployment cannot check the
 * token, which the verifier reports as `unknown_kid` rather than as a bad
 * signature. Telling those apart is what makes a rotation debuggable.
 */
export const mobileSigningKeyById = (
  keyId: string | null | undefined,
  environment: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now()
): MobileKeyringEntry | null => {
  if (!keyId) return null;
  const secret = mobileSigningKeyring(environment).get(keyId);
  if (!secret) return null;

  const retiredAt = mobileSigningKeyRetirements(environment).get(keyId);
  if (
    retiredAt !== undefined &&
    !withinGrace(retiredAt, MOBILE_PREVIOUS_SIGNING_KEY_SECONDS, nowMs)
  ) {
    // Past its grace. The same answer as a key that was never configured, and
    // for the same reason: this deployment cannot check the token, which the
    // verifier reports as `unknown_kid` rather than as a bad signature.
    return null;
  }
  return { keyId, secret };
};

/** Every configured refresh pepper, by id. */
export const mobileRefreshPepperRing = (
  environment: Record<string, string | undefined> = process.env
) =>
  parseRing(
    environment[MOBILE_REFRESH_PEPPERS_ENV] ?? "",
    MOBILE_REFRESH_PEPPERS_ENV,
    32
  );

/** When each retired pepper stopped being current. */
export const mobileRefreshPepperRetirements = (
  environment: Record<string, string | undefined> = process.env
) =>
  parseRetirements(
    environment[MOBILE_RETIRED_REFRESH_PEPPERS_ENV] ?? "",
    MOBILE_RETIRED_REFRESH_PEPPERS_ENV,
    mobileRefreshPepperRing(environment),
    MOBILE_REFRESH_PEPPERS_ENV
  );

/** The pepper new refresh digests are computed under. */
export const activeMobileRefreshPepper = (
  environment: Record<string, string | undefined> = process.env
) =>
  activeEntry(
    mobileRefreshPepperRing(environment),
    mobileRefreshPepperRetirements(environment),
    environment[MOBILE_ACTIVE_REFRESH_PEPPER_ENV] ?? "",
    MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
    MOBILE_REFRESH_PEPPERS_ENV
  );

/**
 * The pepper a stored rotation row was digested under, or null.
 *
 * Null means the row cannot be checked with what this deployment holds. The
 * caller refuses -- it must not fall through to the active pepper, which would
 * compare a digest against a key it was never computed with and report a
 * legitimate token as forged.
 */
export const mobileRefreshPepperById = (
  keyId: string | null | undefined,
  environment: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now()
): MobileKeyringEntry | null => {
  if (!keyId) return null;
  const secret = mobileRefreshPepperRing(environment).get(keyId);
  if (!secret) return null;

  const retiredAt = mobileRefreshPepperRetirements(environment).get(keyId);
  if (
    retiredAt !== undefined &&
    !withinGrace(retiredAt, MOBILE_PREVIOUS_PEPPER_SECONDS, nowMs)
  ) {
    // A far longer window than the signing key's, because a pepper is bound to
    // every refresh token still alive rather than to ten minutes of access
    // tokens. Cutting it to the signing key's window signs everyone out.
    return null;
  }
  return { keyId, secret };
};

/**
 * `iss`, and the reason it is one function rather than two constants.
 *
 * Verification exact-matches this value, so the minting side and the verifying
 * side have to read the same name. A second copy anywhere is a deployment that
 * can be configured to issue tokens it then refuses.
 */
export const mobileTokenIssuer = (
  environment: Record<string, string | undefined> = process.env
) => {
  const value = environment[MOBILE_TOKEN_ISSUER_ENV]?.trim() ?? "";
  if (value === "") {
    throw new MobileAuthKeyringError(`${MOBILE_TOKEN_ISSUER_ENV} is not set.`);
  }
  return value;
};

/** `aud`. Same reasoning as the issuer above. */
export const mobileTokenAudience = (
  environment: Record<string, string | undefined> = process.env
) => {
  const value = environment[MOBILE_TOKEN_AUDIENCE_ENV]?.trim() ?? "";
  if (value === "") {
    throw new MobileAuthKeyringError(`${MOBILE_TOKEN_AUDIENCE_ENV} is not set.`);
  }
  return value;
};

/**
 * Whether this deployment is configured to do mobile authentication at all.
 *
 * Fail-closed and *silent about why* to the caller: the endpoints answer as
 * though the feature is not there rather than telling an unauthenticated
 * requester which variable is missing. The reason goes to the server log.
 */
export const mobileAuthConfigured = (
  environment: Record<string, string | undefined> = process.env
) => {
  try {
    activeMobileSigningKey(environment);
    activeMobileRefreshPepper(environment);
    mobileTokenIssuer(environment);
    mobileTokenAudience(environment);
    return true;
  } catch {
    return false;
  }
};
