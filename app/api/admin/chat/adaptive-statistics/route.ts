import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getAdaptiveStatisticsReport } from "@/lib/adaptiveStatisticsReport";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-adaptive-statistics", {
      minute: 20,
      day: 500,
    });
    const days = new URL(request.url).searchParams.get("days") ?? "7";
    if (days !== "7" && days !== "30") {
      return NextResponse.json({ error: "days must be 7 or 30.", code: "INVALID_WINDOW" }, { status: 400 });
    }
    return NextResponse.json(await getAdaptiveStatisticsReport(Number(days) as 7 | 30), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("admin adaptive statistics failed", error);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
