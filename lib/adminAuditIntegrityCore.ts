import { createHmac } from "node:crypto";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)])
    );
  }
  return value;
};

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
