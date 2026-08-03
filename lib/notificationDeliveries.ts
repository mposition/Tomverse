import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendTransactionalEmail } from "@/lib/email";
import {
  buildSupportNotificationEmail,
  supportNotificationRecipient,
} from "@/lib/supportNotificationEmail";
import {
  buildRefundRequestEmail,
  type RefundEmailStage,
} from "@/lib/billingEmails";
import { buildFeedbackLifecycleEmail } from "@/lib/feedbackLifecycleEmails";
import type { FeedbackLifecycleStage } from "@/lib/feedbackLifecycleCore";
import { feedbackReferenceFromId } from "@/lib/feedbackPolicy";
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
 *  - the queue is at-least-once, but delivery is not. A process that dies
 *    between a successful send and marking the row delivered will attempt
 *    again -- and the provider suppresses it, because every attempt presents
 *    the same idempotency key and an identical payload. Losing a notification
 *    would still be worse than duplicating one; this simply removes the
 *    duplicate as well.
 *
 * Nothing here stores or logs the reporter's words: the mail is re-rendered
 * from the source row at send time, and only a short error *classification* is
 * ever persisted.
 */

export const NOTIFICATION_KIND = {
  supportFeedback: "support_feedback",
  refundRequestReceived: "refund_request_received",
  refundRequestApproved: "refund_request_approved",
  refundRequestRejected: "refund_request_rejected",
  // The submitter-facing lifecycle emails. Distinct kinds from the operator
  // notification above -- support_feedback keeps going to the team unchanged --
  // and one kind per stage, so the (kind, referenceId) unique constraint is
  // what makes "at most one email per feedback and stage" hold.
  feedbackUserReceived: "feedback_user_received",
  feedbackUserReviewing: "feedback_user_reviewing",
  feedbackUserCompleted: "feedback_user_completed",
} as const;

export type NotificationKind =
  (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

/** Which submitter-facing kind announces each lifecycle stage. */
export const FEEDBACK_USER_NOTIFICATION_KIND: Record<
  FeedbackLifecycleStage,
  NotificationKind
> = {
  received: NOTIFICATION_KIND.feedbackUserReceived,
  reviewing: NOTIFICATION_KIND.feedbackUserReviewing,
  completed: NOTIFICATION_KIND.feedbackUserCompleted,
};

/** How many deliveries one batch claims at a time. */
const DEFAULT_BATCH_SIZE = 25;
/**
 * Batches one drain will run before stopping. A pass keeps going while there
 * is due work, so a backlog clears in one cron tick rather than 25 rows per
 * tick -- but not without end: the cap and the time budget below keep
 * a pathological queue from monopolising the runner.
 */
const DEFAULT_MAX_BATCHES = 40;
/** Wall-clock budget for one drain, well inside the fifteen-minute cadence. */
const DEFAULT_TIME_BUDGET_MS = 120_000;
/**
 * Queue depth that stops being ordinary. Reported so a backlog is visible
 * before anyone notices missing mail, rather than only when rows abandon.
 */
export const NOTIFICATION_QUEUE_DEPTH_ALERT = 100;

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
 * deleted by retention, or it has no recipient -- which the caller treats as
 * unsendable rather than as a failure to retry.
 *
 * Every renderer is a pure function of the stored row, so the message a retry
 * builds is identical to the one the first attempt built. The provider's
 * idempotency key depends on that: it only suppresses a duplicate when the
 * payload matches as well as the key.
 */
async function renderNotification(
  kind: string,
  referenceId: string
): Promise<{ to: string; subject: string; text: string; html: string } | null> {
  if (kind === NOTIFICATION_KIND.supportFeedback) {
    const recipient = supportNotificationRecipient();
    if (!recipient) return null;
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
    return {
      to: recipient,
      ...buildSupportNotificationEmail({
        feedbackId: feedback.id,
        type: feedback.type,
        email: feedback.email,
        message: feedback.message,
        traceId: feedback.traceId,
        modelId: feedback.modelId,
        plan: feedback.plan,
        attachmentCount: feedback.attachmentCount,
        path: feedback.path,
      }),
    };
  }

  const feedbackUserStage: Record<string, FeedbackLifecycleStage> = {
    [NOTIFICATION_KIND.feedbackUserReceived]: "received",
    [NOTIFICATION_KIND.feedbackUserReviewing]: "reviewing",
    [NOTIFICATION_KIND.feedbackUserCompleted]: "completed",
  };
  const lifecycleStage = feedbackUserStage[kind];
  if (lifecycleStage) {
    // Rendered from the immutable lifecycle event, so a retry presents the
    // same subject and body as the first attempt. Only the recipient is
    // resolved at send time: consent withdrawn or the address removed (account
    // deletion) makes every still-pending stage unsendable rather than mailing
    // an address the user took away.
    const event = await prisma.feedbackLifecycleEvent.findUnique({
      where: {
        feedbackId_stage: { feedbackId: referenceId, stage: lifecycleStage },
      },
      select: {
        outcomeCode: true,
        userReply: true,
        feedback: {
          select: {
            id: true,
            type: true,
            email: true,
            emailUpdatesConsent: true,
            language: true,
          },
        },
      },
    });
    if (!event) return null;
    const feedback = event.feedback;
    if (!feedback.email || !feedback.emailUpdatesConsent) return null;
    return {
      to: feedback.email,
      ...buildFeedbackLifecycleEmail(lifecycleStage, {
        reference: feedbackReferenceFromId(feedback.id),
        type: feedback.type,
        language: feedback.language,
        outcomeCode: event.outcomeCode,
        userReply: event.userReply,
      }),
    };
  }

  const refundStage: Record<string, RefundEmailStage> = {
    [NOTIFICATION_KIND.refundRequestReceived]: "received",
    [NOTIFICATION_KIND.refundRequestApproved]: "approved",
    [NOTIFICATION_KIND.refundRequestRejected]: "rejected",
  };
  const stage = refundStage[kind];
  if (!stage) return null;

  const request = await prisma.refundRequest.findUnique({
    where: { id: referenceId },
    select: {
      id: true,
      email: true,
      plan: true,
      adminNote: true,
      user: { select: { settings: { select: { language: true } } } },
    },
  });
  if (!request?.email) return null;
  return {
    to: request.email,
    ...buildRefundRequestEmail(stage, {
      to: request.email,
      plan: request.plan,
      requestId: request.id,
      adminNote: request.adminNote,
      language: request.user?.settings?.language,
    }),
  };
}

/**
 * Sends one notification and reports what happened, without touching the
 * database. Exported so the submission path can make its immediate attempt
 * through exactly the same code the retry uses.
 */
export async function attemptNotificationDelivery({
  kind,
  referenceId,
  deliveryId,
}: {
  kind: string;
  referenceId: string;
  /**
   * The queue row's id. Doubles as the provider idempotency key, so every
   * attempt at this notification -- the inline one and each retry -- presents
   * the same key and the provider delivers at most one message for it.
   */
  deliveryId: string;
}): Promise<NotificationAttemptOutcome> {
  const message = await renderNotification(kind, referenceId);
  if (!message) return { kind: "unsendable", reason: "source_missing" };

  try {
    const result = await sendTransactionalEmail({
      ...message,
      idempotencyKey: `notification-delivery:${deliveryId}`,
    });
    if (result.skipped) return { kind: "not_configured" };
    return { kind: "delivered" };
  } catch (error) {
    const { errorKind, permanent } = classifyNotificationError(error);
    return { kind: "failed", errorKind, permanent };
  }
}

/**
 * The inline first attempt every enqueuing caller makes, so the common case
 * still notifies immediately instead of waiting for the next drain.
 *
 * Never throws: the row is already queued, so the worst a failure here can do
 * is delay the notification to the next cron pass. Returns whether it was
 * delivered, for the caller's own operational log.
 */
export async function deliverNotificationNow({
  deliveryId,
  kind,
  referenceId,
}: {
  deliveryId: string;
  kind: NotificationKind;
  referenceId: string;
}) {
  try {
    const outcome = await attemptNotificationDelivery({
      kind,
      referenceId,
      deliveryId,
    });
    const transition = await recordNotificationAttempt({
      id: deliveryId,
      attemptsBefore: 0,
      outcome,
    });
    return {
      delivered: transition.status === NOTIFICATION_DELIVERY_STATUS.delivered,
      status: transition.status,
      errorKind: transition.lastErrorKind,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "notification_delivery_attempt_unrecorded",
        deliveryId,
        kind,
        reason: error instanceof Error ? error.name : "unknown",
      })
    );
    return { delivered: false, status: "pending", errorKind: "unrecorded" };
  }
}

