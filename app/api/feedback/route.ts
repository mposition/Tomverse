export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const feedbackSchema = z
  .object({
    type: z.enum(["bug", "feature", "billing", "other"]),
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
    await prisma.feedback.create({
      data: {
        userId: session?.user?.id || null,
        email: session?.user?.email || null,
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
    console.warn(
      JSON.stringify({
        event: "user_feedback",
        userId: session?.user?.id || null,
        email: session?.user?.email || null,
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
