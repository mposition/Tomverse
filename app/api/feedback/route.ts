export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { sendTransactionalEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { verifyGuestTurnstile } from "@/lib/turnstile";

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

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const subject = session?.user?.id || "guest";
    await consumeApiRateLimit(req, subject, "feedback-submit", {
      minute: 5,
      day: 30,
    });
    const body = await readLimitedJson(req, 8 * 1024, feedbackSchema);
    if (!session?.user?.id) {
      await verifyGuestTurnstile(req, body.turnstileToken, "support_request");
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
            <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6">
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
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "support_notification_failed",
            feedbackId: feedback.id,
            reason: error instanceof Error ? error.message : "unknown",
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

    console.info(
      JSON.stringify({
        event: "user_feedback",
        userId: session?.user?.id || null,
        feedbackId: feedback.id,
        type: body.type,
        hasTraceId: Boolean(body.traceId),
        hasAttachments: Boolean(body.hasAttachments),
        attachmentCount: body.attachmentCount || 0,
      })
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const chatSecurityResponse = chatErrorResponse(error);
    if (chatSecurityResponse) return chatSecurityResponse;
    console.error("Feedback submit failed:", error);
    return NextResponse.json({ error: "Failed to submit feedback." }, { status: 500 });
  }
}
