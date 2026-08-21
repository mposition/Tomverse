import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Envelope encryption for the personalisation inputs a message was rendered
 * from.
 *
 * Contract: docs/policy/email-notifications.md §10.3.
 *
 * The snapshot exists because a template version and a policy version cannot
 * reconstruct a sent message on their own: the name changed, the plan changed,
 * and the amount was only ever true on the day. Keeping the inputs is what
 * turns "we hold a hash of something we sent" into "here is what we sent".
 *
 * But those inputs are personal data sitting in a table nobody reads on the
 * happy path, so they are encrypted at rest. Envelope rather than a single key
 * over every row: each snapshot gets its own random data key, and only that key
 * is wrapped by the master. Rotating the master then re-wraps keys instead of
 * re-encrypting payloads -- which matters because §13.2 keeps legal-class rows
 * for seven years, and a rotation that has to rewrite seven years of ciphertext
 * is a rotation nobody performs.
 *
 * Deliberately free of `server-only` and of Prisma so the round-trip can be
 * tested without either.
 *
 * What this is not: protection against an attacker who already has the
 * application's environment. It removes the snapshot from a database dump, a
 * backup, a replica and a stray query -- which is where a table like this
 * actually leaks from.
 */

const ALGORITHM = "aes-256-gcm";
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The stored shape. Every field is needed to decrypt, and the version is what
 * lets a key rotation leave old rows readable rather than merely unreadable.
 */
export type EncryptedSnapshot = {
  v: 1;
  /** Which master key wrapped `dk`. Old versions stay decryptable. */
  keyVersion: string;
  /** The data key, encrypted under the master key. */
  dk: string;
  dkIv: string;
  dkTag: string;
  /** The payload, encrypted under the data key. */
  ct: string;
  iv: string;
  tag: string;
};

export const isEncryptedSnapshot = (value: unknown): value is EncryptedSnapshot =>
  typeof value === "object" &&
  value !== null &&
  (value as { v?: unknown }).v === 1 &&
  typeof (value as { ct?: unknown }).ct === "string" &&
  typeof (value as { dk?: unknown }).dk === "string" &&
  typeof (value as { keyVersion?: unknown }).keyVersion === "string";

/**
 * Derives a 32-byte master key from the configured secret.
 *
 * A hash rather than the raw bytes because the secret is configured as text of
 * whatever length an operator pasted, and AES-256 needs exactly 32 bytes. This
 * is not key stretching and is not pretending to be: the input is expected to
 * be high-entropy already, which is what `openssl rand -base64 32` produces.
 */
const masterKey = (secret: string) =>
  createHash("sha256").update(`email-snapshot:${secret}`).digest();

export type SnapshotKeyring = {
  /** The version new snapshots are written under. */
  activeVersion: string;
  /**
   * Every version that must stay decryptable, including the active one.
   *
   * Retention sets the floor here, not convenience: §10.3-7 keeps a
   * legal-class record for seven years, so the key that sealed it has to
   * outlive it. Dropping a version from this map does not delete the rows --
   * it makes them permanently unreadable, which is a worse outcome than
   * keeping them, and a silent one.
   */
  secrets: Record<string, string>;
};

/**
 * Reads the keyring from the environment.
 *
 * `EMAIL_SNAPSHOT_KEYS` is `version:secret` pairs separated by commas, so a
 * rotation is a deploy that adds a pair and moves `EMAIL_SNAPSHOT_KEY_VERSION`
 * -- old rows keep decrypting throughout.
 */
export const readSnapshotKeyring = (env: NodeJS.ProcessEnv): SnapshotKeyring | null => {
  const raw = env.EMAIL_SNAPSHOT_KEYS?.trim();
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

  const activeVersion = env.EMAIL_SNAPSHOT_KEY_VERSION?.trim() || versions[0];
  if (!secrets[activeVersion]) {
    throw new Error(
      `EMAIL_SNAPSHOT_KEY_VERSION "${activeVersion}" has no matching key in EMAIL_SNAPSHOT_KEYS.`
    );
  }
  return { activeVersion, secrets };
};

export const encryptSnapshot = (
  payload: unknown,
  keyring: SnapshotKeyring
): EncryptedSnapshot => {
  const secret = keyring.secrets[keyring.activeVersion];
  if (!secret) {
    throw new Error(
      `No snapshot key for active version "${keyring.activeVersion}".`
    );
  }

  const dataKey = randomBytes(DATA_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const dkIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv(ALGORITHM, masterKey(secret), dkIv);
  const dk = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
  const dkTag = wrapper.getAuthTag();

  return {
    v: 1,
    keyVersion: keyring.activeVersion,
    dk: dk.toString("base64"),
    dkIv: dkIv.toString("base64"),
    dkTag: dkTag.toString("base64"),
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
};

/**
 * Recovers the payload, or throws.
 *
 * Never returns a partial or a placeholder: GCM authenticates, so a snapshot
 * that fails to decrypt has either been tampered with or was sealed under a key
 * this deployment no longer holds. Both are worth stopping for -- rendering
 * from a payload we could not verify would put unverified content in a message
 * and call it a reproduction.
 */
export const decryptSnapshot = <T = unknown>(
  stored: unknown,
  keyring: SnapshotKeyring
): T => {
  if (!isEncryptedSnapshot(stored)) {
    throw new Error("Snapshot is not in the encrypted envelope format.");
  }
  const secret = keyring.secrets[stored.keyVersion];
  if (!secret) {
    throw new Error(
      `Snapshot was sealed under key version "${stored.keyVersion}", which this ` +
        "deployment does not hold. The row is not recoverable without it."
    );
  }

  const unwrapper = createDecipheriv(
    ALGORITHM,
    masterKey(secret),
    Buffer.from(stored.dkIv, "base64")
  );
  unwrapper.setAuthTag(Buffer.from(stored.dkTag, "base64"));
  const dataKey = Buffer.concat([
    unwrapper.update(Buffer.from(stored.dk, "base64")),
    unwrapper.final(),
  ]);

  const decipher = createDecipheriv(
    ALGORITHM,
    dataKey,
    Buffer.from(stored.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(stored.ct, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plain.toString("utf8")) as T;
};
