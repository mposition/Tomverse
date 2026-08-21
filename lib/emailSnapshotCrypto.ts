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
/**
 * What the environment says, before anything decides whether it is usable.
 *
 * Split out so the reader below and the readiness check further down cannot
 * disagree about what `EMAIL_SNAPSHOT_KEYS` means. A second parser written for
 * the health check is a second set of rules, and the failure it would produce
 * is the one worth avoiding here: a check that calls the configuration good
 * while the lane that uses it throws.
 */
const parseSnapshotKeyring = (env: NodeJS.ProcessEnv) => {
  const raw = env.EMAIL_SNAPSHOT_KEYS?.trim();
  const secrets: Record<string, string> = {};
  if (raw) {
    for (const pair of raw.split(",")) {
      const separator = pair.indexOf(":");
      if (separator <= 0) continue;
      const version = pair.slice(0, separator).trim();
      const secret = pair.slice(separator + 1).trim();
      if (version && secret) secrets[version] = secret;
    }
  }

  const versions = Object.keys(secrets);
  const pinnedVersion = env.EMAIL_SNAPSHOT_KEY_VERSION?.trim() || null;
  return {
    /** True when the variable was set to something, however malformed. */
    configured: Boolean(raw),
    secrets,
    versions,
    pinnedVersion,
    /** What a write would be sealed under. Null when nothing parsed. */
    activeVersion: pinnedVersion ?? versions[0] ?? null,
  };
};

export const readSnapshotKeyring = (env: NodeJS.ProcessEnv): SnapshotKeyring | null => {
  const parsed = parseSnapshotKeyring(env);
  if (parsed.versions.length === 0) return null;

  const activeVersion = parsed.activeVersion as string;
  if (!parsed.secrets[activeVersion]) {
    throw new Error(
      `EMAIL_SNAPSHOT_KEY_VERSION "${activeVersion}" has no matching key in EMAIL_SNAPSHOT_KEYS.`
    );
  }
  return { activeVersion, secrets: parsed.secrets };
};

export type SnapshotKeyringProblem = {
  severity: "error" | "warning";
  code:
    | "SNAPSHOT_KEYS_MISSING"
    | "SNAPSHOT_KEYS_UNPARSEABLE"
    | "SNAPSHOT_ACTIVE_VERSION_UNKNOWN"
    | "SNAPSHOT_ACTIVE_VERSION_UNPINNED";
  message: string;
};

/**
 * Everything wrong with the configured keyring, for a health check to report.
 *
 * Separated from `readSnapshotKeyring` because that one is allowed to throw
 * and a readiness check is not: the check has to survive the state it exists
 * to find. Errors and warnings are split the way `sendingIdentityProblems`
 * splits them -- an error refuses traffic, a warning is something an operator
 * should finish.
 *
 * Why a missing keyring is an error rather than a warning. The standard lane
 * (`lib/standardEmailLane.ts`) stores the personalisation inputs it rendered
 * from and refuses to store them in the clear, so without a keyring every
 * enqueue throws. Its four callers -- the welcome email, the subscription
 * receipt, the deletion notice and the restore notice -- each swallow that
 * throw so the user's own action still succeeds, which is right for them and
 * means the mail disappears with nothing on screen and one line in a log. The
 * lane is behind no feature flag, so this is live the moment the code is:
 * there is no "flag off, key absent" intermediate state to protect, which is
 * what makes this different from the image budget above it. An error here is
 * the only place the loss is visible before someone reports never receiving a
 * receipt.
 *
 * Nothing read from the environment is quoted back. A misconfiguration is
 * frequently a value pasted into the wrong variable, and the wrong variable
 * here holds key material -- so the messages carry counts and never the
 * version label or the secret.
 */
export const snapshotKeyringProblems = (
  env: NodeJS.ProcessEnv
): SnapshotKeyringProblem[] => {
  const parsed = parseSnapshotKeyring(env);
  const problems: SnapshotKeyringProblem[] = [];

  if (!parsed.configured) {
    problems.push({
      severity: "error",
      code: "SNAPSHOT_KEYS_MISSING",
      message:
        "EMAIL_SNAPSHOT_KEYS is not set. The standard email lane stores what each message was rendered from and will not store it unencrypted, so every enqueue throws and the mail is lost rather than delayed.",
    });
    return problems;
  }

  if (parsed.versions.length === 0) {
    problems.push({
      severity: "error",
      code: "SNAPSHOT_KEYS_UNPARSEABLE",
      message:
        "EMAIL_SNAPSHOT_KEYS is set but no `version:secret` pair could be read from it, so the keyring is empty while the variable looks configured.",
    });
    return problems;
  }

  if (parsed.pinnedVersion && !parsed.secrets[parsed.pinnedVersion]) {
    problems.push({
      severity: "error",
      code: "SNAPSHOT_ACTIVE_VERSION_UNKNOWN",
      message: `EMAIL_SNAPSHOT_KEY_VERSION names a version that is not among the ${parsed.versions.length} in EMAIL_SNAPSHOT_KEYS. Reading the keyring throws, so no message can be sealed and none of the existing rows can be read.`,
    });
    return problems;
  }

  if (!parsed.pinnedVersion && parsed.versions.length > 1) {
    // Not an error: writes still succeed and every version stays readable.
    // But which one seals new rows is then decided by the order the pairs
    // happen to appear in, so a rotation that adds a key before pinning it
    // moves the active version without anyone choosing to.
    problems.push({
      severity: "warning",
      code: "SNAPSHOT_ACTIVE_VERSION_UNPINNED",
      message: `EMAIL_SNAPSHOT_KEYS holds ${parsed.versions.length} versions and EMAIL_SNAPSHOT_KEY_VERSION is unset, so new snapshots are sealed under whichever pair is listed first rather than one that was chosen.`,
    });
  }

  return problems;
};

/** What a health check reports about the keyring. */
export const snapshotKeyringReadiness = (
  env: NodeJS.ProcessEnv = process.env
) => {
  const problems = snapshotKeyringProblems(env);
  const errors = problems.filter((problem) => problem.severity === "error");
  return {
    ready: errors.length === 0,
    errors,
    warnings: problems.filter((problem) => problem.severity === "warning"),
    /** Counts only -- see the note on `snapshotKeyringProblems`. */
    versionCount: parseSnapshotKeyring(env).versions.length,
  };
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
