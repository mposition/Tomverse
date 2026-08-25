import "server-only";

import { computeAdminAuditEntryHash } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";

export async function verifyAdminAuditIntegrity() {
  const secret = process.env.ADMIN_AUDIT_INTEGRITY_KEY || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return {
      configured: false,
      valid: false,
      checkedEntries: 0,
      firstInvalidId: null as string | null,
      firstCheckedId: null as string | null,
      firstInvalidIsOldest: false,
      message: "ADMIN_AUDIT_INTEGRITY_KEY or NEXTAUTH_SECRET is not configured.",
    };
  }
  const rows = await prisma.adminAuditLog.findMany({
    where: { entryHash: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let previousEntryHash: string | null = null;
  for (const row of rows) {
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
    const linkageValid = previousEntryHash === null || row.previousHash === previousEntryHash;
    if (computed !== row.entryHash || !linkageValid) {
      return {
        configured: true,
        valid: false,
        checkedEntries: rows.length,
        firstInvalidId: row.id,
        firstCheckedId: rows[0]?.id ?? null,
        // The one bit that separates the two explanations for a failing chain,
        // and it is free here because the rows are already ordered.
        //
        // A break in the middle means the entries before it verified under the
        // current key and this one did not -- which is what tampering looks
        // like. The first entry failing means no entry has been checked
        // successfully at all, which is what a changed signing key looks like:
        // everything written under the old one stops verifying at once.
        //
        // The verifier stops at the first failure either way, so without this
        // the reader cannot tell which they are looking at.
        firstInvalidIsOldest: rows[0]?.id === row.id,
        message: computed !== row.entryHash
          ? "An audit entry hash does not match its stored content."
          : "The audit chain linkage is broken.",
      };
    }
    previousEntryHash = row.entryHash;
  }
  return {
    configured: true,
    valid: true,
    checkedEntries: rows.length,
    firstInvalidId: null as string | null,
    firstCheckedId: rows[0]?.id ?? null,
    firstInvalidIsOldest: false,
    message: rows.length > 0
      ? "The HMAC audit chain is valid."
      : "No hash-chained audit entries exist yet.",
  };
}
