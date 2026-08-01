export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { sendTransactionalEmail } from "@/lib/email";
import { EMAIL_FONT_STACK } from "@/lib/emailTypography";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { ensureGuestVerified } from "@/lib/turnstile";
import { feedbackReferenceFromId } from "@/lib/feedbackPolicy";

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

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const firstCsvValue = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);

const supportNotificationEmail = () =>
  process.env.SUPPORT_NOTIFICATION_EMAIL ||
  process.env.ADMIN_ALERT_EMAIL ||
  firstCsvValue(process.env.ADMIN_EMAILS);

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
    const feedback = await prisma.feedback.create({
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

    // From here on the submission is stored. Nothing below may turn this into
    // a failure for the user: a notification that cannot be delivered is an
    // operations problem, not a rejected report.
    let notificationDelivered = false;
    const supportEmail = supportNotificationEmail();
    if (supportEmail) {
      try {
        await sendTransactionalEmail({
          to: supportEmail,
          subject: `Tomverse support request: ${body.type}`,
          text: [
            `Feedback ID: ${feedback.id}`,
            `Type: ${body.type}`,
            `Email: ${email || "guest"}`,
            `Trace ID: ${body.traceId || "-"}`,
            `Model: ${body.modelId || "-"}`,
            `Plan: ${body.plan || "-"}`,
            `Attachments: ${body.attachmentCount || 0}`,
            `Path: ${body.path || "-"}`,
            "",
            body.message,
          ].join("\n"),
          html: `
            <div style="font-family:${EMAIL_FONT_STACK};color:#111827;line-height:1.6">
              <h2>New Tomverse support request</h2>
              <p><strong>Feedback ID:</strong> ${escapeHtml(feedback.id)}</p>
              <p><strong>Type:</strong> ${escapeHtml(body.type)}</p>
              <p><strong>Email:</strong> ${escapeHtml(email || "guest")}</p>
              <p><strong>Trace ID:</strong> ${escapeHtml(body.traceId || "-")}</p>
              <p><strong>Model:</strong> ${escapeHtml(body.modelId || "-")}</p>
              <p><strong>Plan:</strong> ${escapeHtml(body.plan || "-")}</p>
              <p><strong>Attachments:</strong> ${escapeHtml(body.attachmentCount || 0)}</p>
              <p><strong>Path:</strong> ${escapeHtml(body.path || "-")}</p>
              <hr />
              <p style="white-space:pre-wrap">${escapeHtml(body.message)}</p>
            </div>
          `,
        });
        notificationDelivered = true;
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "support_notification_failed",
            feedbackId: feedback.id,
            // The delivery error's *class*, not its text: a provider message
            // can quote the request it was given.
            reason: error instanceof Error ? error.name : "unknown",
          })
        );
      }
    } else {
      console.warn(
        JSON.stringify({
          event: "support_notification_skipped",
          feedbackId: feedback.id,
          reason: "recipient not configured",
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
