export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { forwardAmuxAdminReviewCommand } from "@/lib/amux/reviewAdminProxy";

const proposalSchema = z.object({
  escalation_id: z.string().cuid(),
  outcome: z.enum(["approve", "retry", "block"]),
  expected_subject_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session))
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write"))
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id, "admin-amux-review-proposal", {
      minute: 10, day: 100,
    });
    const body = await readLimitedJson(request, 2 * 1_024, proposalSchema);
    return forwardAmuxAdminReviewCommand(request, { action: "proposal", ...body });
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
