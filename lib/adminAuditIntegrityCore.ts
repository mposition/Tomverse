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
 * Which key signed an entry, and how a rotation stops looking like tampering.
 *
 * Contract: docs/ops/admin-audit-key-epochs.md.
 *
 * ## The failure this exists for
 *
 * The chain was verified against **one** secret. The moment
 * `ADMIN_AUDIT_INTEGRITY_KEY` changed, every row written under the old one
 * failed, the walk stopped at the oldest of them, and the endpoint reported the
 * same thing it reports for a forged row: a hash that does not match its
 * content. Three consequences, worst first — a rotation makes the check
 * permanently red and a permanently red check is one nobody reads; anyone who
 * can set the variable can turn "these rows were altered" into "these rows
 * predate the current key", because the two were the same observation; and
 * rotating at all became effectively forbidden, including after an exposure,
 * which is exactly when it must happen.
 *
 * ## The shape
 *
 * `ADMIN_AUDIT_INTEGRITY_KEYS` is `epoch:secret` pairs separated by commas and
 * `ADMIN_AUDIT_INTEGRITY_KEY_VERSION` names the epoch new entries are signed
 * under — the same shape `EMAIL_SNAPSHOT_KEYS` uses, deliberately, so an
 * operator learns one convention rather than two. A rotation is a deploy that
 * adds a pair and moves the pointer; every older epoch keeps verifying.
 *
 * ## What a missing key is
 *
 * **Unverifiable, never valid.** An epoch whose secret is no longer in the
 * environment cannot be checked, and reporting that as a pass would make the
 * absence of a key indistinguishable from evidence of integrity — which is the
 * escape hatch this was built to close. It is equally not a failure: nothing
 * about those rows is known to be wrong.
 */
export const parseAdminAuditKeyring = (env: {
  ADMIN_AUDIT_INTEGRITY_KEYS?: string;
  ADMIN_AUDIT_INTEGRITY_KEY_VERSION?: string;
  ADMIN_AUDIT_INTEGRITY_KEY?: string;
  NEXTAUTH_SECRET?: string;
}) => {
  const raw = env.ADMIN_AUDIT_INTEGRITY_KEYS?.trim();
  const secrets: Record<string, string> = {};
  if (raw) {
    for (const pair of raw.split(",")) {
      const separator = pair.indexOf(":");
      if (separator <= 0) continue;
      const epoch = pair.slice(0, separator).trim();
      const secret = pair.slice(separator + 1).trim();
      if (epoch && secret) secrets[epoch] = secret;
    }
  }

  /**
   * The key rows written before epochs existed were signed under.
   *
   * Kept, and kept including the `NEXTAUTH_SECRET` fallback, because
   * `docs/ops/admin-audit-key-epochs.md` records that both environments are
   * relying on that fallback today. Removing it here would not tighten
   * anything — it would make every existing row unverifiable on deploy, which
   * is the outcome this change exists to prevent. New epochs must be named
   * explicitly; the fallback reaches the past only.
   */
  const legacySecret =
    env.ADMIN_AUDIT_INTEGRITY_KEY?.trim() || env.NEXTAUTH_SECRET?.trim() || null;

  const epochs = Object.keys(secrets);
  const pinned = env.ADMIN_AUDIT_INTEGRITY_KEY_VERSION?.trim() || null;
  return {
    secrets,
    epochs,
    legacySecret,
    /**
     * The epoch a new entry is signed under, or `null` to sign under the
     * legacy key and record no epoch — which is what every deployment does
     * until somebody configures a keyring.
     */
    activeEpoch: pinned && secrets[pinned] ? pinned : null,
    /** Set but unusable: named an epoch the keyring does not carry. */
    pinnedEpochMissing: Boolean(pinned) && !secrets[pinned as string],
  };
};

export type AdminAuditKeyring = ReturnType<typeof parseAdminAuditKeyring>;

/**
 * The secret that signed a row, by its recorded epoch.
 *
 * `null` epoch means the row predates the keyring and was signed under the
 * legacy key. A named epoch with no secret returns `null`, and the caller must
 * report that row unverifiable rather than assuming anything about it.
 */
export const secretForEpoch = (
  keyring: AdminAuditKeyring,
  epoch: string | null
): string | null =>
  epoch === null ? keyring.legacySecret : (keyring.secrets[epoch] ?? null);
