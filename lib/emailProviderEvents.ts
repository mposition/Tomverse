import "server-only";

import type { Prisma } from "@prisma/client";

import {
  PROVIDER_EVENT_RANK,
  canonicalSoftBounceCrossing,
  providerEventAdvancesStatus,
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
 * address are applied one after the other, and each decides from the facts the
 * other left rather than from whichever finished first.
 */

type Tx = Prisma.TransactionClient;

const TRANSACTION_TIMEOUT_MS = 20_000;

/** Opens the fence and the address lock, in the order every writer takes them. */
const underAddress = <T>(
  emailAddress: string,
  work: (tx: Tx) => Promise<T>,
  timeoutMs = TRANSACTION_TIMEOUT_MS
) =>
  prisma.$transaction(
    async (tx) => {
      await holdSuppressionFence(tx);
      await lockSuppressionAddress(tx, normalizeSuppressionAddress(emailAddress));
      return work(tx);
    },
    { timeout: timeoutMs, maxWait: timeoutMs }
  );

/**
 * The order key standing in for a delivery whose status was set before event
 * keys were recorded. Its status came from an event, so a late event older than
 * that status must not roll it back; the row's own timestamps are the best
 * record of when that happened.
 */
const legacyKey = (row: {
  status: string;
  lastErrorKind: string | null;
  deliveredAt: Date | null;
  updatedAt: Date;
}): ProviderEventKey | null => {
  switch (row.status) {
    case "delivered":
      return { occurredAt: row.deliveredAt ?? row.updatedAt, rank: PROVIDER_EVENT_RANK.delivered, eventId: "" };
    case "bounced":
      return {
        occurredAt: row.updatedAt,
        rank:
          row.lastErrorKind === "soft_bounce"
            ? PROVIDER_EVENT_RANK.soft_bounce
            : PROVIDER_EVENT_RANK.hard_bounce,
        eventId: "",
      };
    case "complained":
      return { occurredAt: row.updatedAt, rank: PROVIDER_EVENT_RANK.complaint, eventId: "" };
    default:
      return null;
  }
};

/**
 * Moves a delivery's status when the event is later than the last one that did,
 * and records the event's own facts either way. Returns whether the status moved.
 */
const applyToDelivery = async (
  tx: Tx,
  input: {
    deliveryId: string;
    key: ProviderEventKey;
    status: string;
    deliveredAt?: Date;
    softBounceAt?: Date;
  }
) => {
  const row = await tx.emailDelivery.findUnique({
    where: { id: input.deliveryId },
    select: {
      status: true,
      lastErrorKind: true,
      updatedAt: true,
      providerEventAt: true,
      providerEventRank: true,
      providerEventId: true,
      deliveredAt: true,
      softBounceAt: true,
    },
  });
  if (!row) return false;
  const last =
    row.providerEventAt && row.providerEventRank !== null && row.providerEventId !== null
      ? { occurredAt: row.providerEventAt, rank: row.providerEventRank, eventId: row.providerEventId }
      : legacyKey(row);
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
            // Written on every move, so the error kind always describes the
            // status it sits beside whatever order the events came in.
            lastErrorKind: input.key.rank === PROVIDER_EVENT_RANK.soft_bounce ? "soft_bounce" : null,
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

/**
 * Brings the address's soft bounce cause to the one its delivery facts call for.
 *
 * The cause is not whatever happened to cross the threshold when it was
 * processed -- that depends on arrival order. It is computed from the facts
 * every ordering converges on: each delivery's latest soft bounce, and the
 * address's latest delivery. A cause that no longer matches is released and the
 * matching one written, so any order of the same events leaves the same active
 * cause.
 */
const reconcileSoftBounceCause = async (
  tx: Tx,
  input: { emailAddress: string; webhookEventId: string; trigger: "delivered" | "soft_bounce" }
) => {
  const emailAddress = input.emailAddress;
  const now = new Date();
  const deliveredMax = await tx.emailDelivery.aggregate({
    where: { emailAddress },
    _max: { deliveredAt: true },
  });
  const latestDeliveredAt = deliveredMax._max.deliveredAt ?? null;
  const candidates = await tx.emailDelivery.findMany({
    where: {
      emailAddress,
      softBounceAt: latestDeliveredAt ? { gte: latestDeliveredAt } : { not: null },
    },
    select: {
      id: true,
      softBounceAt: true,
      providerMessageId: true,
      templateVersion: { select: { classification: true } },
    },
  });
  const crossing = canonicalSoftBounceCrossing({
    deliveries: candidates.map((row) => ({ id: row.id, softBounceAt: row.softBounceAt })),
    latestDeliveredAt,
    threshold: SOFT_BOUNCE_SUPPRESSION_THRESHOLD,
  });
  const desired =
    crossing &&
    crossing.softBounceAt.getTime() + SOFT_BOUNCE_SUPPRESSION_MS > now.getTime()
      ? crossing
      : null;

  const active = (
    await tx.suppressionCause.findMany({
      where: {
        emailAddress,
        scope: "global",
        purposeKey: "*",
        reason: "soft_bounce",
        source: "provider_webhook",
        releasedAt: null,
      },
      select: { id: true, occurredAt: true, expiresAt: true, releasedAt: true },
    })
  ).filter((cause) => isActiveCause(cause, now));

  const keep = desired
    ? active.find((cause) => cause.occurredAt.getTime() === desired.softBounceAt.getTime())
    : undefined;
  const stale = active.filter((cause) => cause !== keep);

  if (stale.length > 0) {
    await markCauseWriter(tx);
    await tx.suppressionCause.updateMany({
      where: { id: { in: stale.map((cause) => cause.id) }, releasedAt: null },
      data: {
        releasedAt: now,
        releaseKind: input.trigger === "delivered" ? "delivered" : "superseded",
        releaseEvidence: {
          kind: input.trigger === "delivered" ? "delivered" : "superseded",
          webhookEventId: input.webhookEventId,
        },
      },
    });
  }

  if (desired && !keep) {
    const row = candidates.find((candidate) => candidate.id === desired.deliveryId);
    const base = `softbounce:${desired.deliveryId}:${desired.softBounceAt.getTime()}`;
    // A key released earlier cannot be written again; the next free suffix
    // records the same fact anew.
    const taken = await tx.suppressionCause.count({
      where: { emailAddress, sourceEventKey: { startsWith: base } },
    });
    await recordSuppression(
      {
        emailAddress,
        reason: "soft_bounce",
        source: "provider_webhook",
        expiresAt: new Date(desired.softBounceAt.getTime() + SOFT_BOUNCE_SUPPRESSION_MS),
        sourceStream: row?.templateVersion.classification === "marketing" ? "marketing" : "transactional",
        sourceDeliveryId: desired.deliveryId,
        sourceMessageId: row?.providerMessageId ?? null,
        occurredAt: desired.softBounceAt,
        sourceEventKey: taken === 0 ? base : `${base}:${taken}`,
      },
      tx
    );
  }

  // The entry is a soft bounce only while one is its latest reason. Removed when
  // nothing active remains behind the selector, so an older build reading
  // entries stops holding mail the causes already let through -- the cutover
  // would otherwise count it as a mismatch.
  if (!desired && stale.length > 0) {
    const remaining = await tx.suppressionCause.findMany({
      where: { emailAddress, scope: "global", purposeKey: "*", releasedAt: null },
      select: { expiresAt: true, releasedAt: true },
    });
    if (!remaining.some((cause) => isActiveCause(cause, now))) {
      await markCauseWriter(tx);
      await tx.suppressionEntry.deleteMany({
        where: { emailAddress, scope: "global", purposeKey: "*", reason: "soft_bounce" },
      });
    }
  }
  return { suppressed: desired !== null };
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

/** A delivered event: the status, the delivery's delivered time, and the soft bounce cause brought up to date. */
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
    return reconcileSoftBounceCause(tx, {
      emailAddress,
      webhookEventId: input.webhookEventId,
      trigger: "delivered",
    });
  });
}

