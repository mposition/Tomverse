import "server-only";

import {
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeys,
} from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";

/**
 * Verifying the admin audit chain across a change of signing key.
 *
 * The chain is HMAC-signed, and until 2026-08-25 neither environment set
 * `ADMIN_AUDIT_INTEGRITY_KEY`, so the key was `NEXTAUTH_SECRET` — the session
 * secret. Rotating that is a routine and sometimes mandatory security action,
 * and doing it silently invalidated every entry written before it. The
 * 2026-08-16 audit recorded 53 entries verifying; by 2026-08-21 the same chain
 * failed on its oldest row. Nothing had been tampered with. The key had moved.
 *
 * Verifying against one key made that indistinguishable from an altered entry,
 * and made it permanent: there was no way to express "this span was signed
 * with something else". So verification tries each key in
 * `adminAuditIntegrityKeys()`, newest first, and an entry counts as verified
 * when any of them reproduces its hash. Signing still uses only the first.
 *
 * Two properties are worth stating because they are why this is not simply
 * weaker than before.
 *
 * An entry still cannot be forged without possessing a listed key. Adding a
 * key the operator already had does not lower that bar; listing a key believed
 * compromised would, which is why the key list's own documentation says not to.
 *
 * And the walk no longer stops at the first failure. Stopping meant a single
 * unverifiable row hid the state of every row after it — the reason two
 * staging rounds could not tell how much of the chain was affected. Every row
 * is now checked and counted, so "one bad entry" and "nothing verifies at all"
 * are different answers rather than the same one.
 */

/** How many failing ids a response carries. The counts stay exact. */
const UNVERIFIED_IDS_REPORTED = 25;

type Failure = {
  id: string;
  createdAt: string;
  /** Whether the stored `previousHash` still matches the row before it. */
  linkageIntact: boolean;
};

