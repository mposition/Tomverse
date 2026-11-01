export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { MARKETING_REPORT_ID, readMarketingReportForConsole } from "@/lib/marketingReportRead";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ reportId: string }> };

/**
 * GET: what one stored report says, for a person reading it from the Reports
 * tab. Read-only and ordinary admin authentication, like the rest of the
 * Marketing console (docs/policy/marketing-automation.md §6.1): no feature
 * switch changes whether it answers, and nothing is written or audited.
 *
 * A row whose payload does not parse as its kind is 422, not a loose render.
 */
export async function GET(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-report-read", {
      minute: 60,
      day: 600,
    });

    const { reportId } = await context.params;
    if (!MARKETING_REPORT_ID.test(reportId)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const result = await readMarketingReportForConsole(prisma, reportId);
    if (result.kind === "missing") return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (result.kind === "unreadable") {
      return NextResponse.json({ error: "Report unreadable.", code: "unreadable" }, { status: 422 });
    }
    return NextResponse.json(result.report, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read a marketing report:", error);
    return NextResponse.json({ error: "Failed to load the report." }, { status: 500 });
  }
}
