export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import {
  FEEDBACK_CLOSURE_OUTCOMES,
  FEEDBACK_STATUSES,
  FEEDBACK_USER_REPLY_MAX_LENGTH,
  isTerminalFeedbackStatus,
  isValidFeedbackUserReply,
  lifecycleStageForStatus,
} from "@/lib/feedbackLifecycleCore";
import {
  FEEDBACK_USER_NOTIFICATION_KIND,
  deliverNotificationNow,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";
import { NOTIFICATION_DELIVERY_STATUS } from "@/lib/notificationRetryCore";

const updateFeedbackSchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES),
    /** Required when closing: how the report was actually resolved. */
    outcomeCode: z.enum(FEEDBACK_CLOSURE_OUTCOMES).optional(),
    /**
     * The short reply written FOR THE SUBMITTER, quoted (escaped) in the
     * completed email. Never the internal admin note.
     */
    userReply: z.string().trim().max(FEEDBACK_USER_REPLY_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * Why no submitter email was queued for this transition, when one was not.
 * Returned to the admin UI so "no email" is legible without exposing the
 * address itself.
 */
type UserNotificationSkipReason =
  /** The new status announces no lifecycle stage (back to open). */
  | "no_stage"
  /** This stage was already announced once; the event record exists. */
  | "already_notified"
  /** No contact address, or the submitter did not opt in for this report. */
  | "not_notifiable";

type RouteContext = {
  params: Promise<{ feedbackId: string }>;
};

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "support:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-feedback-update", {
      minute: 20,
      day: 300,
    });

    const { feedbackId } = await context.params;
    const body = await readLimitedJson(req, 4 * 1024, updateFeedbackSchema);
    const terminal = isTerminalFeedbackStatus(body.status);
    if (terminal && !body.outcomeCode) {
      return NextResponse.json(
        {
          error: "A closure outcome is required to resolve or close feedback.",
          code: "FEEDBACK_OUTCOME_REQUIRED",
        },
        { status: 400 }
      );
    }
    if (!terminal && (body.outcomeCode || body.userReply)) {
      return NextResponse.json(
        {
          error: "Outcome and user reply only apply when closing feedback.",
          code: "FEEDBACK_OUTCOME_NOT_APPLICABLE",
        },
        { status: 400 }
      );
    }
    // Optional, but when present it must read as a sentence and stay a
    // summary. The empty string counts as absent.
    if (!isValidFeedbackUserReply(body.userReply)) {
      return NextResponse.json(
        {
          error: "The user-facing reply is too short.",
          code: "FEEDBACK_USER_REPLY_INVALID",
        },
        { status: 400 }
      );
    }
    const userReply = body.userReply?.trim() ? body.userReply.trim() : null;

    await writeAdminAuditLog({
      session,
      request: req,
      action: "feedback.status.update_started",
      targetType: "Feedback",
      targetId: feedbackId,
      summary: `Started feedback status change to ${body.status}.`,
      // Never the reply text or any address: status and outcome code only.
      metadata: { status: body.status, outcomeCode: body.outcomeCode || null },
    });

    const stage = lifecycleStageForStatus(body.status);
    // The status change, the immutable lifecycle event, the notification queue
    // row and the success audit entry commit or roll back together. Email I/O
    // stays outside: the audit chain's advisory lock is held for the duration
    // of this transaction.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.feedback.findUnique({
        where: { id: feedbackId },
        select: { id: true, status: true, email: true, emailUpdatesConsent: true },
      });
      if (!existing) return null;

      const feedback = await tx.feedback.update({
        where: { id: feedbackId },
        data: {
          status: body.status,
          ...(terminal
            ? { closureOutcome: body.outcomeCode, userReply }
            : {}),
        },
      });

      // Only the FIRST transition into a stage creates its event -- and only
      // that event can queue an email. `skipDuplicates` makes this a no-op
      // instead of an aborted transaction when the row already exists, which
      // is exactly what a refresh, a re-selected status, or a concurrent
      // request should be.
      let eventCreated = false;
      if (stage) {
        const created = await tx.feedbackLifecycleEvent.createMany({
          data: [
            {
              feedbackId,
              stage,
              previousStatus: existing.status,
              newStatus: body.status,
              outcomeCode: terminal ? body.outcomeCode : null,
              userReply: terminal ? userReply : null,
              actorUserId: session.user.id,
            },
          ],
          skipDuplicates: true,
        });
        eventCreated = created.count === 1;
      }

      const notifiable = Boolean(existing.email) && existing.emailUpdatesConsent;
      const delivery =
        stage && eventCreated && notifiable
          ? await enqueueNotificationDelivery(tx, {
              kind: FEEDBACK_USER_NOTIFICATION_KIND[stage],
              referenceId: feedbackId,
            })
          : null;

      await writeAdminAuditLog({
        session,
        request: req,
        tx,
        action: "feedback.status.updated",
        targetType: "Feedback",
        targetId: feedbackId,
        summary: `Changed feedback status to ${body.status}.`,
        metadata: {
          status: body.status,
          outcomeCode: body.outcomeCode || null,
          previousStatus: existing.status,
          userNotificationQueued: Boolean(delivery),
        },
      });

      return { feedback, delivery, eventCreated, notifiable, stage };
    });

    if (!result) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // The status change is committed. A failed send from here on is a retry
    // queue matter, reported to the admin as "queued", never as a failed
    // status change.
    let userNotification:
      | { queued: false; reason: UserNotificationSkipReason }
      | { queued: true; delivered: boolean };
    if (!result.stage) {
      userNotification = { queued: false, reason: "no_stage" };
    } else if (!result.eventCreated) {
      userNotification = { queued: false, reason: "already_notified" };
    } else if (!result.delivery) {
      userNotification = { queued: false, reason: "not_notifiable" };
    } else {
      const outcome = await deliverNotificationNow({
        deliveryId: result.delivery.id,
        kind: FEEDBACK_USER_NOTIFICATION_KIND[result.stage],
        referenceId: feedbackId,
      });
      userNotification = { queued: true, delivered: outcome.delivered };
      if (!outcome.delivered) {
        console.warn(
          JSON.stringify({
            event: "feedback_user_notification_failed",
            feedbackId,
            deliveryId: result.delivery.id,
            stage: result.stage,
            reason: outcome.errorKind,
            queued: outcome.status === NOTIFICATION_DELIVERY_STATUS.pending,
          })
        );
      }
    }

    return NextResponse.json({
      success: true,
      feedback: result.feedback,
      userNotification,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin feedback update failed:", error);
    return NextResponse.json(
      { error: "Failed to update feedback." },
      { status: 500 }
    );
  }
}
