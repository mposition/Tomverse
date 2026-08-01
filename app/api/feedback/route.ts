export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { ensureGuestVerified } from "@/lib/turnstile";
import { feedbackReferenceFromId } from "@/lib/feedbackPolicy";
import {
  NOTIFICATION_KIND,
  attemptNotificationDelivery,
  enqueueNotificationDelivery,
  recordNotificationAttempt,
} from "@/lib/notificationDeliveries";
import { NOTIFICATION_DELIVERY_STATUS } from "@/lib/notificationRetryCore";

const feedbackSchema = z
  .object({
    type: z.enum(["bug", "feature", "billing", "support", "other"]),
    email: z.string().trim().email().max(254).optional(),
    message: z.string().trim().min(5).max(2_000),
    traceId: z.string().trim().max(120).optional(),
    modelId: z.string().trim().max(120).optional(),
    plan: z.string().trim().max(40).optional(),
    hasAttachments: z.boolean().optional(),
    attachmentCount: z.number().int().min(0).max(5).optional(),
    path: z.string().trim().max(300).optional(),
    userAgent: z.string().trim().max(500).optional(),
    turnstileToken: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict();

/**
 * How the guest check was satisfied, for the operational log. Never the token
 * itself, and never the grant cookie -- only which of the three paths was
 * taken.
 */
type TurnstileOutcome =
  /** Signed-in caller: no challenge is required at all. */
  | "not_required"
  /** A recent pass was still valid, so no challenge was run. */
  | "existing_grant"
  /** A fresh token was verified and a new grant issued. */
  | "verified";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    // Per-caller, not a single shared "guest" bucket: one anonymous client must
    // not be able to exhaust the daily allowance for every other visitor.
    const subject = session?.user?.id || `guest:${getAnonymousClientKey(req)}`;
    await consumeApiRateLimit(req, subject, "feedback-submit", {
      minute: 5,
      day: 30,
    });
    const body = await readLimitedJson(req, 8 * 1024, feedbackSchema);
    let turnstileGrantCookie: string | undefined;
    let turnstileOutcome: TurnstileOutcome = "not_required";
    if (!session?.user?.id) {
      turnstileGrantCookie = await ensureGuestVerified(
        req,
        body.turnstileToken,
        "support_request"
      );
      // A returned cookie means a fresh token was verified; nothing back means
      // an existing grant already covered this caller.
      turnstileOutcome = turnstileGrantCookie ? "verified" : "existing_grant";
    }
    const email = session?.user?.email || body.email || null;
    // The report and the promise to notify about it commit together. Enqueuing
    // after the write would leave a window where a crash loses the
    // notification with no record that one was ever owed.
    const { feedback, delivery } = await prisma.$transaction(async (tx) => {
      const feedback = await tx.feedback.create({
        data: {
          userId: session?.user?.id || null,
          email,
          type: body.type,
          message: body.message,
          traceId: body.traceId || null,
          modelId: body.modelId || null,
          plan: body.plan || null,
          hasAttachments: Boolean(body.hasAttachments),
          attachmentCount: body.attachmentCount || 0,
          path: body.path || null,
          userAgent: body.userAgent || null,
        },
      });
      const delivery = await enqueueNotificationDelivery(tx, {
        kind: NOTIFICATION_KIND.supportFeedback,
        referenceId: feedback.id,
      });
      return { feedback, delivery };
    });

    // From here on the submission is stored. Nothing below may turn this into
    // a failure for the user: a notification that cannot be delivered is an
    // operations problem, not a rejected report. The first attempt happens
    // inline so the common case still notifies immediately; anything else is
    // left to the retry queue, which drains on the maintenance cron.
    let notificationDelivered = false;
    try {
      const outcome = await attemptNotificationDelivery({
        kind: NOTIFICATION_KIND.supportFeedback,
        referenceId: feedback.id,
        attempt: 1,
      });
      const transition = await recordNotificationAttempt({
        id: delivery.id,
        attemptsBefore: 0,
        outcome,
      });
      notificationDelivered =
        transition.status === NOTIFICATION_DELIVERY_STATUS.delivered;
      if (!notificationDelivered) {
        console.warn(
          JSON.stringify({
            event: "support_notification_failed",
            feedbackId: feedback.id,
            deliveryId: delivery.id,
            // The delivery outcome's *class*, not a provider message: that
            // body echoes the request, which here is the reporter's words.
            reason: transition.lastErrorKind,
            queued: transition.status === NOTIFICATION_DELIVERY_STATUS.pending,
          })
        );
      }
    } catch (error) {
      // The row is already queued, so a failure to even record the attempt
      // still leaves the notification recoverable on the next drain.
      console.warn(
        JSON.stringify({
          event: "support_notification_attempt_unrecorded",
          feedbackId: feedback.id,
          deliveryId: delivery.id,
          reason: error instanceof Error ? error.name : "unknown",
        })
      );
    }

    // The operational record of one submission. Deliberately made of
    // presence flags and classifications only: no message body, no trace ID
    // value, no Turnstile token, no cookie, no user agent.
    console.info(
      JSON.stringify({
        event: "user_feedback",
        feedbackId: feedback.id,
        subject: session?.user?.id ? "user" : "guest",
        userId: session?.user?.id || null,
        type: body.type,
        status: 200,
        turnstile: turnstileOutcome,
        notificationDelivered,
        notificationDeliveryId: delivery.id,
        hasTraceId: Boolean(body.traceId),
        hasModelId: Boolean(body.modelId),
        hasAttachments: Boolean(body.hasAttachments),
        attachmentCount: body.attachmentCount || 0,
        at: new Date().toISOString(),
      })
    );
    const response = NextResponse.json({
      success: true,
      // Returned so the submitter can be told, in concrete terms, that the
      // report was stored -- and can quote something back to support.
      feedbackId: feedback.id,
      reference: feedbackReferenceFromId(feedback.id),
    });
    if (turnstileGrantCookie) {
      response.headers.append("Set-Cookie", turnstileGrantCookie);
    }
    return response;
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const chatSecurityResponse = chatErrorResponse(error);
    if (chatSecurityResponse) return chatSecurityResponse;
    // Name and code only: a database error message can carry the parameters it
    // was called with, which here would be the feedback body itself.
    console.error(
      JSON.stringify({
        event: "user_feedback_failed",
        status: 500,
        reason: error instanceof Error ? error.name : "unknown",
        code:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code).slice(0, 40)
            : null,
        at: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      { error: "Failed to submit feedback.", code: "FEEDBACK_SUBMIT_FAILED" },
      { status: 500 }
    );
  }
}
