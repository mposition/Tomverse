export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { feedbackStageRecipient } from "@/lib/feedbackLifecycleCore";
import {
  NOTIFICATION_KIND,
  deliverNotificationNow,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";

/**
 * POST: send a completed reply that was written but never sent.
 *
 * Until 2026-09-16 the answer to a report needed the reporter's "email me
 * status updates" tick, so an operator could write a reply, close the report
 * and have it reach nobody. Those replies are still on their lifecycle events.
 * This sends one -- exactly as it was written, because the event is immutable
 * and is what gets rendered -- and only when there is somewhere to send it and
 * nothing was ever queued (or the queue gave up).
 *
 * `(kind, referenceId)` makes it once per report: a second press finds the row
 * already there and changes nothing.
 */
type RouteContext = { params: Promise<{ feedbackId: string }> };

export async function POST(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "support:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-feedback-resend", {
      minute: 5,
      day: 50,
    });
    const { feedbackId } = await context.params;

    const feedback = await prisma.feedback.findUnique({
      where: { id: feedbackId },
      select: { id: true, email: true, emailUpdatesConsent: true },
    });
    if (!feedback) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const recipient = feedbackStageRecipient({
      stage: "completed",
      email: feedback.email,
      emailUpdatesConsent: feedback.emailUpdatesConsent,
    });
    if (!recipient.canSend) {
      return NextResponse.json(
        { error: "This report has no address to answer.", code: "NO_ADDRESS" },
        { status: 409 }
      );
    }
    const event = await prisma.feedbackLifecycleEvent.findUnique({
      where: { feedbackId_stage: { feedbackId, stage: "completed" } },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json(
        { error: "This report was never completed.", code: "NOT_COMPLETED" },
        { status: 409 }
      );
    }
    const existing = await prisma.notificationDelivery.findMany({
      where: {
        referenceId: feedbackId,
        kind: {
          in: [
            NOTIFICATION_KIND.feedbackUserCompleted,
            NOTIFICATION_KIND.feedbackUserCompletedResend,
          ],
        },
      },
      select: { kind: true, status: true },
    });
    // Anything still in flight is the queue's job; a delivered one is done.
    // Only a reply that was never queued, or one the queue abandoned, may be
    // sent again from here.
    const blocking = existing.find((row) => row.status !== "abandoned");
    if (blocking) {
      return NextResponse.json(
        {
          error: "This reply is already queued or was already sent.",
          code: blocking.status === "delivered" ? "ALREADY_SENT" : "ALREADY_QUEUED",
        },
        { status: 409 }
      );
    }
    if (existing.some((row) => row.kind === NOTIFICATION_KIND.feedbackUserCompletedResend)) {
      return NextResponse.json(
        { error: "This reply was already re-sent once.", code: "ALREADY_RESENT" },
        { status: 409 }
      );
    }

    const delivery = await prisma.$transaction(async (tx) => {
      const row = await enqueueNotificationDelivery(tx, {
        kind: NOTIFICATION_KIND.feedbackUserCompletedResend,
        referenceId: feedbackId,
      });
      await writeAdminAuditLog({
        session,
        request: req,
        tx,
        action: "feedback.reply.resent",
        targetType: "Feedback",
        targetId: feedbackId,
        summary: "Queued the stored completion reply for delivery.",
        // No address and no reply text: both are the reporter's.
        metadata: { deliveryId: row.id },
      });
      return row;
    });

    const outcome = await deliverNotificationNow({
      deliveryId: delivery.id,
      kind: NOTIFICATION_KIND.feedbackUserCompletedResend,
      referenceId: feedbackId,
    });
    return NextResponse.json({
      success: true,
      userNotification: { queued: true, delivered: outcome.delivered },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error(
      JSON.stringify({
        event: "admin_feedback_resend_failed",
        reason: error instanceof Error ? error.name : "unknown",
      })
    );
    return NextResponse.json({ error: "Failed to send the reply." }, { status: 500 });
  }
}
