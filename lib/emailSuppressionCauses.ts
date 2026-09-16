import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Suppression causes, written beside the entries (the shadow deploy).
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.
 *
 * Nothing reads a cause to decide a send yet. What this module guarantees is
 * that every entry write made by this build has its cause in the same
 * transaction, and that the transaction is marked so the entry trigger -- which
 * exists to carry writes from a build that does not write causes -- does not
 * write a second one.
 */

export type SuppressionScope = "global" | "classification" | "purpose";

/**
 * Marks the current transaction as one that writes its own causes.
 *
 * `set_config(..., true)` is `SET LOCAL`: it ends with the transaction, so it
 * cannot leak to another request that later borrows the same connection.
 */
export async function markCauseWriter(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT set_config('app.suppression_writer', 'causes', true)`;
}

export type SuppressionCauseInput = {
  emailAddress: string;
  scope: SuppressionScope;
  purposeKey: string;
  reason: string;
  source: string;
  /** Stable per writer; the unique key makes a retried event a no-op. */
  sourceEventKey: string;
  sourceStream?: string | null;
  sourceDomain?: string | null;
  sourceClassification?: string | null;
  sourceDeliveryId?: string | null;
  sourceMessageId?: string | null;
  sourceRequestId?: string | null;
  providerAccount?: string | null;
  evidence?: Prisma.InputJsonValue;
  occurredAt: Date;
  expiresAt?: Date | null;
};

/** Records one cause, once. Returns whether a row was written. */
export async function recordSuppressionCause(
  tx: Prisma.TransactionClient,
  input: SuppressionCauseInput
): Promise<boolean> {
  const result = await tx.suppressionCause.createMany({
    data: [
      {
        emailAddress: input.emailAddress,
        scope: input.scope,
        purposeKey: input.purposeKey,
        reason: input.reason,
        source: input.source,
        sourceEventKey: input.sourceEventKey,
        sourceStream: input.sourceStream ?? null,
        sourceDomain: input.sourceDomain ?? null,
        sourceClassification: input.sourceClassification ?? null,
        sourceDeliveryId: input.sourceDeliveryId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceRequestId: input.sourceRequestId ?? null,
        providerAccount: input.providerAccount ?? input.sourceStream ?? null,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        occurredAt: input.occurredAt,
        expiresAt: input.expiresAt ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return result.count > 0;
}

/**
 * Releases every active cause of one selector.
 *
 * The meaning an entry deletion has while sends are still decided from
 * entries: the row for that (address, scope, purposeKey) is gone, so every
 * cause behind it is released together. Per-cause release rules take over only
 * once causes become authoritative.
 */
export async function releaseSelectorCauses(
  tx: Prisma.TransactionClient,
  input: {
    emailAddress: string;
    scope: SuppressionScope;
    purposeKey: string;
    releaseKind: string;
    releaseEvidence: Prisma.InputJsonValue;
    releasedAt: Date;
  }
): Promise<number> {
  const result = await tx.suppressionCause.updateMany({
    where: {
      emailAddress: input.emailAddress,
      scope: input.scope,
      purposeKey: input.purposeKey,
      releasedAt: null,
    },
    data: {
      releasedAt: input.releasedAt,
      releaseKind: input.releaseKind,
      releaseEvidence: input.releaseEvidence,
    },
  });
  return result.count;
}
