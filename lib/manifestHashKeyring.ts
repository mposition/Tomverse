/**
 * The keys a context manifest is digested with, and their ids.
 *
 * ## Why not `NEXTAUTH_SECRET`
 *
 * The manifest digests were keyed with the session secret, which is wrong in a
 * way that only shows up later. `NEXTAUTH_SECRET` is an authentication key: it
 * gets rotated when a session-signing concern arises, on a schedule nobody
 * consults the audit trail about. The moment it rotates, every manifest
 * written before the rotation becomes uncheckable -- the commitment is still
 * there, and nothing can say what it commits to. A ninety-day audit record
 * cannot hang off a key whose rotation policy belongs to something else.
 *
 * So the manifest keyring is its own, and every manifest records the *id* of
 * the key that digested it. The key itself is never stored: an audit record
 * that carried its own verification key would let anyone who read the table
 * forge a matching one.
 *
 * ## What the digest actually proves
 *
 * Not what the previous version of this comment claimed. A user holding the
 * original request cannot verify anything, because they do not have the key.
 * What the commitment supports is server-side: Tomverse can take a candidate
 * original -- produced in a dispute, an export, or an investigation -- and
 * check whether it is the request that was effective at dispatch. That is an
 * integrity commitment, not a user-verifiable proof, and calling it the second
 * thing would promise an ability nobody has.
 *
 * A keyed digest is still the right shape for it. An unkeyed hash of a short
 * message is a dictionary away from the message, and the manifest exists
 * precisely so the message does not have to be kept.
 */

export const MANIFEST_HASH_ALGORITHM = "hmac-sha256";

/** `MANIFEST_HASH_KEYS=id:secret,id2:secret2` */
export const MANIFEST_HASH_KEYS_ENV = "MANIFEST_HASH_KEYS";
/** Which id new manifests are digested with. Must name a key above. */
export const MANIFEST_HASH_ACTIVE_KEY_ENV = "MANIFEST_HASH_ACTIVE_KEY_ID";

export class ManifestHashKeyringError extends Error {}

export type ManifestHashKey = { keyId: string; secret: string };

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Every configured key, by id.
 *
 * Old keys stay in the ring after a rotation. That is the whole point of an
 * id: a manifest digested last quarter is still checkable this quarter, and
 * dropping a key from the ring is the deliberate act of deciding those records
 * no longer need to be.
 */
export const manifestHashKeyring = (
  environment: Record<string, string | undefined> = process.env
): ReadonlyMap<string, string> => {
  const raw = environment[MANIFEST_HASH_KEYS_ENV] ?? "";
  const keys = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new ManifestHashKeyringError(
        `${MANIFEST_HASH_KEYS_ENV} entries must be "keyId:secret".`
      );
    }
    const keyId = trimmed.slice(0, separator);
    const secret = trimmed.slice(separator + 1);
    if (!KEY_ID_PATTERN.test(keyId)) {
      // The id is written into every manifest and read back in reports and
      // queries. Keeping it to a boring alphabet means it never has to be
      // escaped by whatever reads it next.
      throw new ManifestHashKeyringError(
        `"${keyId}" is not a usable manifest hash key id.`
      );
    }
    if (secret.length < 32) {
      throw new ManifestHashKeyringError(
        `The manifest hash key "${keyId}" is too short to be a key.`
      );
    }
    if (keys.has(keyId)) {
      // Two secrets under one id would make the id meaningless, and the
      // manifests written under it unverifiable against either.
      throw new ManifestHashKeyringError(
        `The manifest hash key id "${keyId}" is configured twice.`
      );
    }
    keys.set(keyId, secret);
  }
  return keys;
};

/**
 * The key new manifests are digested with.
 *
 * Throws rather than falling back. A fallback would be a silent downgrade to
 * an unkeyed or wrongly-keyed digest, and a manifest whose key nobody can name
 * is worse than a manifest that was never written: the first looks like
 * evidence.
 */
export const activeManifestHashKey = (
  environment: Record<string, string | undefined> = process.env
): ManifestHashKey => {
  const keyring = manifestHashKeyring(environment);
  const keyId = environment[MANIFEST_HASH_ACTIVE_KEY_ENV] ?? "";
  if (keyId === "") {
    throw new ManifestHashKeyringError(
      `${MANIFEST_HASH_ACTIVE_KEY_ENV} is not set, so no manifest can be digested.`
    );
  }
  const secret = keyring.get(keyId);
  if (!secret) {
    throw new ManifestHashKeyringError(
      `${MANIFEST_HASH_ACTIVE_KEY_ENV} names "${keyId}", which is not in ${MANIFEST_HASH_KEYS_ENV}.`
    );
  }
  return { keyId, secret };
};

/**
 * The key a stored manifest was digested with, or null.
 *
 * Null is an answer: it means the record cannot be checked with what this
 * deployment holds, which a verifier must report rather than treat as a
 * mismatch. "This does not match" and "nothing here can tell" are different
 * findings and only one of them is evidence of anything.
 */
export const manifestHashKeyById = (
  keyId: string | null | undefined,
  environment: Record<string, string | undefined> = process.env
): ManifestHashKey | null => {
  if (!keyId) return null;
  const secret = manifestHashKeyring(environment).get(keyId);
  return secret ? { keyId, secret } : null;
};
