/**
 * Verifying one audit entry for the trust-safety observer's activation
 * derivation (docs/policy/trust-safety-compliance-agent.md §6, checks 3 and 7).
 *
 * §6 asks whether *this* entry's signature verifies and, when a successor
 * exists, whether that one verifies too. The repository already had
 * `verifyAdminAuditIntegrity()`, but it walks the whole chain in batches and
 * answers a different question; asking it about two rows would read the entire
 * table, and the observer's transactions are bounded in statements (§5.5).
 *
 * **No second hash implementation.** The digest, the key-order history and the
 * key list are the chain's own, reached through `lib/adminAudit.ts` — the same
 * functions the writer signs with. A local HMAC here would be a second answer
 * to "is this entry authentic", and the two would drift at the next key
 * rotation.
 *
 * They come through `lib/adminAudit.ts` rather than from the integrity core
 * directly because §5.6's boundary stops at that module: importing the core
 * here would pull it into the observer's own files, where the section's
 * reflection rules apply and that file's `Object` use would fail them. Only
 * the hash helpers come through; this module appends nothing.
 *
 * This module reads the integrity keys from the environment, so it is not a
 * pure core: `lib/trustSafetyActivationCore.ts` takes the verdict as an input
 * and stays testable without secrets.
 */
import {
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeysForVerification,
  type AdminAuditHashInput,
} from "@/lib/adminAudit";

/**
 * The integrity keys, read one literal at a time.
 *
 * §5.6 allows `process.env.<literal>` in these files and nothing else -- not
 * the object in a variable, not passed as an argument, not destructured. So
 * the callers that need the keys (the observation round, and the activation
 * write's refusal when none is configured) take them from here rather than
 * each handing `process.env` to something.
 */
export const trustSafetyIntegrityKeyEnv = () => ({
  ADMIN_AUDIT_INTEGRITY_KEY: process.env.ADMIN_AUDIT_INTEGRITY_KEY,
  ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
});

export type TrustSafetyIntegrityKeyEnv = ReturnType<typeof trustSafetyIntegrityKeyEnv>;

/** The entry fields the digest is computed over, plus the stored hashes. */
export type TrustSafetyAuditEntryRow = {
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly summary: string;
  readonly metadata: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly previousHash: string | null;
  readonly entryHash: string | null;
};

/**
 * Whether the entry's stored hash is one this build can reproduce.
 *
 * Returns `null` for "could not be checked" rather than `false`, because §6
 * treats the two the same but the caller reports them differently: an entry
 * with no hash is `unhashed_entry_present`, and no key configured is a
 * deployment that cannot judge activation at all. Collapsing them into `false`
 * would describe a missing key as a failed signature.
 *
 * Every key is tried, newest first, and every verification key order within
 * each — that is what lets a chain survive a key rotation or the signing order
 * moving, which is why those helpers exist rather than one `createHmac` call.
 */
export const verifyTrustSafetyAuditEntry = ({
  row,
  env,
}: {
  readonly row: TrustSafetyAuditEntryRow;
  readonly env: {
    ADMIN_AUDIT_INTEGRITY_KEY?: string;
    ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS?: string;
    NEXTAUTH_SECRET?: string;
  };
}): boolean | null => {
  if (row.entryHash === null || row.entryHash === "") return null;
  const keys = adminAuditIntegrityKeysForVerification(env);
  if (keys.length === 0) return null;

  const input: AdminAuditHashInput = {
    previousHash: row.previousHash,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    // The writer passes `entry.metadata || null`, so a row stored without
    // metadata must be offered as null here or the digest will not reproduce.
    metadata: row.metadata ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };

  for (const key of keys) {
    const variants = adminAuditEntryHashVariants(input, key);
    // Both orders by name. §5.6 refuses a computed property access in these
    // files -- `variants[order]` over the exported order list is one, because
    // the key does not reduce to a literal here -- so the two are named, and
    // a test fails if the repository ever verifies under a third order that
    // this line does not mention.
    if (variants.locale === row.entryHash) return true;
    if (variants.codepoint === row.entryHash) return true;
  }
  return false;
};
