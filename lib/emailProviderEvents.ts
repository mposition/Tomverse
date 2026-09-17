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

/**
 * Opens the fence and the address lock, in the order every writer takes them.
 * `budgetMs` covers both waiting for a connection and running: the wait gets at
 * most a quarter of it and the run the rest.
 */
const underAddress = <T>(
  emailAddress: string,
  work: (tx: Tx) => Promise<T>,
  budgetMs = TRANSACTION_TIMEOUT_MS
) => {
  const maxWait = Math.max(250, Math.floor(budgetMs / 4));
  return prisma.$transaction(
    async (tx) => {
      await holdSuppressionFence(tx);
      await lockSuppressionAddress(tx, normalizeSuppressionAddress(emailAddress));
      return work(tx);
    },
    { maxWait, timeout: Math.max(250, budgetMs - maxWait) }
  );
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
 * Rebuilds the global entry from the active causes when it holds a soft bounce.
 *
 * An entry is what an older build reads, and the cutover compares it with the
 * causes. After causes are released or replaced it must describe what is left:
 * the latest-expiring active soft bounce, or nothing when no active cause
 * remains. An entry holding a permanent reason is left alone -- a soft bounce
 * never outranks it.
 */
const syncSoftBounceEntry = async (tx: Tx, emailAddress: string, now: Date) => {
  const entry = await tx.suppressionEntry.findUnique({
    where: { emailAddress_scope_purposeKey: { emailAddress, scope: "global", purposeKey: "*" } },
    select: {
      id: true,
      reason: true,
      source: true,
      expiresAt: true,
      occurredAt: true,
      sourceStream: true,
      sourceDomain: true,
      sourceClassification: true,
      sourceDeliveryId: true,
      sourceMessageId: true,
    },
  });
  if (!entry || entry.reason !== "soft_bounce") return;

  const active = (
    await tx.suppressionCause.findMany({
      where: { emailAddress, scope: "global", purposeKey: "*", releasedAt: null },
      select: {
        id: true,
        reason: true,
        source: true,
        expiresAt: true,
        releasedAt: true,
        occurredAt: true,
        sourceStream: true,
        sourceDomain: true,
        sourceClassification: true,
        sourceDeliveryId: true,
        sourceMessageId: true,
      },
    })
  ).filter((cause) => isActiveCause(cause, now));

  await markCauseWriter(tx);
  if (active.length === 0) {
    await tx.suppressionEntry.delete({ where: { id: entry.id } });
    return;
  }
  // The latest-expiring soft bounce; at the same expiry the latest to occur,
  // then the cause id, so the choice never rests on the order rows come back in.
  const soft = active
    .filter((cause) => cause.reason === "soft_bounce")
    .sort(
      (a, b) =>
        (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0) ||
        b.occurredAt.getTime() - a.occurredAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )[0];
  // Another reason is active but the entry still reads soft bounce: left for
  // the merge that wrote that reason, which never downgrades to soft bounce.
  if (!soft) return;
  const data = {
    source: soft.source,
    expiresAt: soft.expiresAt,
    occurredAt: soft.occurredAt,
    sourceStream: soft.sourceStream,
    sourceDomain: soft.sourceDomain,
    sourceClassification: soft.sourceClassification,
    sourceDeliveryId: soft.sourceDeliveryId,
    sourceMessageId: soft.sourceMessageId,
  };
  const same = (a: Date | string | null, b: Date | string | null) =>
    a instanceof Date || b instanceof Date
      ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime()
      : a === b;
  if ((Object.keys(data) as Array<keyof typeof data>).every((key) => same(entry[key], data[key]))) {
    return;
  }
  await tx.suppressionEntry.update({ where: { id: entry.id }, data });
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
      select: { id: true, occurredAt: true, expiresAt: true, releasedAt: true, sourceDeliveryId: true },
    })
  ).filter((cause) => isActiveCause(cause, now));

  // The same fact, not merely the same instant: at one instant the crossing
  // delivery is chosen by id, and a cause naming another delivery would carry
  // provenance that depends on arrival order.
  const keep = desired
    ? active.find(
        (cause) =>
          cause.sourceDeliveryId === desired.deliveryId &&
          cause.occurredAt.getTime() === desired.softBounceAt.getTime() &&
          cause.expiresAt?.getTime() ===
            desired.softBounceAt.getTime() + SOFT_BOUNCE_SUPPRESSION_MS
      )
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

  await syncSoftBounceEntry(tx, emailAddress, now);
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
  // At most 200 whatever the caller asks: the pass has a fixed budget.
  const requested = Number(options?.limit ?? 200);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(1, Math.floor(requested)), 200) : 200;
  // A missing or non-finite budget is the default 20 seconds; a budget of zero or
  // less is already spent, and so is anything under the one second the
  // selection needs.
  const budget = Number(options?.timeBudgetMs ?? 20_000);
  const deadline = Date.now() + (Number.isFinite(budget) ? Math.min(Math.max(budget, 0), 20_000) : 20_000);
  const nothing = { released: 0, entriesRemoved: 0, addresses: 0, exhausted: false };
  if (deadline - Date.now() < 1_000) return nothing;

  // The selection is inside the budget too: the connection wait and the query
  // are both bounded, the query by a statement timeout the database enforces.
  // A quarter of what is left, at least one second -- never more than is left.
  const selectBudget = Math.max(1_000, Math.floor((deadline - Date.now()) / 4));
  const selectWait = Math.floor(selectBudget / 4);
  const due = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${Math.max(250, selectBudget - selectWait)}`
      );
      return tx.suppressionCause.findMany({
        where: { reason: "soft_bounce", releasedAt: null, expiresAt: { lte: now } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: limit,
        select: { id: true, emailAddress: true },
      });
    },
    { maxWait: Math.max(250, selectWait), timeout: Math.max(250, selectBudget - selectWait) }
  );
  const byAddress = new Map<string, string[]>();
  for (const cause of due) {
    byAddress.set(cause.emailAddress, [...(byAddress.get(cause.emailAddress) ?? []), cause.id]);
  }

  let released = 0;
  let entriesRemoved = 0;
  let addressesDone = 0;
  for (const [emailAddress, ids] of byAddress) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 2_000) break;
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
        // The entry follows the causes left, as after any reconciliation.
        const before = await tx.suppressionEntry.count({ where: { emailAddress, scope: "global", purposeKey: "*" } });
        await syncSoftBounceEntry(tx, emailAddress, now);
        const after = await tx.suppressionEntry.count({ where: { emailAddress, scope: "global", purposeKey: "*" } });
        const removed = before - after;
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
