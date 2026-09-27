export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { forwardAmuxAdminReviewCommand } from "@/lib/amux/reviewAdminProxy";

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session))
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write"))
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id, "admin-amux-review-detail", {
      minute: 20, day: 200,
    });
    const url = new URL(request.url);
    const values = url.searchParams.getAll("escalation_id");
    if (values.length !== 1 || !/^c[a-z0-9]{20,}$/i.test(values[0]))
      return NextResponse.json({ code: "AMUX_REVIEW_BAD_REQUEST" }, { status: 400 });
    return forwardAmuxAdminReviewCommand(request, {
      action: "detail", escalation_id: values[0],
    });
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
