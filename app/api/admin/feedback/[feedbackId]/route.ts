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
  feedbackStageRecipient,
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
import { AUTOFIX_CASE_STATE } from "@/lib/feedbackAutoFixCore";

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
    /**
     * Close this one without telling the reporter. Deliberate and per-call:
     * some closures (a duplicate of a report the same person already has an
     * answer for) are not worth a second email, and the alternative an
     * operator reaches for otherwise is not closing the report at all.
     *
     * It withholds the announcement; it does not cancel it. No lifecycle
     * event is written, so nothing claims the reporter was told, and the
     * report stays eligible for "send this reply now" afterwards.
     */
    notifyReporter: z.boolean().optional(),
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
  /** No address on the report, so nothing can reach the reporter at all. */
  | "no_address"
  /** A progress notice the reporter did not ask for (the answer never needs
   * the tick -- docs/policy/email-notifications.md §3). */
  | "not_consented"
  /** The operator closed this one without announcing it. */
  | "operator_withheld";

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
    // Withholding is offered on closure and nowhere else, so it is refused
    // elsewhere rather than quietly honoured. The console's way back -- the
    // status button the report already sits on -- exists only for terminal
    // statuses; a withheld `reviewing` notice would have no way back at all,
    // which is precisely the trap the completed stage was rebuilt to avoid.
    if (!terminal && body.notifyReporter === false) {
      return NextResponse.json(
        {
          error: "Withholding the notice only applies when closing feedback.",
          code: "FEEDBACK_WITHHOLD_NOT_APPLICABLE",
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
    // Announcing is the default; withholding is something the operator asks
    // for on this call, and the audit entry records which it was.
    const notifyReporter = body.notifyReporter !== false;

    await writeAdminAuditLog({
      session,
      request: req,
      action: "feedback.status.update_started",
      targetType: "Feedback",
      targetId: feedbackId,
      summary: `Started feedback status change to ${body.status}.`,
      // Never the reply text or any address: status and outcome code only.
      metadata: {
        status: body.status,
        outcomeCode: body.outcomeCode || null,
        notifyReporter,
      },
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

      // A withheld announcement writes no event at all. The event is not proof
      // of delivery -- a missing address or a suppression still refuses the
      // send -- but it does claim this stage's single notification attempt:
      // (feedbackId, stage) is unique, and only creating it queues mail. Spend
      // that claim on a mail nobody sent and the reply can never go out. The
      // closure itself is still on the Feedback row and in the audit log.
      //
      // Only the FIRST transition into a stage creates its event -- and only
      // that event can queue an email. `skipDuplicates` makes this a no-op
      // instead of an aborted transaction when the row already exists, which
      // is exactly what a refresh, a re-selected status, or a concurrent
      // request should be.
      let eventCreated = false;
      if (stage && notifyReporter) {
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

      // An auto-fix observed live in production is finished by exactly this:
      // the operator resolving the report (with the reply draft, or their own
      // words). Compare-and-swap from production_verified only -- a case
      // still on its way to production is never closed by a resolve.
      let autoFixCaseClosed = false;
      if (terminal) {
        const closed = await tx.feedbackAutoFixCase.updateMany({
          where: { feedbackId, state: AUTOFIX_CASE_STATE.productionVerified },
          data: { state: AUTOFIX_CASE_STATE.closed, closedAt: new Date() },
        });
        autoFixCaseClosed = closed.count === 1;
      }

      // One rule for every stage and every surface (lib/feedbackLifecycleCore.ts):
      // the answer to the report needs an address, the progress notices need
      // the reporter's tick.
      const recipient = stage
        ? feedbackStageRecipient({
            stage,
            email: existing.email,
            emailUpdatesConsent: existing.emailUpdatesConsent,
          })
        : null;
      const delivery =
        stage && eventCreated && recipient?.canSend
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
          notifyReporter,
          userNotificationQueued: Boolean(delivery),
          autoFixCaseClosed,
        },
      });

      return {
        feedback,
        delivery,
        eventCreated,
        recipient,
        stage,
        notifyReporter,
        autoFixCaseClosed,
      };
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
    } else if (!result.notifyReporter) {
      userNotification = { queued: false, reason: "operator_withheld" };
    } else if (!result.eventCreated) {
      userNotification = { queued: false, reason: "already_notified" };
    } else if (!result.delivery) {
      userNotification = {
        queued: false,
        reason:
          result.recipient && !result.recipient.canSend
            ? result.recipient.reason
            : "no_address",
      };
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
      autoFixCaseClosed: result.autoFixCaseClosed,
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
