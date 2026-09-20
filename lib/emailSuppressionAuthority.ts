import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * The lock one address's suppression writes are serialised by.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (deploy B, cutover fence), as amended by deploy D.
 *
 * Deploy B put two locks here. The outer one -- the fence -- kept every
 * suppression writer on one side of the cutover that switched the read
 * authority, by being held in shared mode by writers and exclusively by the
 * cutover itself. Deploy D deleted the setting and the cutover, and a shared
 * advisory lock with no exclusive holder anywhere in the tree excludes
 * nothing: every acquisition succeeds immediately. Keeping it would have left
 * nine acquisitions across eight modules claiming a protection that had stopped
 * existing, which is worse than not having it. `lockSuppressionAddress` was always the one doing
 * the work, and it is now taken first.
 */

/**
 * Serialises every write, release and blocker check for one address.
 *
 * Without it a lift that read the causes could be followed by a new cause it
 * never saw, and release a selector as though nothing remained. A row lock
 * cannot do this -- the new cause is a row that does not exist yet -- so it is
 * an advisory lock on the normalised address.
 */
export async function lockSuppressionAddress(
  tx: Prisma.TransactionClient,
  normalizedAddress: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-suppression-address:${normalizedAddress}`}))`;
}
