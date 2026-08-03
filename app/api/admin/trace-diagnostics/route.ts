export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { isAutoFixShadowModeEnabled } from "@/lib/feedbackAutoFixCore";

/**
 * Phase 2 observation metrics (docs/policy/trace-feedback-automation.md §8).
 *
 * These counts are what the Phase 3 go/no-go decision reads: how many
 * reports verified, how the shadow cases classified, and how many candidates
 * a human actually looked at. Aggregates only -- no report bodies, no trace
 * values, no tokens.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-trace-diagnostics", {
      minute: 30,
      day: 500,
    });

    const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      totalReports,
      tracedReports,
      verificationBreakdown,
      caseStateBreakdown,
      caseClassificationBreakdown,
    ] = await Promise.all([
      prisma.feedback.count({ where: { createdAt: { gte: windowStart } } }),
      prisma.feedback.count({
        where: { createdAt: { gte: windowStart }, traceId: { not: null } },
      }),
      prisma.feedback.groupBy({
        by: ["errorReportVerification"],
        where: { createdAt: { gte: windowStart }, traceId: { not: null } },
        _count: { _all: true },
      }),
      prisma.feedbackAutoFixCase.groupBy({
        by: ["state"],
        where: { createdAt: { gte: windowStart } },
        _count: { _all: true },
      }),
      prisma.feedbackAutoFixCase.groupBy({
        by: ["classification"],
        where: { createdAt: { gte: windowStart } },
        _count: { _all: true },
      }),
    ]);

    const toRecord = (
      rows: Array<{ _count: { _all: number } } & Record<string, unknown>>,
      key: string
    ) =>
      Object.fromEntries(
        rows.map((row) => [String(row[key] ?? "none"), row._count._all])
      );

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      shadowModeEnabled: isAutoFixShadowModeEnabled(),
      reports: {
        total: totalReports,
        withTraceId: tracedReports,
        verification: toRecord(verificationBreakdown, "errorReportVerification"),
      },
      shadowCases: {
        byState: toRecord(caseStateBreakdown, "state"),
        byClassification: toRecord(
          caseClassificationBreakdown,
          "classification"
        ),
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error(
      JSON.stringify({
        event: "admin_trace_diagnostics_failed",
        reason: error instanceof Error ? error.name : "unknown",
        at: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      { error: "Failed to load trace diagnostics." },
      { status: 500 }
    );
  }
}
