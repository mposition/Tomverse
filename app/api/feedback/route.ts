export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { sendTransactionalEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

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
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const subject = session?.user?.id || "guest";
    await consumeApiRateLimit(req, subject, "feedback-submit", {
      minute: 5,
      day: 30,
    });
    const body = await readLimitedJson(req, 8 * 1024, feedbackSchema);
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

    const supportEmail = process.env.SUPPORT_NOTIFICATION_EMAIL;
    if (supportEmail) {
      sendTransactionalEmail({
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
            <p><strong>Feedback ID:</strong> ${feedback.id}</p>
            <p><strong>Type:</strong> ${body.type}</p>
            <p><strong>Email:</strong> ${email || "guest"}</p>
            <p><strong>Trace ID:</strong> ${body.traceId || "-"}</p>
            <p><strong>Model:</strong> ${body.modelId || "-"}</p>
            <p><strong>Plan:</strong> ${body.plan || "-"}</p>
            <p><strong>Attachments:</strong> ${body.attachmentCount || 0}</p>
            <p><strong>Path:</strong> ${body.path || "-"}</p>
            <hr />
            <p style="white-space:pre-wrap">${body.message}</p>
          </div>
        `,
      }).catch((error) => {
        console.warn("Support notification email failed:", error);
      });
    }

    console.warn(
      JSON.stringify({
        event: "user_feedback",
        userId: session?.user?.id || null,
        email,
        ...body,
      })
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Feedback submit failed:", error);
    return NextResponse.json({ error: "Failed to submit feedback." }, { status: 500 });
  }
}
