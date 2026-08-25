import "server-only";

import {
  computeAdminAuditEntryHash,
  parseAdminAuditKeyring,
  secretForEpoch,
} from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";

/**
 * Verifying the hash chain under the key that signed each entry.
 *
 * Contract: docs/ops/admin-audit-key-epochs.md.
 *
 * ## Three verdicts, not two
 *
 * `valid` and `invalid` cannot express the state a rotation produces, and
 * collapsing it into `invalid` is what made the checker useless the moment a
 * key changed. An entry whose epoch has no secret in the environment is
 * **unverifiable**: nothing about it is known to be wrong, and nothing about it
 * has been checked. Reporting that as a pass would make a missing key
 * indistinguishable from evidence of integrity — which is the escape hatch this
 * closes — and reporting it as tampering cries wolf until nobody reads the
 * check at all.
 *
 * ## Why the walk no longer stops at the first problem
 *
 * It still stops at the first *invalid* row, because after a real break the
 * linkage downstream means nothing. But it walks past unverifiable rows,
 * carrying their `entryHash` forward as the linkage value, so an epoch whose key
 * is gone does not hide the epochs after it. That is the difference between
 * "we lost one key" and "the chain is dark from here on".
 */
export async function verifyAdminAuditIntegrity() {
  const keyring = parseAdminAuditKeyring(process.env);
  const anyKey = keyring.epochs.length > 0 || keyring.legacySecret !== null;
  if (!anyKey) {
    return {
      configured: false,
      valid: false,
      checkedEntries: 0,
      verifiedEntries: 0,
      unverifiableEntries: 0,
      byEpoch: [] as Array<{
        epoch: string | null;
        entries: number;
        verifiable: boolean;
      }>,
      firstInvalidId: null as string | null,
      firstCheckedId: null as string | null,
      firstInvalidIsOldest: false,
      pinnedEpochMissing: keyring.pinnedEpochMissing,
      message:
        "No audit signing key is configured: set ADMIN_AUDIT_INTEGRITY_KEYS, or ADMIN_AUDIT_INTEGRITY_KEY for the pre-epoch chain.",
    };
  }

  const rows = await prisma.adminAuditLog.findMany({
    where: { entryHash: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  /** Entries per epoch, and whether this environment can check them at all. */
  const epochCounts = new Map<string | null, { entries: number; verifiable: boolean }>();
  const countEpoch = (epoch: string | null, verifiable: boolean) => {
    const seen = epochCounts.get(epoch);
    if (seen) seen.entries += 1;
    else epochCounts.set(epoch, { entries: 1, verifiable });
  };
  const byEpoch = () =>
    [...epochCounts.entries()].map(([epoch, counts]) => ({ epoch, ...counts }));

  let previousEntryHash: string | null = null;
  let verifiedEntries = 0;
  let unverifiableEntries = 0;

  for (const row of rows) {
    const secret = secretForEpoch(keyring, row.keyEpoch);
    if (!secret) {
      // Never a pass. The row is counted, reported by its epoch, and its hash
      // still carries the linkage forward so later epochs remain checkable.
      countEpoch(row.keyEpoch, false);
      unverifiableEntries += 1;
      previousEntryHash = row.entryHash;
      continue;
    }
    countEpoch(row.keyEpoch, true);

    const computed = computeAdminAuditEntryHash(
      {
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
      },
      secret
    );
    const linkageValid =
      previousEntryHash === null || row.previousHash === previousEntryHash;

    if (computed !== row.entryHash || !linkageValid) {
      return {
        configured: true,
        valid: false,
        checkedEntries: rows.length,
        verifiedEntries,
        unverifiableEntries,
        byEpoch: byEpoch(),
        firstInvalidId: row.id,
        firstCheckedId: rows[0]?.id ?? null,
        // The bit that separates the two explanations for a failing chain, and
        // free here because the rows are already ordered.
        //
        // A break in the middle means the entries before it verified under
        // their own keys and this one did not -- which is what tampering looks
        // like. The first entry failing means nothing has verified at all.
        //
        // With epochs that second reading is now rarer and more specific: a key
        // that changed no longer produces it, because those rows are reported
        // unverifiable instead. So this failing at the oldest entry means the
        // key named for that epoch is the wrong key, not merely a different one.
        firstInvalidIsOldest: rows[0]?.id === row.id,
        pinnedEpochMissing: keyring.pinnedEpochMissing,
        message:
          computed !== row.entryHash
            ? "An audit entry hash does not match its stored content."
            : "The audit chain linkage is broken.",
      };
    }
    verifiedEntries += 1;
    previousEntryHash = row.entryHash;
  }

  const unverifiable = unverifiableEntries > 0;
  return {
    configured: true,
    // Nothing failed, and `valid` says only that. `unverifiableEntries` is
    // beside it rather than folded into it, so a reader is never told the whole
    // chain checked out when part of it could not be read.
    valid: true,
    checkedEntries: rows.length,
    verifiedEntries,
    unverifiableEntries,
    byEpoch: byEpoch(),
    firstInvalidId: null as string | null,
    firstCheckedId: rows[0]?.id ?? null,
    firstInvalidIsOldest: false,
    pinnedEpochMissing: keyring.pinnedEpochMissing,
    message:
      rows.length === 0
        ? "No hash-chained audit entries exist yet."
        : unverifiable
          ? `${verifiedEntries} of ${rows.length} entries verified. ${unverifiableEntries} could not be checked because their signing key is not in this environment — see docs/ops/admin-audit-key-epochs.md.`
          : "The HMAC audit chain is valid.",
  };
}
