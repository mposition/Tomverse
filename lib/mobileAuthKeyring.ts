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

/**
 * Says a configuration problem once, not once per parse.
 *
 * A single `mobileAuthReady()` parses each ring more than once, and the public
 * endpoints call it before admission -- so a misconfigured deployment was
 * writing the same line several times per request, which is a log-amplification
 * path on an unauthenticated route as well as noise that buries the signal.
 *
 * Keyed on the message, so a *different* problem still gets said. Cleared by a
 * restart, which is when configuration changes anyway.
 */
const reported = new Set<string>();

const reportOnce = (message: string) => {
  if (reported.has(message)) return;
  reported.add(message);
  console.error(message);
};

/** Test seam: the report memo is process state. */
export const resetMobileKeyringReportsForTesting = () => {
  reported.clear();
  parseCache.clear();
};

/**
 * Parsed rings and retirements, keyed on the raw text they came from.
 *
 * The parse is pure, so memoising it is only a cost question -- and the cost
 * was real: readiness alone parsed each ring three times per request.
 */
const parseCache = new Map<string, unknown>();

const memoParse = <T>(cacheKey: string, compute: () => T): T => {
  const hit = parseCache.get(cacheKey);
  if (hit !== undefined) return hit as T;
  const value = compute();
  parseCache.set(cacheKey, value);
  return value;
};

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
 * wants misread.
 *
 * **Absence does not mean "keep trusting it".** A retirement line naming an id
 * that is not in the ring is reported and ignored, because the leftover of a
 * cleanup and a mistyped id look identical from here and neither of them can
 * be told apart by this function. What makes the mistyped case safe is the
 * rule in `usableEntry` below: a ring key that is neither the active one nor
 * explicitly retired verifies nothing at all.
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
      // Reported and ignored, not thrown -- and this is a reversal of what the
      // first version of this function did.
      //
      // It threw, to catch a typo: retiring `sign-2` when you meant `sign-1`
      // leaves the wrong key trusted. But throwing made `mobileAuthReady()`
      // false, which answers **503 to every mobile auth request**. So the
      // ordinary act of tidying a ring -- deleting an entry whose grace has
      // passed and leaving its retirement line behind -- took the whole feature
      // down, and the runbook's own deletion step did exactly that.
      //
      // The cost of the two mistakes is not comparable. A key absent from the
      // ring is already unusable, so a retirement naming it protects nothing
      // and endangers nothing; a total outage is a total outage. The typo is
      // still worth knowing about, which is what the log is for.
      reportOnce(
        `${variable} retires "${keyId}", which is not in ${ringVariable}. ` +
          "Ignoring the line, and that key -- if it is in the ring under its " +
          "real id -- verifies nothing, because a ring key that is neither " +
          "active nor explicitly retired is not usable. Check for a mistyped id."
      );
      continue;
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

/**
 * Whether a ring key may verify anything right now.
 *
 * **A key is usable only if it is the active one, or it is explicitly retired
 * and still inside its grace.** Everything else in the ring verifies nothing --
 * including a key that is simply sitting there undeclared.
 *
 * This is the third shape this rule has taken, and the two it replaces are
 * worth recording because each failed in the opposite direction.
 *
 * The first threw when a retirement named an id that was not in the ring, to
 * catch a mistyped id. That turned the ordinary act of tidying a ring into a
 * 503 for every mobile auth request: delete the key, leave its retirement line,
 * and the whole feature stops answering.
 *
 * The second ignored the unknown id, which removed the outage and created a
 * silent hole. With ring `{sign-old, sign-new}`, active `sign-new`, and a
 * retirement for `sign-odl`, the deployment reported itself healthy and
 * `sign-old` stayed trusted for ever -- so the approved fifteen-minute contract
 * did not apply, and a leaked previous key kept working.
 *
 * The mistake in both was asking the wrong question. "Is this retirement line
 * valid?" cannot be answered: a leftover from a cleanup and a typo look
 * identical. "May this key verify?" can be, and its safe default is no. A
 * mistyped retirement now makes the previous key stop verifying *immediately*,
 * which is stricter than the contract rather than laxer, is visible (tokens it
 * signed are refused and clients refresh), and takes nothing else down.
 *
 * The cost is that forgetting the retirement line is not free: for a pepper it
 * means those refresh tokens stop verifying and those people sign in again.
 * `npm run check:mobile-auth-keyring` exists so that is found before a deploy
 * rather than after one, and `docs/ops/mobile-auth-key-rotation.md` says so.
 */
