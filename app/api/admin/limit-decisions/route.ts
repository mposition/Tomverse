export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { findChatLimitDecisionsByTraceId } from "@/lib/chatLimitDecisions";

/**
 * Trace ID lookup for a credit/cost refusal.
 *
 * The Trace ID shown to a blocked user is the only handle support has, so this
 * returns the full arithmetic behind the decision -- models, estimated tokens,
 * per-model cost, the pricing version that produced it, the allowance used and
 * required, the limit, the time zone and the reset instant. Unlike the user
 * response, internal micro-USD figures are included here on purpose.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-limit-decisions", {
      minute: 30,
      day: 1_000,
    });

    const url = new URL(req.url);
    const traceId = (url.searchParams.get("traceId") || "").trim();
    if (traceId.length < 8 || traceId.length > 120) {
      return NextResponse.json(
        { error: "A Trace ID is required.", code: "TRACE_ID_REQUIRED" },
        { status: 400 }
      );
    }

    const decisions = await findChatLimitDecisionsByTraceId(traceId);
    return NextResponse.json({
      traceId,
      generatedAt: new Date().toISOString(),
      count: decisions.length,
      decisions,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin limit decision lookup failed:", error);
    return NextResponse.json(
      { error: "Failed to load limit decisions." },
      { status: 500 }
    );
  }
}
