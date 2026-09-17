import "server-only";

import type { Prisma } from "@prisma/client";

import {
  deliveredReleasesSoftBounce,
  providerEventAdvancesStatus,
  softBounceRun,
  softBounceStillCurrent,
  type ProviderEventKey,
} from "@/lib/emailProviderEventOrderCore";
import { normalizeSuppressionAddress, recordSuppression } from "@/lib/emailSuppression";
import { markCauseWriter } from "@/lib/emailSuppressionCauses";
import {
  holdSuppressionFence,
  lockSuppressionAddress,
} from "@/lib/emailSuppressionAuthority";
import { isActiveCause } from "@/lib/emailSuppressionAuthorityCore";
import {
  SOFT_BOUNCE_SUPPRESSION_MS,
  SOFT_BOUNCE_SUPPRESSION_THRESHOLD,
} from "@/lib/emailSuppressionCore";
import { prisma } from "@/lib/prisma";

/**
 * Provider events applied in their own order rather than in the order they
 * arrive.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (event order, C71, C77, C85; delivered releases, C57, C64).
 *
 * Every write here happens under the address lock, so two events for one
 * address are applied one after the other, and each one decides from the facts
 * the other left rather than from whichever finished first.
 */

type Tx = Prisma.TransactionClient;

/** Opens the fence and the address lock, in the order every writer takes them. */
const underAddress = <T>(emailAddress: string, work: (tx: Tx) => Promise<T>) =>
  prisma.$transaction(
    async (tx) => {
      await holdSuppressionFence(tx);
      await lockSuppressionAddress(tx, normalizeSuppressionAddress(emailAddress));
      return work(tx);
    },
    { timeout: 20_000 }
  );

/**
 * Moves a delivery's status when the event is later than the last one that did,
 * and records the event's own facts either way.
 */