export async function verifyAdminAuditIntegrity() {
  const keys = adminAuditIntegrityKeys(process.env);
  if (keys.length === 0) {
    return {
      configured: false,
      valid: false,
      checkedEntries: 0,
      verifiedEntries: 0,
      firstInvalidId: null as string | null,
      firstCheckedId: null as string | null,
      unverifiedIds: [] as string[],
      unverifiedIdsTruncated: 0,
      firstInvalidIsOldest: false,
      invalidEntries: 0,
      linkageBreaks: 0,
      keysAvailable: 0,
      keysUsed: 0,
      keyEntryCounts: [] as number[],
      legacyOrderEntries: 0,
      unverifiedPrefix: 0,
      message: "ADMIN_AUDIT_INTEGRITY_KEY or NEXTAUTH_SECRET is not configured.",
    };
  }

  const rows = await prisma.adminAuditLog.findMany({
    where: { entryHash: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  let previousEntryHash: string | null = null;
  let verified = 0;
  let linkageBreaks = 0;
  const failures: Failure[] = [];
  // How many entries each supplied key accounted for, index-aligned with
  // `keys`. The count, not just the fact that a key worked: a rotation splits
  // the chain into spans, and the sizes of those spans are what tell an
  // operator whether a listed key is doing the job they listed it for. Only
  // positions are reported -- never a key, and nothing derived from one.
  const keyEntryCounts = keys.map(() => 0);
  // Entries that reproduce only under the *legacy* key order -- signed before
  // 2026-08-27, and carrying one of the metadata key pairs `localeCompare`
  // orders differently from code point. These are the rows that would break if
  // this runtime's collation changed, and nothing can re-sign them. The number
  // only falls, and at zero the legacy order can be dropped from
  // `ADMIN_AUDIT_VERIFICATION_KEY_ORDERS`.
  let legacyOrderEntries = 0;
  // Leading entries, oldest first, whose content no verification key opens.
  // A changed signing key invalidates a *contiguous span*, so the size of this
  // prefix is what separates "an epoch nobody has the key for" from "one row
  // that no longer reproduces its own hash" -- readings the first-failure id
  // alone cannot tell apart.
  let unverifiedPrefix = 0;
  let stillInPrefix = true;

  for (const row of rows) {
    const input = {
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
    };

    // Each key against each order, signing order first. The orders agree on
    // every object whose keys do not straddle a collation difference, so for
    // almost every row the second one is never reached.
    let keyIndex = -1;
    let matchedOrder: (typeof ADMIN_AUDIT_VERIFICATION_KEY_ORDERS)[number] | null =
      null;
    for (let index = 0; index < keys.length && keyIndex < 0; index += 1) {
      const variants = adminAuditEntryHashVariants(input, keys[index]);
      for (const order of ADMIN_AUDIT_VERIFICATION_KEY_ORDERS) {
        if (variants[order] === row.entryHash) {
          keyIndex = index;
          matchedOrder = order;
          break;
        }
      }
    }
    if (matchedOrder && matchedOrder !== ADMIN_AUDIT_SIGNING_KEY_ORDER) {
      legacyOrderEntries += 1;
    }
    // Linkage is checked whether or not the content verified, and it is worth
    // having separately: `previousHash` is a stored value compared against a
    // stored value, so a deletion or a reordering is still detectable in a span
    // no available key can open.
    const linkageValid =
      previousEntryHash === null || row.previousHash === previousEntryHash;
    if (!linkageValid) linkageBreaks += 1;

    if (keyIndex >= 0) {
      keyEntryCounts[keyIndex] += 1;
      verified += 1;
      stillInPrefix = false;
    } else if (stillInPrefix) {
      unverifiedPrefix += 1;
    }
    if (keyIndex < 0 || !linkageValid) {
      failures.push({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        linkageIntact: linkageValid,
      });
    }
    previousEntryHash = row.entryHash;
  }

  const firstInvalid = failures[0] ?? null;
  const valid = failures.length === 0;
  const keysUsedCount = keyEntryCounts.filter((count) => count > 0).length;
  return {
    configured: true,
    valid,
    checkedEntries: rows.length,
    verifiedEntries: verified,
    invalidEntries: failures.length,
    linkageBreaks,
    firstInvalidId: firstInvalid?.id ?? null,
    firstCheckedId: rows[0]?.id ?? null,
    /**
     * Every entry that did not verify, oldest first, bounded.
     *
     * Reporting only the first was enough while one row failed. On
     * 2026-08-26 nine did -- eight of them rows that had verified an hour
     * earlier -- and the panel could still name and diagnose exactly one: the
     * oldest, which is the least informative of the nine. A row that was fine
     * an hour ago and is not now bounds the window it changed in; a row that
     * has been broken since July does not.
     *
     * Bounded because a chain that fails wholesale would otherwise put every
     * id it has into a response and a screen. The count above stays exact, so
     * the cap shortens the list without softening the verdict.
     */
    unverifiedIds: failures.slice(0, UNVERIFIED_IDS_REPORTED).map((f) => f.id),
    unverifiedIdsTruncated: Math.max(
      0,
      failures.length - UNVERIFIED_IDS_REPORTED
    ),
    // Kept from the previous shape: the panel reads it to say whether a
    // changed key explains the failure on its own.
    firstInvalidIsOldest: Boolean(
      firstInvalid && rows[0]?.id === firstInvalid.id
    ),
    keysAvailable: keys.length,
    keysUsed: keysUsedCount,
    keyEntryCounts,
    legacyOrderEntries,
    unverifiedPrefix,
    message: valid
      ? rows.length === 0
        ? "No hash-chained audit entries exist yet."
        : keysUsedCount > 1
          ? `The HMAC audit chain is valid across ${keysUsedCount} signing keys.`
          : "The HMAC audit chain is valid."
      : linkageBreaks > 0
        ? "The audit chain linkage is broken."
        : "An audit entry hash does not match its stored content.",
  };
}