export type NotificationDrainResult = {
  claimed: number;
  delivered: number;
  retrying: number;
  abandoned: number;
  /** Rows still pending overall, so queue depth is visible without a query. */
  pending: number;
  /** Batches actually run, so a backlog is legible in the job record. */
  batches: number;
  /** True when the pass ran out of due work rather than out of budget. */
  exhausted: boolean;
};

/**
 * Drains every delivery that is due, in batches, until the queue is empty or
 * the pass runs out of budget.
 *
 * It used to stop after a single batch, which silently capped throughput at
 * one batch per cron tick: a backlog drained slower than it built. It now
 * keeps going while there is due work, bounded by a batch count and a
 * wall-clock budget so one bad queue cannot monopolise the runner, and reports
 * whether it finished or was cut short.
 *
 * Rows are claimed one at a time with a conditional update, so two overlapping
 * drains (the dedicated cron and the piggybacked one) can never both send the
 * same notification.
 */
export async function drainNotificationDeliveries({
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  maxBatches = DEFAULT_MAX_BATCHES,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
}: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
} = {}): Promise<NotificationDrainResult> {
  const result: NotificationDrainResult = {
    claimed: 0,
    delivered: 0,
    retrying: 0,
    abandoned: 0,
    pending: 0,
    batches: 0,
    exhausted: false,
  };
  const deadline = Date.now() + timeBudgetMs;

  while (result.batches < maxBatches) {
    if (Date.now() >= deadline) break;
    const due = await prisma.notificationDelivery.findMany({
      where: {
        status: NOTIFICATION_DELIVERY_STATUS.pending,
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: batchSize,
      select: {
        id: true,
        kind: true,
        referenceId: true,
        attempts: true,
        nextAttemptAt: true,
      },
    });
    if (due.length === 0) {
      // Nothing due: the queue is drained for this tick.
      result.exhausted = true;
      break;
    }
    result.batches += 1;

    for (const row of due) {
      // Claim by pushing the row's next attempt out of the due window. Another
      // drain that read the same row before this update will not match here
      // and simply skips it.
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
        deliveryId: row.id,
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
