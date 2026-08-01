import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendTransactionalEmail } from "@/lib/email";
import {
  buildSupportNotificationEmail,
  supportNotificationRecipient,
} from "@/lib/supportNotificationEmail";
import {
  NOTIFICATION_DELIVERY_STATUS,
  classifyNotificationError,
  nextNotificationDeliveryState,
  type NotificationAttemptOutcome,
} from "@/lib/notificationRetryCore";

/**
 * The retry queue for operator notifications.
 *
 * A support report that reached the database is the user's receipt. The email
 * that tells the team about it is a separate delivery with its own failure
 * modes -- a provider outage, a missing API key, a 502 -- and before this
 * existed a failure there was written to a log line and then forgotten.
 *
 * Two properties matter:
 *
 *  - the queue row is written in the same transaction as the source record, so
 *    a crash anywhere in the send path cannot lose the notification;
 *  - delivery is at-least-once. A process that dies between a successful send
 *    and marking the row delivered will send again. For an operator
 *    notification a duplicate is strictly better than a silent loss, and the
 *    retried mail says which attempt it is.
 *
 * Nothing here stores or logs the reporter's words: the mail is re-rendered
 * from the source row at send time, and only a short error *classification* is
 * ever persisted.
 */

export const NOTIFICATION_KIND = {
  supportFeedback: "support_feedback",
} as const;

