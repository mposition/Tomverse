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
import { FEEDBACK_LIFECYCLE_STAGE } from "@/lib/feedbackLifecycleCore";
import { isLanguage } from "@/lib/language";
import {
  NOTIFICATION_KIND,
  deliverNotificationNow,
  enqueueNotificationDelivery,
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
    /**
     * Per-report opt-in to lifecycle status emails. Transactional consent for
     * this submission only -- never a account-wide marketing preference.
     */
    emailUpdates: z.boolean().optional(),
    /** The submitter's UI language; validated against lib/language.ts. */
    language: z.string().trim().max(10).optional(),
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
    // The server-verified account address always wins: a signed-in caller's
    // client-sent email must never override it, or a compromised client could
    // point another account's receipts at an arbitrary inbox.
    const email = session?.user?.email || body.email || null;
    const emailUpdatesConsent = Boolean(body.emailUpdates) && Boolean(email);
    if (!session?.user?.id && emailUpdatesConsent && body.email) {
      // A guest asking us to mail an address they typed is the one place this
      // endpoint fans out to an arbitrary recipient, so the address itself gets
      // its own budget on top of the per-caller one above (same pattern as
      // lib/emailLogin.ts). Checked only after Turnstile passed, so a token-less
      // bot cannot burn a victim address's budget and lock them out of receipts.
      await consumeApiRateLimit(
        req,
        `feedback-recipient:${body.email.toLowerCase()}`,
        "feedback-recipient",
        { minute: 2, day: 5 }
      );
    }
    // The submitter's language, captured once so every later lifecycle email
    // renders in the language the report was made in. For accounts it comes
    // from the server-side setting, never from the client payload.
    let language = "en";
    if (session?.user?.id) {
      const settings = await prisma.userSettings.findUnique({
        where: { userId: session.user.id },
        select: { language: true },
      });
      if (isLanguage(settings?.language)) language = settings.language;
    } else if (isLanguage(body.language)) {
      language = body.language;
    }
    // The report and every promise attached to it commit together: the
    // operator notification, the received lifecycle event, and (when consented)
    // the submitter's receipt email. Enqueuing after the write would leave a
    // window where a crash loses a notification with no record one was owed.
    const { feedback, delivery, userDelivery } = await prisma.$transaction(async (tx) => {
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
          language,
          emailUpdatesConsent,
        },
      });
      // The immutable snapshot the receipt email renders from -- and the
      // record that this stage was announced at most once.
      await tx.feedbackLifecycleEvent.create({
        data: {
          feedbackId: feedback.id,
          stage: FEEDBACK_LIFECYCLE_STAGE.received,
          previousStatus: null,
          newStatus: feedback.status,
        },
      });
      const delivery = await enqueueNotificationDelivery(tx, {
        kind: NOTIFICATION_KIND.supportFeedback,
        referenceId: feedback.id,
      });
      const userDelivery = emailUpdatesConsent
        ? await enqueueNotificationDelivery(tx, {
            kind: NOTIFICATION_KIND.feedbackUserReceived,
            referenceId: feedback.id,
          })
        : null;
      return { feedback, delivery, userDelivery };
    });

    // From here on the submission is stored. Nothing below may turn this into
    // a failure for the user: a notification that cannot be delivered is an
    // operations problem, not a rejected report. The first attempts happen
    // inline so the common case still notifies immediately; anything else is
    // left to the retry queue, which drains on the maintenance cron.
    const supportOutcome = await deliverNotificationNow({
      deliveryId: delivery.id,
      kind: NOTIFICATION_KIND.supportFeedback,
      referenceId: feedback.id,
    });
    if (!supportOutcome.delivered) {
      console.warn(
        JSON.stringify({
          event: "support_notification_failed",
          feedbackId: feedback.id,
          deliveryId: delivery.id,
          // The delivery outcome's *class*, not a provider message: that
          // body echoes the request, which here is the reporter's words.
          reason: supportOutcome.errorKind,
          queued: supportOutcome.status === NOTIFICATION_DELIVERY_STATUS.pending,
        })
      );
    }
    let userReceiptDelivered = false;
    if (userDelivery) {
      const receiptOutcome = await deliverNotificationNow({
        deliveryId: userDelivery.id,
        kind: NOTIFICATION_KIND.feedbackUserReceived,
        referenceId: feedback.id,
      });
      userReceiptDelivered = receiptOutcome.delivered;
      if (!receiptOutcome.delivered) {
        console.warn(
          JSON.stringify({
            event: "feedback_user_receipt_failed",
            feedbackId: feedback.id,
            deliveryId: userDelivery.id,
            reason: receiptOutcome.errorKind,
            queued:
              receiptOutcome.status === NOTIFICATION_DELIVERY_STATUS.pending,
          })
        );
      }
    }

    // The operational record of one submission. Deliberately made of
    // presence flags and classifications only: no message body, no trace ID
    // value, no email address, no Turnstile token, no cookie, no user agent.
    console.info(
      JSON.stringify({
        event: "user_feedback",
        feedbackId: feedback.id,
        subject: session?.user?.id ? "user" : "guest",
        userId: session?.user?.id || null,
        type: body.type,
        status: 200,
        turnstile: turnstileOutcome,
        notificationDelivered: supportOutcome.delivered,
        notificationDeliveryId: delivery.id,
        emailUpdatesConsent,
        userReceiptDeliveryId: userDelivery?.id || null,
        userReceiptDelivered,
        language,
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
      // Whether lifecycle status emails are on for this report, so the UI can
      // say a receipt is on its way -- never whether the send succeeded, which
      // is the queue's business, not the submitter's problem.
      emailUpdatesEnabled: emailUpdatesConsent,
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
