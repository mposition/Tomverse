import { createHmac } from "node:crypto";

/**
 * Object keys are sorted before hashing, and *how* they are sorted is part of
 * the signature.
 *
 * The signing order is `localeCompare`, and that is a defect kept deliberately
 * rather than corrected in place. `localeCompare` compares under the runtime's
 * collation -- ICU data and the default locale -- which is not a property of
 * the data being signed. Two of this repository's own audit metadata keys
 * order differently under it than by code point:
 *
 *   creditUsd    vs creditsPurchased
 *   requestType  vs requestedById
 *
 * so a row carrying such a pair hashes differently under a different
 * collation, with nothing about the row having changed. A canonical form for a
 * digest must depend only on the bytes.
 *
 * It cannot simply be swapped: every existing entry was signed under
 * `localeCompare`, and changing the signing order would invalidate all of them
 * at once -- the same wholesale loss that key rotation caused, for the same
 * reason. Migrating it is a deliberate change with its own epoch, recorded in
 * docs/ops/admin-audit-key-epochs.md.
 *
 * What is safe now is *verifying* under either order, which is what the
 * comparator argument is for: `adminAuditEntryHashVariants()` re-derives a
 * digest under code-point order so a diagnosis can say outright whether a
 * collation change is what broke a row. Signing never uses it.
 */
export const ADMIN_AUDIT_KEY_ORDERS = {
  /** What every entry to date was signed under. Collation-dependent. */
  locale: (left: string, right: string) => left.localeCompare(right),
  /** Byte order. Depends on nothing but the key names themselves. */
  codepoint: (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0,
} as const;

export type AdminAuditKeyOrder = keyof typeof ADMIN_AUDIT_KEY_ORDERS;

const canonicalWith = (
  compare: (left: string, right: string) => number,
  value: unknown
): unknown => {
  if (Array.isArray(value)) return value.map((item) => canonicalWith(compare, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, nested]) => [key, canonicalWith(compare, nested)])
    );
  }
  return value;
};

const canonical = (value: unknown): unknown =>
  canonicalWith(ADMIN_AUDIT_KEY_ORDERS.locale, value);

export type AdminAuditHashInput = {
  previousHash: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

export const computeAdminAuditEntryHash = (
  input: AdminAuditHashInput,
  secret: string
) =>
  createHmac("sha256", secret)
    .update(JSON.stringify(canonical(input)))
    .digest("hex");

/**
 * The same digest under each key order, for diagnosis only.
 *
 * A row that verifies under `codepoint` but not under `locale` was signed by a
 * runtime whose collation differed from this one's -- which is a fact about
 * the container, not about the row, and not something an operator could ever
 * have worked out from "an audit entry hash does not match its stored
 * content".
 */
export const adminAuditEntryHashVariants = (
  input: AdminAuditHashInput,
  secret: string
): Record<AdminAuditKeyOrder, string> =>
  Object.fromEntries(
    Object.entries(ADMIN_AUDIT_KEY_ORDERS).map(([order, compare]) => [
      order,
      createHmac("sha256", secret)
        .update(JSON.stringify(canonicalWith(compare, input)))
        .digest("hex"),
    ])
  ) as Record<AdminAuditKeyOrder, string>;

/**
 * The keys an audit entry may have been signed with, newest first.
 *
 * Signing always uses the first one. Verification tries each in turn, which is
 * what lets a chain survive a key change instead of being written off at the
 * rotation point.
 *
 * The shape is deliberately asymmetric. `ADMIN_AUDIT_INTEGRITY_KEY` (falling
 * back to `NEXTAUTH_SECRET`) stays exactly what it was — the key entries are
 * written with — and `ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS` only ever adds keys
 * that verification may try. An operator adding history can therefore never
 * change what new entries are signed with, which a single combined list would
 * have let them do by reordering it.
 *
 * A listed key can still produce entries that verify. Two things follow, and
 * both belong to whoever edits the variable: a key believed compromised must
 * not be listed, and a historical key should be dropped once the span it
 * covers no longer needs verifying. `docs/ops/admin-audit-key-epochs.md`
 * records which span each one is there for.
 */
export const adminAuditIntegrityKeys = (env: {
  ADMIN_AUDIT_INTEGRITY_KEY?: string;
  ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS?: string;
  NEXTAUTH_SECRET?: string;
}): string[] => {
  const current = env.ADMIN_AUDIT_INTEGRITY_KEY || env.NEXTAUTH_SECRET || "";
  const previous = (env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS || "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  // `current` first, and de-duplicated: a previous key that is also the current
  // one would otherwise make every row cost a second HMAC to reach the same
  // answer, and would report two keys in use where there is one.
  return [current, ...previous].filter(
    (key, index, all) => key.length > 0 && all.indexOf(key) === index
  );
};
