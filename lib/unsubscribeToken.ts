import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * The token in an unsubscribe link.
 *
 * Contract: docs/policy/email-notifications.md §11.4.
 *
 * Pure and dependency-free -- no Prisma, no `server-only` -- so the whole
 * property list below can be driven in tests without a database.
 *
 * ## Why authenticated encryption rather than a signed payload
 *
 * §11.4 asks for two things that pull in different directions: the token must
 * be unforgeable (it names HMAC-SHA256) and it must be opaque (no user id in
 * the payload, no plaintext address). A signed-but-readable payload gives the
 * first and not the second: the value ends up in a URL, and URLs end up in
 * referrer headers, access logs, mail-client link previews and support tickets.
 *
 * AES-256-GCM gives both. Its authentication tag is an unforgeability proof of
 * exactly the kind the HMAC was there to provide -- a modified token fails to
 * decrypt rather than decrypting to something else -- and the ciphertext is
 * opaque without needing a lookup table to make it so. JWT is still avoided,
 * for the reason §11.4 gives.
 *
 * ## What a leaked token can do
 *
 * Turn one purpose off for one subject. Nothing else. It cannot enable
 * anything, cannot reach another purpose, and cannot reach another person --
 * which is why this works without a login at all, and why the Australian rule
 * against requiring one is satisfiable rather than a compromise.
 *
 * ## Why it does not expire
 *
 * CAN-SPAM requires the mechanism to work for at least thirty days after the
 * message, and people unsubscribe from mail far older than that. A token that
 * expires produces a dead link in an old email, and the recipient's remaining
 * option is the spam button. Key rotation is the control instead: old versions
 * stay decryptable for as long as they are listed.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TOKEN_PREFIX = "u1";

export type UnsubscribePayload = {
  /** The account this token acts on. Never visible in the token itself. */
  userId: string;
  /** The single purpose it may switch off. */
  purpose: string;
  /** The delivery it came from, for provenance on the resulting record. */
  deliveryId?: string;
};

export type UnsubscribeKeyring = {
  activeVersion: string;
  /**
   * Every version that must stay readable.
   *
   * Dropping one does not invalidate the links -- it breaks them, and the
   * recipient of a broken unsubscribe link reports the message as spam. Old
   * versions stay listed for at least as long as mail carrying them is in the
   * wild.
   */
  secrets: Record<string, string>;
};

export const readUnsubscribeKeyring = (
  env: NodeJS.ProcessEnv
): UnsubscribeKeyring | null => {
  const raw = env.EMAIL_UNSUBSCRIBE_KEYS?.trim();
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

  const activeVersion = env.EMAIL_UNSUBSCRIBE_KEY_VERSION?.trim() || versions[0];
  if (!secrets[activeVersion]) {
    throw new Error(
      `EMAIL_UNSUBSCRIBE_KEY_VERSION "${activeVersion}" has no matching key in ` +
        "EMAIL_UNSUBSCRIBE_KEYS."
    );
  }
  return { activeVersion, secrets };
};

const keyFor = (secret: string) =>
  createHash("sha256").update(`email-unsubscribe:${secret}`).digest();

/** `u1.<version>.<iv>.<ciphertext>.<tag>`, all base64url. */
export const createUnsubscribeToken = (
  payload: UnsubscribePayload,
  keyring: UnsubscribeKeyring
): string => {
  const secret = keyring.secrets[keyring.activeVersion];
  if (!secret) {
    throw new Error(`No unsubscribe key for version "${keyring.activeVersion}".`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret), iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
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

export type UnsubscribeTokenResult =
  | { valid: true; payload: UnsubscribePayload }
  | { valid: false; reason: "malformed" | "unknown_key" | "invalid" };

/**
 * Opens a token, or refuses.
 *
 * Every refusal is reported the same way to the caller's user -- an invalid
 * link is an invalid link -- but the reasons are distinguished here because
 * `unknown_key` means an operator dropped a key version and every link of that
 * vintage is now dead, which is an incident rather than a user error.
 */
export const readUnsubscribeToken = (
  token: string,
  keyring: UnsubscribeKeyring
): UnsubscribeTokenResult => {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) {
    return { valid: false, reason: "malformed" };
  }

  const [, version, iv, ct, tag] = parts;
  const secret = keyring.secrets[version];
  if (!secret) return { valid: false, reason: "unknown_key" };

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
    const payload = JSON.parse(plain.toString("utf8")) as UnsubscribePayload;

    if (
      typeof payload?.userId !== "string" ||
      typeof payload?.purpose !== "string"
    ) {
      return { valid: false, reason: "invalid" };
    }
    return { valid: true, payload };
  } catch {
    // A tampered token, a truncated one, or one from another deployment. GCM
    // does not distinguish, and neither should the answer.
    return { valid: false, reason: "invalid" };
  }
};

/**
 * Strips the token from a URL before it is logged.
 *
 * The token travels in a query string, so it reaches access logs, error
 * reporters and referrer headers unless something removes it. Not a
 * confidentiality disaster -- see "what a leaked token can do" -- but a value
 * that can change someone's settings should not sit in a log nobody thinks of
 * as sensitive.
 */
export const redactUnsubscribeToken = (url: string) =>
  url.replace(/([?&]t=)[^&#]*/gi, "$1[redacted]");
