export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { marketingWeekWindow } from "@/lib/marketingMeasurementCore";
import { prisma } from "@/lib/prisma";
import { marketingLastFullWeekStart, readMarketingWeeklyReport } from "@/lib/marketingWeeklyReportRead";

/**
 * GET ?week=YYYY-MM-DD (a Brisbane Monday; default the last full week): the
 * weekly marketing report, assembled from the tables when read
 * (lib/marketingWeeklyReportRead.ts). Read-only and ordinary admin
 * authentication, like the other report routes: nothing is written or
 * audited. A week that is not a Monday or has not begun is 404.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const week = new URL(req.url).searchParams.get("week") ?? marketingLastFullWeekStart(Date.now());
    const window = marketingWeekWindow(week);
    if (!window || window.start.getTime() > Date.now()) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-weekly-report-read", {
      minute: 60,
      day: 600,
    });
    const report = await readMarketingWeeklyReport(prisma, week);
    if (!report) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(report, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read the weekly marketing report:", error);
    return NextResponse.json({ error: "Failed to load the weekly report." }, { status: 500 });
  }
}
