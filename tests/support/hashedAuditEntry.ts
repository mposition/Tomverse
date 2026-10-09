// An AdminAuditLog row whose hash reproduces, for tests that read audit rows as
// evidence.
//
// The hash is computed with the real function and the key the verifier will
// read from the environment, so a fake row is only "valid" in the way a real
// one is: change any hashed field after building it and verification fails, as
// it would against the database.

import { computeAdminAuditEntryHash } from "@/lib/adminAuditIntegrityCore";

export const TEST_AUDIT_INTEGRITY_KEY = "test-audit-integrity-key-".padEnd(48, "k");

/** Point the verifier at the test key. Call once at the top of a test file. */
export const configureTestAuditIntegrityKey = () => {
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = TEST_AUDIT_INTEGRITY_KEY;
  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
};

export type StoredAuditRow = {
  id: string;
  previousHash: string | null;
  entryHash: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
};

/** A system row as `writeSystemAuditLog` writes one, hashed. */
export const hashedSystemAuditRow = (
  fields: {
    action: string;
    systemActor: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
  },
  overrides: Partial<StoredAuditRow> = {},
): StoredAuditRow => {
  const row: StoredAuditRow = {
    id: "audit-row-1",
    previousHash: "hash-of-the-row-before",
    entryHash: null,
    actorUserId: null,
    actorEmail: null,
    action: fields.action,
    targetType: fields.targetType,
    targetId: fields.targetId,
    summary: "A system entry.",
    metadata: { ...fields.metadata, systemActor: fields.systemActor },
    ipAddress: null,
    userAgent: null,
    createdAt: new Date("2026-09-22T09:00:00.000Z"),
    ...overrides,
  };
  row.entryHash = computeAdminAuditEntryHash(
    {
      previousHash: row.previousHash,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    },
    TEST_AUDIT_INTEGRITY_KEY,
  );
  return row;
};

/**
 * Answers the three reads the verifier makes, and nothing else: the entry
 * itself, the row before it (whose hash the entry must name) and the row after
 * it (none -- the entry is the tail unless a test says otherwise).
 */
export const auditEvidenceReads = (
  entry: StoredAuditRow | null,
  options: { before?: string | null; after?: { previousHash: string | null } | null } = {},
) => {
  const before = options.before === undefined ? entry?.previousHash ?? null : options.before;
  return (args?: {
    where?: { action?: string; OR?: unknown };
    orderBy?: Array<Record<string, string>>;
  }) => {
    if (args?.where?.action !== undefined) return entry;
    if (args?.where?.OR !== undefined) {
      const descending = args.orderBy?.[0]?.createdAt === "desc";
      return descending
        ? before === null
          ? null
          : { entryHash: before }
        : options.after ?? null;
    }
    return undefined;
  };
};
