export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const updateFeedbackSchema = z
  .object({
    status: z.enum(["open", "reviewing", "resolved", "closed"]),
  })
  .strict();

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
    const body = await readLimitedJson(req, 2 * 1024, updateFeedbackSchema);

    const feedback = await prisma.feedback.update({
      where: { id: feedbackId },
      data: { status: body.status },
    });

    return NextResponse.json({ success: true, feedback });
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
