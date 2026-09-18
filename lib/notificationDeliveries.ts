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
import { qualifiesForTraceAutoReview } from "@/lib/feedbackTraceAutoReview";
import { feedbackStageRecipient } from "@/lib/feedbackLifecycleCore";
import { sendWithAddressLock } from "@/lib/emailSendLock";
import { STANDARD_SEND_PROVIDER_TIMEOUT_MS } from "@/lib/emailSendLockCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  buildAutoFixOperatorEmail,
  type AutoFixOperatorEmailKind,
} from "@/lib/autoFixOperatorEmail";
import type { SenderRole } from "@/lib/emailSendingIdentityCore";
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
  /**
   * One more attempt at a completed reply that was written but never sent --
   * reports closed before 2026-09-16, when the answer still required the
   * reporter's "status updates" tick. The operator asks for it explicitly, it
   * renders the stored reply unchanged, and `(kind, referenceId)` allows it
   * exactly once.
   */
  feedbackUserCompletedResend: "feedback_user_completed_resend",
  // Operator notices about an auto-fix case (docs/policy/trace-feedback-automation.md
  // §9.3). The referenceId is the case id; each stage is reached at most once,
  // so the (kind, referenceId) unique constraint makes each mail at most once.
  autoFixReviewRequested: "autofix_review_requested",
  autoFixProductionVerified: "autofix_production_verified",
  autoFixPromotionFailed: "autofix_promotion_failed",
} as const;

