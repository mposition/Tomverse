export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { forwardAmuxAdminReviewCommand } from "@/lib/amux/reviewAdminProxy";

const querySchema = z.object({
  decision_id: z.string().uuid(),
  subject_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session))
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write"))
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id, "admin-amux-review-decision-status", {
      minute: 30, day: 400,
    });
    const params = new URL(request.url).searchParams;
    const input = querySchema.safeParse({
      decision_id: params.getAll("decision_id").length === 1 ? params.get("decision_id") : null,
      subject_digest: params.getAll("subject_digest").length === 1 ? params.get("subject_digest") : null,
    });
    if (!input.success || [...params.keys()].some((key) => !["decision_id", "subject_digest"].includes(key))) {
      return NextResponse.json({ code: "AMUX_REVIEW_BAD_REQUEST" }, { status: 400 });
    }
    return forwardAmuxAdminReviewCommand(request, { action: "decision_status", ...input.data });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json(
        { code: "ADMIN_REAUTHENTICATION_REQUIRED", error: "Sign in again." },
        { status: 428 },
      );
    }
    const security = apiSecurityResponse(error);
    if (security) return security;
    return NextResponse.json({ code: "AMUX_REVIEW_INTERNAL_ERROR" }, { status: 500 });
  }
}