const applyToDelivery = async (
  tx: Tx,
  input: {
    deliveryId: string;
    key: ProviderEventKey;
    status: string;
    lastErrorKind?: string;
    deliveredAt?: Date;
    softBounceAt?: Date;
  }
) => {
  const row = await tx.emailDelivery.findUnique({
    where: { id: input.deliveryId },
    select: {
      providerEventAt: true,
      providerEventRank: true,
      providerEventId: true,
      deliveredAt: true,
      softBounceAt: true,
    },
  });
  if (!row) return false;
  const last =
    row.providerEventAt && row.providerEventRank !== null && row.providerEventId
      ? { occurredAt: row.providerEventAt, rank: row.providerEventRank, eventId: row.providerEventId }
      : null;
  const advances = providerEventAdvancesStatus(input.key, last);
  const later = (current: Date | null, next: Date | undefined) =>
    next && (!current || next.getTime() > current.getTime()) ? next : undefined;
  const deliveredAt = later(row.deliveredAt, input.deliveredAt);
  const softBounceAt = later(row.softBounceAt, input.softBounceAt);

  if (!advances && !deliveredAt && !softBounceAt) return false;
  await tx.emailDelivery.update({
    where: { id: input.deliveryId },
    data: {
      ...(advances
        ? {
            status: input.status,
            ...(input.lastErrorKind ? { lastErrorKind: input.lastErrorKind } : {}),
            providerEventAt: input.key.occurredAt,
            providerEventRank: input.key.rank,
            providerEventId: input.key.eventId,
          }
        : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(softBounceAt ? { softBounceAt } : {}),
    },
  });
  return advances;
};

/** The latest delivered event's time across every delivery to the address. */
const latestDeliveredAt = async (tx: Tx, emailAddress: string) => {
  const row = await tx.emailDelivery.aggregate({
    where: { emailAddress: normalizeSuppressionAddress(emailAddress) },
    _max: { deliveredAt: true },
  });
  return row._max.deliveredAt ?? null;
};

/** `sent`, and the status side of a hard bounce or a complaint. */
export async function recordProviderStatusEvent(input: {
  emailAddress: string;
  deliveryId: string;
  key: ProviderEventKey;
  status: string;
}) {
  return underAddress(input.emailAddress, (tx) =>
    applyToDelivery(tx, { deliveryId: input.deliveryId, key: input.key, status: input.status })
  );
}

/**
 * A delivered event: the status, the delivery's delivered time, and the release
 * of every soft bounce for the address that happened strictly before it.
 */
export async function recordDeliveredEvent(input: {
  emailAddress: string;
  deliveryId: string;
  key: ProviderEventKey;
  webhookEventId: string;
}) {
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  return underAddress(emailAddress, async (tx) => {
    await applyToDelivery(tx, {
      deliveryId: input.deliveryId,
      key: input.key,
      status: "delivered",
      deliveredAt: input.key.occurredAt,
    });

    const active = await tx.suppressionCause.findMany({
      where: { emailAddress, scope: "global", reason: "soft_bounce", releasedAt: null },
      select: { id: true, occurredAt: true, expiresAt: true, releasedAt: true },
    });
    const releasable = active.filter((cause) =>
      deliveredReleasesSoftBounce({
        deliveredAt: input.key.occurredAt,
        causeOccurredAt: cause.occurredAt,
      })
    );
    if (releasable.length === 0) return { released: 0 };

    await markCauseWriter(tx);
    const released = await tx.suppressionCause.updateMany({
      where: { id: { in: releasable.map((cause) => cause.id) }, releasedAt: null },
      data: {
        releasedAt: new Date(),
        releaseKind: "delivered",
        releaseEvidence: { kind: "delivered", webhookEventId: input.webhookEventId },
      },
    });

    // The entry is a soft bounce only while one is its latest reason. Removed
    // when nothing active remains behind it, so an older build reading entries
    // stops holding mail the causes already let through -- the cutover would
    // otherwise count it as a mismatch.
    const remaining = await tx.suppressionCause.findMany({
      where: { emailAddress, scope: "global", purposeKey: "*", releasedAt: null },
      select: { expiresAt: true, releasedAt: true },
    });
    if (!remaining.some((cause) => isActiveCause(cause, new Date()))) {
      await tx.suppressionEntry.deleteMany({
        where: { emailAddress, scope: "global", purposeKey: "*", reason: "soft_bounce" },
      });
    }
    return { released: released.count };
  });
}

/**
 * A soft bounce or a deferral: the status, the delivery's soft bounce time, and
 * a suppression once the address has a run of them since its latest delivery.
 *
 * A soft bounce older than the address's latest delivered event is a fact about
 * a mailbox that has since accepted mail, and records nothing.
 *
 * A run rather than a count: one deferral is a full mailbox or a greylisting
 * pass and means nothing, so a delivery resets the tally. Only a delivered event
 * resets it -- a message accepted for sending says nothing about the mailbox.
 */
export async function recordSoftBounceEvent(input: {
  emailAddress: string;
  deliveryId: string | null;
  key: ProviderEventKey;
  webhookEventId: string;
  sourceStream?: string | null;
  sourceMessageId?: string | null;
}) {
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  return underAddress(emailAddress, async (tx) => {
    if (input.deliveryId) {
      await applyToDelivery(tx, {
        deliveryId: input.deliveryId,
        key: input.key,
        status: "bounced",
        lastErrorKind: "soft_bounce",
        softBounceAt: input.key.occurredAt,
      });
    }

    const delivered = await latestDeliveredAt(tx, emailAddress);
    if (!softBounceStillCurrent({ occurredAt: input.key.occurredAt, latestDeliveredAt: delivered })) {
      return { suppressed: false, run: 0 };
    }

    const deliveries = await tx.emailDelivery.findMany({
      where: {
        emailAddress,
        softBounceAt: delivered ? { gte: delivered } : { not: null },
      },
      select: { softBounceAt: true },
    });
    const run = softBounceRun({
      softBounceTimes: deliveries.map((row) => row.softBounceAt),
      latestDeliveredAt: delivered,
    });
    if (run < SOFT_BOUNCE_SUPPRESSION_THRESHOLD) return { suppressed: false, run };

    await recordSuppression(
      {
        emailAddress,
        reason: "soft_bounce",
        source: "provider_webhook",
        expiresAt: new Date(input.key.occurredAt.getTime() + SOFT_BOUNCE_SUPPRESSION_MS),
        sourceStream: input.sourceStream ?? null,
        sourceDeliveryId: input.deliveryId,
        sourceMessageId: input.sourceMessageId ?? null,
        occurredAt: input.key.occurredAt,
        sourceEventKey: input.deliveryId
          ? `softbounce:${input.deliveryId}`
          : `softbounce:webhook:${input.webhookEventId}`,
      },
      tx
    );
    return { suppressed: true, run };
  });
}

/**
 * Records the release of causes whose expiry has passed.
 *
 * The send check already ignores an expired cause, so nothing waits on this;
 * it keeps an address that is never mailed again from holding causes that read
 * as active forever. Per address, under the fence and the address lock, oldest
 * expiry first, within a row and a time budget.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (recording expiry, C66).
 */
export async function releaseExpiredSuppressionCauses(options?: {
  now?: Date;
  limit?: number;
  timeBudgetMs?: number;
}) {
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? 200;
  const deadline = Date.now() + (options?.timeBudgetMs ?? 20_000);

  const due = await prisma.suppressionCause.findMany({
    where: { releasedAt: null, expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { emailAddress: true },
  });
  const addresses = [...new Set(due.map((row) => row.emailAddress))];

  let released = 0;
  let entriesRemoved = 0;
  let addressesDone = 0;
  for (const emailAddress of addresses) {
    if (Date.now() > deadline) break;
    const outcome = await underAddress(emailAddress, async (tx) => {
      await markCauseWriter(tx);
      const result = await tx.suppressionCause.updateMany({
        where: { emailAddress, releasedAt: null, expiresAt: { lte: now } },
        data: {
          releasedAt: now,
          releaseKind: "expired",
          releaseEvidence: { kind: "expiry" },
        },
      });
      // An expired entry with nothing active behind its selector is removed
      // too, so the summary stops describing a hold that no longer exists.
      const expiredEntries = await tx.suppressionEntry.findMany({
        where: { emailAddress, expiresAt: { lte: now } },
        select: { id: true, scope: true, purposeKey: true },
      });
      let removed = 0;
      for (const entry of expiredEntries) {
        const behind = await tx.suppressionCause.findMany({
          where: {
            emailAddress,
            scope: entry.scope,
            purposeKey: entry.purposeKey,
            releasedAt: null,
          },
          select: { expiresAt: true, releasedAt: true },
        });
        if (behind.some((cause) => isActiveCause(cause, now))) continue;
        removed += (
          await tx.suppressionEntry.deleteMany({ where: { id: entry.id, expiresAt: { lte: now } } })
        ).count;
      }
      return { released: result.count, removed };
    });
    released += outcome.released;
    entriesRemoved += outcome.removed;
    addressesDone += 1;
  }
  return {
    released,
    entriesRemoved,
    addresses: addressesDone,
    exhausted: addressesDone === addresses.length && due.length < limit,
  };
}