export type NotificationKind =
  (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

/**
 * Who each notification is from.
 *
 * Keyed by `kind`, which is stored on the queue row, so the inline first
 * attempt and every retry after it resolve the same sender -- the role is never
 * recomputed from anything that could have changed in between
 * (docs/policy/email-notifications.md §14.1a).
 *
 * The split is what the recipient is: `support_feedback` goes to the team about
 * somebody else's report, so it is an operations alert; the three lifecycle
 * notices go to the person who filed it, so they are support; and a refund
 * decision is money, so it is billing and belongs beside the receipts in the
 * recipient's mailbox.
 *
 * Typed as a total record, so a kind added to `NOTIFICATION_KIND` without a
 * sender fails the build rather than picking one up by omission.
 */
export const NOTIFICATION_SENDER_ROLE: Record<NotificationKind, SenderRole> = {
  [NOTIFICATION_KIND.supportFeedback]: "operations",
  [NOTIFICATION_KIND.refundRequestReceived]: "billing",
  [NOTIFICATION_KIND.refundRequestApproved]: "billing",
  [NOTIFICATION_KIND.refundRequestRejected]: "billing",
  [NOTIFICATION_KIND.feedbackUserReceived]: "support",
  [NOTIFICATION_KIND.feedbackUserReviewing]: "support",
  [NOTIFICATION_KIND.feedbackUserCompleted]: "support",
  [NOTIFICATION_KIND.feedbackUserCompletedResend]: "support",
  [NOTIFICATION_KIND.autoFixReviewRequested]: "operations",
  [NOTIFICATION_KIND.autoFixProductionVerified]: "operations",
  [NOTIFICATION_KIND.autoFixPromotionFailed]: "operations",
};

/**
 * Who each notification is for.
 *
 * A customer-facing notice takes the address lock and re-asks suppression
 * before it sends (docs/policy/email-product-news-redesign-draft.md section
 * 7.4). An operator alert does not: it is about somebody else's record and
 * goes to our own mailboxes, so a suppression on a customer address has no
 * bearing on it and must not silence it.
 *
 * A total `Record`, not a list of the customer ones: a kind added to
 * `NOTIFICATION_KIND` without a decision about who receives it fails the
 * build rather than inheriting a branch by name. That is the same reason
 * `NOTIFICATION_SENDER_ROLE` above is total.
 */
export const NOTIFICATION_AUDIENCE: Record<NotificationKind, "customer" | "operator"> = {
  [NOTIFICATION_KIND.supportFeedback]: "operator",
  [NOTIFICATION_KIND.refundRequestReceived]: "customer",
  [NOTIFICATION_KIND.refundRequestApproved]: "customer",
  [NOTIFICATION_KIND.refundRequestRejected]: "customer",
  [NOTIFICATION_KIND.feedbackUserReceived]: "customer",
  [NOTIFICATION_KIND.feedbackUserReviewing]: "customer",
  [NOTIFICATION_KIND.feedbackUserCompleted]: "customer",
  [NOTIFICATION_KIND.feedbackUserCompletedResend]: "customer",
  [NOTIFICATION_KIND.autoFixReviewRequested]: "operator",
  [NOTIFICATION_KIND.autoFixProductionVerified]: "operator",
  [NOTIFICATION_KIND.autoFixPromotionFailed]: "operator",
};

/** A kind this queue does not know is not a customer's: it is refused earlier. */
export const isCustomerNotificationKind = (kind: string) =>
  NOTIFICATION_AUDIENCE[kind as NotificationKind] === "customer";

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
type RenderedNotification =
  | { to: string; subject: string; text: string; html: string }
  /** Nothing to send, and why. Distinct reasons because "no mail arrived" is
   * a question an operator has to be able to answer. */
  | { refusal: "contact_removed" | "not_consented" };

const isRenderRefusal = (
  value: RenderedNotification | null
): value is { refusal: "contact_removed" | "not_consented" } =>
  Boolean(value && "refusal" in value);

async function renderNotification(
  kind: string,
  referenceId: string
): Promise<RenderedNotification | null> {
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
        errorReportVerification: true,
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
        autoReviewed: qualifiesForTraceAutoReview({
          verification: feedback.errorReportVerification,
          traceId: feedback.traceId,
        }),
      }),
    };
  }

  const autoFixKind: Record<string, AutoFixOperatorEmailKind> = {
    [NOTIFICATION_KIND.autoFixReviewRequested]: "review_requested",
    [NOTIFICATION_KIND.autoFixProductionVerified]: "production_verified",
    [NOTIFICATION_KIND.autoFixPromotionFailed]: "promotion_failed",
  };
  if (autoFixKind[kind]) {
    const recipient = supportNotificationRecipient();
    if (!recipient) return null;
    const autoFixCase = await prisma.feedbackAutoFixCase.findUnique({
      where: { id: referenceId },
      select: {
        id: true,
        feedbackId: true,
        fixPrUrl: true,
        fixReport: true,
        fixManifest: true,
        diagnosticSummary: true,
        productionPrUrl: true,
        productionMergeSha: true,
        terminalReason: true,
      },
    });
    if (!autoFixCase) return null;
    const report = (autoFixCase.fixReport ?? {}) as Record<string, unknown>;
    const summary = (autoFixCase.diagnosticSummary ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    const changedPaths = Array.isArray(autoFixCase.fixManifest)
      ? autoFixCase.fixManifest
          .map((entry) => text((entry as Record<string, unknown> | null)?.path))
          .filter((path): path is string => Boolean(path))
      : [];
    const consoleBase =
      process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://tomverse.app";
    return {
      to: recipient,
      ...buildAutoFixOperatorEmail(autoFixKind[kind], {
        caseId: autoFixCase.id,
        feedbackId: autoFixCase.feedbackId,
        errorCode: text(summary.errorCode),
        fixPrUrl: autoFixCase.fixPrUrl,
        rootCause: text(report.rootCause),
        fixSummary: text(report.fixSummary),
        testSummary: text(report.testSummary),
        changedPaths,
        productionPrUrl: autoFixCase.productionPrUrl,
        productionMergeSha: autoFixCase.productionMergeSha,
        terminalReason: autoFixCase.terminalReason,
        consoleUrl: `${consoleBase}/admin/support?tab=fixes`,
      }),
    };
  }

  const feedbackUserStage: Record<string, FeedbackLifecycleStage> = {
    [NOTIFICATION_KIND.feedbackUserReceived]: "received",
    [NOTIFICATION_KIND.feedbackUserReviewing]: "reviewing",
    [NOTIFICATION_KIND.feedbackUserCompleted]: "completed",
    [NOTIFICATION_KIND.feedbackUserCompletedResend]: "completed",
  };
  const lifecycleStage = feedbackUserStage[kind];
  if (lifecycleStage) {
    // Rendered from the immutable lifecycle event, so a retry presents the
    // same subject and body as the first attempt. Only the recipient is
    // resolved at send time, against the stage's own rule
    // (feedbackStageRecipient): the answer to a report needs an address, the
    // two progress notices need the reporter's tick, and an address removed by
    // account deletion makes every still-pending stage unsendable rather than
    // mailing an address the user took away.
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
    const recipient = feedbackStageRecipient({
      stage: lifecycleStage,
      email: feedback.email,
      emailUpdatesConsent: feedback.emailUpdatesConsent,
    });
    if (!recipient.canSend) {
      // Named rather than folded into "source missing": an operator asking why
      // a reply never arrived needs to know which of these it was.
      return {
        refusal:
          recipient.reason === "no_address" ? "contact_removed" : "not_consented",
      };
    }
    return {
      to: feedback.email as string,
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
  if (isRenderRefusal(message)) {
    return { kind: "unsendable", reason: message.refusal };
  }

  try {
    const senderRole = NOTIFICATION_SENDER_ROLE[kind as NotificationKind];
    if (!senderRole) {
      // A kind with no sender is a kind this module does not know how to send.
      // Refused rather than sent as the general identity: an unknown message
      // going out under whichever sender is the default is precisely what the
      // role axis exists to stop.
      return { kind: "unsendable", reason: "sender_role_unknown" };
    }
    // A customer-facing notice goes out through the one helper every
    // customer-facing send uses: the address lock, the suppression word taken
    // inside it, and the submission in the same scope
    // (docs/policy/email-product-news-redesign-draft.md section 7.4, C29).
    //
    // The refund notices join the reporter-facing ones here. They asked nobody
    // before, which meant a hard bounce, an operator's stop or a privacy
    // request reached the provider as an attempt and came back looking like
    // the provider's fault. They get the transactional verdict, so a
    // complaint does not stop them -- docs/policy/email-notifications.md §13.3
    // decides that, not this file.
    //
    // Operator alerts do not pass through here: they go to the team about
    // somebody else's report, and a queue-level stop on a customer address
    // must not silence them.
    if (isCustomerNotificationKind(kind)) {
      const submitted = await sendWithAddressLock({
        emailAddress: message.to,
        classification: "transactional",
        // The lane cap; the helper cuts it to what the transaction can
        // protect. Without a timeout there is no abort signal at all, and the
        // request could outlive the lock and put a message on the wire after a
        // withdrawal completed.
        providerTimeoutMs: STANDARD_SEND_PROVIDER_TIMEOUT_MS,
        submit: ({ providerTimeoutMs }) =>
          sendTransactionalEmail({
            ...message,
            senderRole,
            idempotencyKey: `notification-delivery:${deliveryId}`,
            timeoutMs: providerTimeoutMs,
          }),
      });
      if (submitted.ok === false && submitted.reason === "lock_unavailable") {
        return { kind: "lock_unavailable" };
      }
      if (submitted.ok === false) {
        // manual and privacy_request share one skip reason in the core table;
        // the console shows what it is given rather than inventing a split.
        return { kind: "unsendable", reason: `suppressed:${submitted.skipReason}` };
      }
      if (submitted.raiseIncident === "transactional_complaint") {
        // The verdict taken under the lock. The notice goes out anyway -- it
        // answers something this person asked for -- but the complaint needs a
        // person to look at it (§13.3).
        await reportOperationalIncident({
          code: "EMAIL_TRANSACTIONAL_COMPLAINT_SEND",
          title: "Sending to an address that reported transactional mail as spam",
          error:
            "A queued notification is going out anyway -- it answers something " +
            "this person asked for -- but the complaint needs a person to look at it.",
          severity: "warning",
          cooldownMs: 60 * 60 * 1_000,
          context: { component: "notification-deliveries", classification: "transactional" },
        });
      }
      if (submitted.value.skipped) return { kind: "not_configured" };
      return { kind: "delivered" };
    }

    const result = await sendTransactionalEmail({
      ...message,
      senderRole,
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
 * It claims the row exactly as a drain does before it sends (independent
 * review 2026-09-16, F5): the two used to race, and only identical payloads
 * and the provider's idempotency key kept that from being visible. A row this
 * call does not win is left to whoever did.
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
    const now = new Date();
    const row = await prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { status: true, attempts: true, nextAttemptAt: true },
    });
    if (!row || row.status !== NOTIFICATION_DELIVERY_STATUS.pending) {
      return { delivered: false, status: row?.status ?? "missing", errorKind: null };
    }
    // The drain's own claim, byte for byte: whoever moves nextAttemptAt from
    // the value they read owns this attempt.
    const claimed = await prisma.notificationDelivery.updateMany({
      where: {
        id: deliveryId,
        status: NOTIFICATION_DELIVERY_STATUS.pending,
        nextAttemptAt: row.nextAttemptAt,
      },
      data: { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) },
    });
    if (claimed.count !== 1) {
      // A drain got there first; it will report what happened.
      return { delivered: false, status: "pending", errorKind: "not_claimed" };
    }
    const outcome = await attemptNotificationDelivery({
      kind,
      referenceId,
      deliveryId,
    });
    const transition = await recordNotificationAttempt({
      id: deliveryId,
      attemptsBefore: row.attempts,
      outcome,
      now,
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
