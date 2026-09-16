import "server-only";

import type { Prisma } from "@prisma/client";

import {
  SUPPRESSION_AUTHORITY_FENCE,
  SUPPRESSION_READ_AUTHORITY_KEY,
  suppressionReadAuthorityFromValue,
  type SuppressionReadAuthority,
} from "@/lib/emailSuppressionAuthorityCore";
import { prisma } from "@/lib/prisma";

/**
 * The read authority and the fence around switching it.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (deploy B, cutover fence).
 */

type Reader = Pick<Prisma.TransactionClient, "appSetting">;

/**
 * Which record decides, read on every call and never cached. The switch is a
 * single row; an instance that remembered the old value would keep deciding by
 * it after the cutover committed.
 */
export async function readSuppressionAuthority(
  client: Reader = prisma
): Promise<SuppressionReadAuthority> {
  const row = await client.appSetting.findUnique({
    where: { key: SUPPRESSION_READ_AUTHORITY_KEY },
    select: { value: true },
  });
  return suppressionReadAuthorityFromValue(row?.value);
}

/**
 * Taken first, in shared mode, by every transaction that writes or releases a
 * suppression. The cutover takes the same key exclusively, so no write can
 * start under one authority and commit under the other.
 */
export async function holdSuppressionFence(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${SUPPRESSION_AUTHORITY_FENCE}))`;
}

/**
 * Serialises every write, release and blocker check for one address, after
 * the fence. The fence only keeps writers apart from the cutover; writers
 * share it, so without this a lift that read the causes could be followed by
 * a new cause it never saw and still remove the entry as though nothing
 * remained. A row lock cannot do this -- the new cause is a row that does not
 * exist yet -- so it is an advisory lock on the normalised address.
 */
export async function lockSuppressionAddress(
  tx: Prisma.TransactionClient,
  normalizedAddress: string
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-suppression-address:${normalizedAddress}`}))`;
}

/** The cutover's side of the fence: waits for every in-flight writer to finish. */
export async function holdSuppressionFenceExclusive(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${SUPPRESSION_AUTHORITY_FENCE}))`;
}