const usableEntry = (
  keyId: string,
  ring: ReadonlyMap<string, string>,
  retirements: ReadonlyMap<string, number>,
  activeKeyId: string,
  graceSeconds: number,
  nowMs: number
): MobileKeyringEntry | null => {
  const secret = ring.get(keyId);
  if (!secret) return null;
  if (keyId === activeKeyId) return { keyId, secret };

  const retiredAt = retirements.get(keyId);
  if (retiredAt === undefined) return null;
  if (!withinGrace(retiredAt, graceSeconds, nowMs)) return null;
  return { keyId, secret };
};

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
) => {
  const raw = environment[MOBILE_SIGNING_KEYS_ENV] ?? "";
  return memoParse(`${MOBILE_SIGNING_KEYS_ENV}\u0000${raw}`, () =>
    parseRing(raw, MOBILE_SIGNING_KEYS_ENV, 32)
  );
};

/** When each retired signing key stopped being current. */
export const mobileSigningKeyRetirements = (
  environment: Record<string, string | undefined> = process.env
) => {
  const raw = environment[MOBILE_RETIRED_SIGNING_KEYS_ENV] ?? "";
  const ring = mobileSigningKeyring(environment);
  return memoParse(
    `${MOBILE_RETIRED_SIGNING_KEYS_ENV}\u0000${raw}\u0000${[...ring.keys()].join(",")}`,
    () =>
      parseRetirements(raw, MOBILE_RETIRED_SIGNING_KEYS_ENV, ring, MOBILE_SIGNING_KEYS_ENV)
  );
};

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
  // Null is the answer for "past its grace", "never declared" and "not
  // configured" alike. The verifier reports all three as `unknown_kid` rather
  // than as a bad signature, which is what makes a rotation debuggable.
  return usableEntry(
    keyId,
    mobileSigningKeyring(environment),
    mobileSigningKeyRetirements(environment),
    environment[MOBILE_ACTIVE_SIGNING_KEY_ENV]?.trim() ?? "",
    MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
    nowMs
  );
};

/** Every configured refresh pepper, by id. */
export const mobileRefreshPepperRing = (
  environment: Record<string, string | undefined> = process.env
) => {
  const raw = environment[MOBILE_REFRESH_PEPPERS_ENV] ?? "";
  return memoParse(`${MOBILE_REFRESH_PEPPERS_ENV}\u0000${raw}`, () =>
    parseRing(raw, MOBILE_REFRESH_PEPPERS_ENV, 32)
  );
};

/** When each retired pepper stopped being current. */
export const mobileRefreshPepperRetirements = (
  environment: Record<string, string | undefined> = process.env
) => {
  const raw = environment[MOBILE_RETIRED_REFRESH_PEPPERS_ENV] ?? "";
  const ring = mobileRefreshPepperRing(environment);
  return memoParse(
    `${MOBILE_RETIRED_REFRESH_PEPPERS_ENV}\u0000${raw}\u0000${[...ring.keys()].join(",")}`,
    () =>
      parseRetirements(
        raw,
        MOBILE_RETIRED_REFRESH_PEPPERS_ENV,
        ring,
        MOBILE_REFRESH_PEPPERS_ENV
      )
  );
};

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
  // The same rule, with a far longer window: a pepper is bound to every refresh
  // token still alive rather than to ten minutes of access tokens. Cutting it
  // to the signing key's window signs everyone out.
  return usableEntry(
    keyId,
    mobileRefreshPepperRing(environment),
    mobileRefreshPepperRetirements(environment),
    environment[MOBILE_ACTIVE_REFRESH_PEPPER_ENV]?.trim() ?? "",
    MOBILE_PREVIOUS_PEPPER_SECONDS,
    nowMs
  );
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
