import {
  computeAdminAuditEntryHash,
  type AdminAuditHashInput,
} from "@/lib/adminAuditIntegrityCore";

/**
 * Naming what changed on an audit entry that no longer verifies.
 *
 * A failing entry reports one thing — some byte is not what was signed — for
 * three situations an operator has to tell apart: a forged row, a column an
 * unrelated action rewrote, and a value the application later normalised. On
 * 2026-08-26 staging stopped exactly there: 115 of 116 entries verified, the
 * failure at the chain's first row, and the same key opening the 109 entries
 * after it — so not a key change, and nothing to say what about that row moved.
 *
 * This asks the inverted question. Not *does the row match* but *what would
 * have to be different for it to match*: the hash is re-derived under one
 * single-field variation at a time, and a variation that reproduces the stored
 * digest names the changed field outright.
 *
 * One difference at a time, deliberately. Two would let a match name a pair of
 * changes when only one is real, and specificity is the whole value here. No
 * match is an answer too: more than one field moved, or one not varied here.
 *
 * ## What this must never become
 *
 * It does not write. Re-hashing a broken row under the current key makes the
 * checker pass by editing the thing being checked, which ends what the chain
 * proves in the same motion — so nothing here takes a Prisma client.
 *
 * And a match reports the key by **position**, never the key. The panel that
 * renders this is where an operator diagnoses a chain, not where they learn
 * what signs it.
 */

export type AdminAuditReconstruction = {
  /** Human-readable description of the single difference from stored content. */
  label: string;
  input: AdminAuditHashInput;
};

export type AdminAuditDiagnosisMatch = {
  label: string;
  /** 1-based index into the key list. Never the key. */
  keyPosition: number;
};

export type AdminAuditDiagnosis = {
  verifiesAsStored: boolean;
  candidatesTried: number;
  keysTried: number;
  matches: AdminAuditDiagnosisMatch[];
  /**
   * The row names an actor by address but carries no user id.
   *
   * That is what `onDelete: SetNull` leaves behind: `actorUserId` is in the
   * hash input and also a foreign key, so deleting a user makes the database
   * null it on every audit row that user wrote, with no application code
   * involved. `actorEmail` is a plain column and survives, which is why the
   * pair is a fingerprint rather than a guess.
   *
   * Reported separately from `matches` because it is not one: the id cannot be
   * reconstructed. A cuid is not a value any candidate set can try, so this
   * says which mechanism fits without claiming to have reproduced the digest.
   */
  actorIdMissingWithEmail: boolean;
};

/** The input the verifier builds today, from the row exactly as stored. */
export const storedAdminAuditHashInput = (row: {
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
  createdAt: Date;
}): AdminAuditHashInput => ({
  previousHash: row.previousHash,
  actorUserId: row.actorUserId,
  actorEmail: row.actorEmail,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  summary: row.summary,
  metadata: row.metadata || null,
  ipAddress: row.ipAddress,
  userAgent: row.userAgent,
  createdAt: row.createdAt.toISOString(),
});

const NULLABLE_FIELDS = [
  "previousHash",
  "actorUserId",
  "actorEmail",
  "targetId",
  "ipAddress",
  "userAgent",
] as const;

export function adminAuditReconstructions(
  stored: AdminAuditHashInput
): AdminAuditReconstruction[] {
  const candidates: AdminAuditReconstruction[] = [
    { label: "as stored (no change)", input: stored },
  ];
  const vary = (field: keyof AdminAuditHashInput, value: unknown, label: string) =>
    candidates.push({ label, input: { ...stored, [field]: value } });

  // A nullable column that now carries a value, or carries one where the write
  // path recorded nothing. `onDelete: SetNull` on the actor relation puts
  // `actorUserId` here for real: deleting a user nulls it on every row that
  // user wrote, with no application code involved.
  for (const field of NULLABLE_FIELDS) {
    if (stored[field] !== null) vary(field, null, `${field}: was null`);
    if (stored[field] !== "") vary(field, "", `${field}: was ""`);
  }

  // The sentinel `getTrustedClientIp()` returns when no trusted header
  // resolves. Worth both directions: a row could predate the sentinel, or have
  // been normalised into it afterwards.
  if (stored.ipAddress !== "unknown") {
    vary("ipAddress", "unknown", 'ipAddress: was "unknown"');
  }

  // Timestamp precision. `clock_timestamp()` is microsecond and the column is
  // millisecond, so a row written through a path that rounded differently
  // carries a digest over a timestamp the column can no longer express.
  const iso = stored.createdAt;
  const seconds = `${iso.slice(0, 19)}.000Z`;
  if (seconds !== iso) vary("createdAt", seconds, "createdAt: was second-precision");
  vary("createdAt", `${iso.slice(0, 19)}Z`, "createdAt: was without milliseconds");

  // Metadata, the field most likely to have gained shape over time: a key
  // added to what an action records changes every later digest but should not
  // touch an existing row — unless something rewrote it.
  const metadata = stored.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const entries = Object.entries(metadata as Record<string, unknown>);
    vary("metadata", null, "metadata: was null");
    vary("metadata", {}, "metadata: was {}");
    for (const [key, value] of entries) {
      vary(
        "metadata",
        Object.fromEntries(entries.filter(([name]) => name !== key)),
        `metadata: had no "${key}"`
      );
      if (value !== null) {
        vary(
          "metadata",
          { ...(metadata as Record<string, unknown>), [key]: null },
          `metadata."${key}": was null`
        );
      }
      if (Array.isArray(value)) {
        vary(
          "metadata",
          { ...(metadata as Record<string, unknown>), [key]: [...value].reverse() },
          `metadata."${key}": was in the reverse order`
        );
        vary(
          "metadata",
          { ...(metadata as Record<string, unknown>), [key]: [] },
          `metadata."${key}": was empty`
        );
      }
    }
  }

  return candidates;
}

export function diagnoseAdminAuditEntry(
  stored: AdminAuditHashInput,
  entryHash: string,
  keys: readonly string[]
): AdminAuditDiagnosis {
  const candidates = adminAuditReconstructions(stored);
  const matches: AdminAuditDiagnosisMatch[] = [];
  for (const candidate of candidates) {
    for (const [index, secret] of keys.entries()) {
      if (computeAdminAuditEntryHash(candidate.input, secret) === entryHash) {
        matches.push({ label: candidate.label, keyPosition: index + 1 });
      }
    }
  }
  return {
    verifiesAsStored: matches.some(
      (match) => match.label === "as stored (no change)"
    ),
    candidatesTried: candidates.length,
    keysTried: keys.length,
    matches,
    actorIdMissingWithEmail:
      stored.actorUserId === null && Boolean(stored.actorEmail),
  };
}