export type NotificationKind =
  (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

/** How many deliveries one drain pass will attempt. */
const DEFAULT_DRAIN_LIMIT = 25;

/**
 * Enqueues a notification inside an existing transaction.
 *
 * Takes the transaction client rather than opening its own, because the whole
 * point is that the queue row and the record it describes commit together.
 */
export async function enqueueNotificationDelivery(
  tx: Prisma.TransactionClient,
  input: { kind: NotificationKind; referenceId: string }
) {
  return tx.notificationDelivery.upsert({
    where: {
      kind_referenceId: { kind: input.kind, referenceId: input.referenceId },
    },
    create: { kind: input.kind, referenceId: input.referenceId },
    // A record that already has a queue row keeps it: re-enqueuing must not
    // reset the attempt count of a delivery that is already being retried.
    update: {},
    select: { id: true },
  });
}

/** Marks the row this attempt belongs to as delivered. */
export async function markNotificationDelivered(id: string, now = new Date()) {
  await prisma.notificationDelivery.update({
    where: { id },
    data: {
      status: NOTIFICATION_DELIVERY_STATUS.delivered,
      attempts: { increment: 1 },
      lastAttemptAt: now,
      deliveredAt: now,
      lastErrorKind: null,
    },
  });
}

/**
 * Records the result of one attempt against a row, applying the retry policy.
 * Returns the status the row ended up in, so a caller can report abandonment.
 */
export async function recordNotificationAttempt({
  id,
  attemptsBefore,
  outcome,
  now = new Date(),
}: {
  id: string;
  attemptsBefore: number;
  outcome: NotificationAttemptOutcome;
  now?: Date;
}) {
  const transition = nextNotificationDeliveryState({
    outcome,
    attempts: attemptsBefore + 1,
    now,
  });
  await prisma.notificationDelivery.update({
    where: { id },
    data: {
      status: transition.status,
      attempts: transition.attempts,
      lastAttemptAt: now,
      lastErrorKind: transition.lastErrorKind,
      deliveredAt:
        transition.status === NOTIFICATION_DELIVERY_STATUS.delivered ? now : null,
      // A terminal row is parked far in the future rather than nulled: the
      // column is non-nullable, and the due-work query filters on status
      // anyway.
      nextAttemptAt: transition.nextAttemptAt ?? now,
    },
  });
  return transition;
}

/**
 * Renders one notification from its source record.
 *
 * `null` means there is nothing to send -- the source row is gone, most likely
 * deleted by retention -- which the caller treats as unsendable rather than as
 * a failure to retry.
 */
async function renderNotification(kind: string, referenceId: string) {
  if (kind !== NOTIFICATION_KIND.supportFeedback) return null;

  const feedback = await prisma.feedback.findUnique({
    where: { id: referenceId },
    select: {
      id: true,
      type: true,
      email: true,
      message: true,
      traceId: true,
      modelId: true,
      plan: true,
      attachmentCount: true,
      path: true,
    },
  });
  if (!feedback) return null;
  return (attempt: number) =>
    buildSupportNotificationEmail({
      feedbackId: feedback.id,
      type: feedback.type,
      email: feedback.email,
      message: feedback.message,
      traceId: feedback.traceId,
      modelId: feedback.modelId,
      plan: feedback.plan,
      attachmentCount: feedback.attachmentCount,
      path: feedback.path,
      retryAttempt: attempt,
    });
}

/**
 * Sends one notification and reports what happened, without touching the
 * database. Exported so the submission path can make its immediate attempt
 * through exactly the same code the retry uses.
 */
export async function attemptNotificationDelivery({
  kind,
  referenceId,
  attempt,
}: {
  kind: string;
  referenceId: string;
  attempt: number;
}): Promise<NotificationAttemptOutcome> {
  const recipient = supportNotificationRecipient();
  if (!recipient) {
    return { kind: "unsendable", reason: "recipient_not_configured" };
  }

  const render = await renderNotification(kind, referenceId);
  if (!render) return { kind: "unsendable", reason: "source_missing" };

  const email = render(attempt);
  try {
    const result = await sendTransactionalEmail({
      to: recipient,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    if (result.skipped) return { kind: "not_configured" };
    return { kind: "delivered" };
  } catch (error) {
    const { errorKind, permanent } = classifyNotificationError(error);
    return { kind: "failed", errorKind, permanent };
  }
}

export type NotificationDrainResult = {
  claimed: number;
  delivered: number;
  retrying: number;
  abandoned: number;
  /** Rows still pending overall, so queue depth is visible without a query. */
  pending: number;
};

/**
 * One pass over the deliveries that are due.
 *
 * Rows are claimed one at a time with a conditional update, so two overlapping
 * drains (the dedicated cron and the piggybacked one) can never both send the
 * same notification.
 */
export async function drainNotificationDeliveries({
  now = new Date(),
  limit = DEFAULT_DRAIN_LIMIT,
}: { now?: Date; limit?: number } = {}): Promise<NotificationDrainResult> {
  const due = await prisma.notificationDelivery.findMany({
    where: {
      status: NOTIFICATION_DELIVERY_STATUS.pending,
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true, kind: true, referenceId: true, attempts: true, nextAttemptAt: true },
  });

  const result: NotificationDrainResult = {
    claimed: 0,
    delivered: 0,
    retrying: 0,
    abandoned: 0,
    pending: 0,
  };

  for (const row of due) {
    // Claim by pushing the row's next attempt out of the due window. Another
    // drain that read the same row before this update will not match here and
    // simply skips it.
    const claimed = await prisma.notificationDelivery.updateMany({
      where: {
        id: row.id,
        status: NOTIFICATION_DELIVERY_STATUS.pending,
        nextAttemptAt: row.nextAttemptAt,
      },
      data: { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) },
    });
    if (claimed.count !== 1) continue;
    result.claimed += 1;

    const outcome = await attemptNotificationDelivery({
      kind: row.kind,
      referenceId: row.referenceId,
      attempt: row.attempts + 1,
    });
    const transition = await recordNotificationAttempt({
      id: row.id,
      attemptsBefore: row.attempts,
      outcome,
      now,
    });

    if (transition.status === NOTIFICATION_DELIVERY_STATUS.delivered) {
      result.delivered += 1;
    } else if (transition.status === NOTIFICATION_DELIVERY_STATUS.abandoned) {
      result.abandoned += 1;
      console.error(
        JSON.stringify({
          event: "notification_delivery_abandoned",
          deliveryId: row.id,
          kind: row.kind,
          referenceId: row.referenceId,
          attempts: transition.attempts,
          errorKind: transition.lastErrorKind,
          at: now.toISOString(),
        })
      );
    } else {
      result.retrying += 1;
    }
  }

  result.pending = await prisma.notificationDelivery.count({
    where: { status: NOTIFICATION_DELIVERY_STATUS.pending },
  });
  return result;
}

/**
 * Queue depth by status, for the operations surface. Cheap enough to call from
 * an admin request.
 */
export async function notificationDeliveryQueueDepth() {
  const grouped = await prisma.notificationDelivery.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return grouped.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = row._count._all;
    return counts;
  }, {});
}
