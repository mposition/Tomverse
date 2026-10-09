import "server-only";

import type { Prisma } from "@prisma/client";

/** Caller must already hold the idea row FOR UPDATE. A hold writer uses the
 * same row, so it cannot slip between this check and the ciphertext purge. */
export async function amuxIdeaHasActiveRetentionHold(tx: Prisma.TransactionClient,
  ideaId: string, now: Date): Promise<boolean> {
  const hold = await tx.amuxIdeaRetentionHold.findFirst({
    where: { ideaId, releasedAt: null, expiresAt: { gt: now } },
    select: { id: true },
  });
  return hold !== null;
}
