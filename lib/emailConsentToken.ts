import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * The token in a marketing consent confirmation link.
 *
 * Contract: docs/policy/email-double-opt-in.md §4.2, §4.3, §8.
 *
 * Pure and dependency-free, like `lib/unsubscribeToken.ts`, whose shape this
 * copies: `c1.<version>.<iv>.<ciphertext>.<tag>`, AES-256-GCM, a versioned
 * keyring. Stateless on purpose -- a pending-row table would need its own
 * expiry sweep, and a sweep that stops makes expiry quietly longer.
 *
 * ## Why a separate keyring
 *
 * Not to save a key. The unsubscribe token has a contract this one breaks on
 * purpose: an unsubscribe link may only ever turn something *off*, which is why
 * it works with no login and why `preferenceChangeDecision()` refuses
 * `viaToken && enabled`. A confirmation link turns something *on* by
 * definition. Rather than loosen that rule, confirmation is a different path
 * the rule never reaches, and different keys make the two tokens impossible to
 * replay as each other: a `u1` token will not decrypt here and a `c1` token
 * will not decrypt there.
 *
 * ## What a leaked token can do
 *
 * Confirm one pending consent, for one purpose, for the account that asked, for
 * seventy-two hours -- and only while that request is still the latest one for
 * that purpose (`confirmConsent()` compares `requestedAt` with the stored row).
 * It cannot create a request, reach another purpose or reach another person.
 *
 * ## No address in the payload
 *
 * The address is read by the server from the account. The payload carries a
 * digest of it instead, so a confirmation cannot land on an account whose
 * address changed after the mail went out: the click proves ownership of the
 * mailbox the message was sent to, and nothing else.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TOKEN_PREFIX = "c1";

/** §8: a confirmation link is good for seventy-two hours. */
export const CONSENT_CONFIRMATION_TTL_MS = 72 * 60 * 60 * 1_000;

export type ConsentTokenPayload = {
  kind: "consent";
  userId: string;
  purpose: string;
  /** ISO instant. Must equal the preference row's `confirmationRequestedAt`. */
  requestedAt: string;
  policyVersionId: string;
  /** `consentAddressDigest()` of the address the confirmation was sent to. */
  addressDigest: string;
};

export type ConsentKeyring = {
  activeVersion: string;
  secrets: Record<string, string>;
};

export const readConsentKeyring = (env: NodeJS.ProcessEnv): ConsentKeyring | null => {
  const raw = env.EMAIL_CONSENT_KEYS?.trim();
  if (!raw) return null;

  const secrets: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    const version = pair.slice(0, separator).trim();
    const secret = pair.slice(separator + 1).trim();
    if (version && secret) secrets[version] = secret;
  }

  const versions = Object.keys(secrets);
  if (versions.length === 0) return null;

  const activeVersion = env.EMAIL_CONSENT_KEY_VERSION?.trim() || versions[0];
  if (!secrets[activeVersion]) {
    throw new Error(
      `EMAIL_CONSENT_KEY_VERSION "${activeVersion}" has no matching key in ` +
        "EMAIL_CONSENT_KEYS."
    );
  }
  return { activeVersion, secrets };
};

// A different derivation prefix from the unsubscribe keyring's, so that even an
// operator who pastes the same secret into both variables does not make the two
// token kinds interchangeable.
const keyFor = (secret: string) =>
  createHash("sha256").update(`email-consent:${secret}`).digest();

/**
 * A digest of the address, bound into the token and never shown.
 *
 * Lower-cased and trimmed the same way suppression normalises addresses, so a
 * change of case is not a change of mailbox.
 */
export const consentAddressDigest = (address: string) =>
  createHash("sha256")
    .update(`email-consent-address:${address.trim().toLowerCase()}`)
    .digest("base64url");

export const createConsentToken = (
  payload: Omit<ConsentTokenPayload, "kind">,
  keyring: ConsentKeyring
): string => {
  const secret = keyring.secrets[keyring.activeVersion];
  if (!secret) {
    throw new Error(`No consent key for version "${keyring.activeVersion}".`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret), iv);
  const body: ConsentTokenPayload = { kind: "consent", ...payload };
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(body), "utf8"),
    cipher.final(),
  ]);

  return [
    TOKEN_PREFIX,
    keyring.activeVersion,
    iv.toString("base64url"),
    ct.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
};

export type ConsentTokenResult =
  | { valid: true; payload: ConsentTokenPayload; version: string }
  | {
      valid: false;
      reason: "malformed" | "unknown_key" | "invalid" | "expired";
    };

/**
 * Opens a token, or refuses.
 *
 * `expired` is the one refusal the page tells apart, because its remedy is
 * different: ask again from the settings screen. The others are one answer --
 * an invalid link is an invalid link -- and are distinguished only so an
 * operator can see that `unknown_key` means a key version was dropped.
 */
export const readConsentToken = (
  token: string,
  keyring: ConsentKeyring,
  now: Date
): ConsentTokenResult => {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) {
    return { valid: false, reason: "malformed" };
  }

  const [, version, iv, ct, tag] = parts;
  const secret = keyring.secrets[version];
  if (!secret) return { valid: false, reason: "unknown_key" };

  let payload: ConsentTokenPayload;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      keyFor(secret),
      Buffer.from(iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]);
    payload = JSON.parse(plain.toString("utf8")) as ConsentTokenPayload;
  } catch {
    return { valid: false, reason: "invalid" };
  }

  if (
    payload?.kind !== "consent" ||
    typeof payload.userId !== "string" ||
    typeof payload.purpose !== "string" ||
    typeof payload.requestedAt !== "string" ||
    typeof payload.policyVersionId !== "string" ||
    typeof payload.addressDigest !== "string"
  ) {
    return { valid: false, reason: "invalid" };
  }

  const requestedAt = Date.parse(payload.requestedAt);
  if (!Number.isFinite(requestedAt)) return { valid: false, reason: "invalid" };
  // A request stamped in the future did not come from this server's clock
  // honestly; refusing it keeps the expiry arithmetic from being extended.
  if (requestedAt > now.getTime() + 5 * 60 * 1_000) {
    return { valid: false, reason: "invalid" };
  }
  if (now.getTime() - requestedAt > CONSENT_CONFIRMATION_TTL_MS) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, payload, version };
};

/** Strips the token from a URL before it is logged. */
export const redactConsentToken = (url: string) =>
  url.replace(/([?&]t=)[^&#]*/gi, "$1[redacted]");