/**
 * A soft bounce or a deferral for a delivery: the status, the delivery's soft
 * bounce time, and the soft bounce cause brought up to date.
 *
 * A run rather than a count: one deferral is a full mailbox or a greylisting
 * pass and means nothing, so a delivery resets the tally. Only a delivered event
 * resets it -- a message accepted for sending says nothing about the mailbox.
 *
 * An event matched to no delivery changes nothing here: it cannot be placed in
 * any delivery's history, and counting it against the address would let one
 * stray event re-suppress an address from an old run.
 */
export async function recordSoftBounceEvent(input: {
  emailAddress: string;
  deliveryId: string | null;
  key: ProviderEventKey;
  webhookEventId: string;
}) {
  if (!input.deliveryId) return { suppressed: false, unmatched: true };
  const deliveryId = input.deliveryId;
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  return underAddress(emailAddress, async (tx) => {
    await applyToDelivery(tx, {
      deliveryId,
      key: input.key,
      status: "bounced",
      softBounceAt: input.key.occurredAt,
    });
    return {
      ...(await reconcileSoftBounceCause(tx, {
        emailAddress,
        webhookEventId: input.webhookEventId,
        trigger: "soft_bounce",
      })),
      unmatched: false,
    };
  });
}

/**
 * Records the release of soft bounce causes whose expiry has passed -- the only
 * reason that expires.
 *
 * The send check already ignores an expired cause, so nothing waits on this;
 * it keeps an address that is never mailed again from holding causes that read
 * as active. At most `limit` causes a pass, oldest expiry first, each address
 * under the fence and its lock, and no transaction outliving the time budget.
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
    where: { reason: "soft_bounce", releasedAt: null, expiresAt: { lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, emailAddress: true },
  });
  const byAddress = new Map<string, string[]>();
  for (const cause of due) {
    byAddress.set(cause.emailAddress, [...(byAddress.get(cause.emailAddress) ?? []), cause.id]);
  }

  let released = 0;
  let entriesRemoved = 0;
  let addressesDone = 0;
  for (const [emailAddress, ids] of byAddress) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) break;
    const outcome = await underAddress(
      emailAddress,
      async (tx) => {
        await markCauseWriter(tx);
        const result = await tx.suppressionCause.updateMany({
          where: { id: { in: ids }, releasedAt: null, expiresAt: { lte: now } },
          data: {
            releasedAt: now,
            releaseKind: "expired",
            releaseEvidence: { kind: "expiry" },
          },
        });
        // An expired soft bounce entry with nothing active behind its selector
        // is removed too, so the summary stops describing a hold that no longer
        // exists.
        const behind = await tx.suppressionCause.findMany({
          where: { emailAddress, scope: "global", purposeKey: "*", releasedAt: null },
          select: { expiresAt: true, releasedAt: true },
        });
        const removed = behind.some((cause) => isActiveCause(cause, now))
          ? 0
          : (
              await tx.suppressionEntry.deleteMany({
                where: {
                  emailAddress,
                  scope: "global",
                  purposeKey: "*",
                  reason: "soft_bounce",
                  expiresAt: { lte: now },
                },
              })
            ).count;
        return { released: result.count, removed };
      },
      Math.min(TRANSACTION_TIMEOUT_MS, remainingMs)
    );
    released += outcome.released;
    entriesRemoved += outcome.removed;
    addressesDone += 1;
  }
  return {
    released,
    entriesRemoved,
    addresses: addressesDone,
    exhausted: addressesDone === byAddress.size && due.length < limit,
  };
}
