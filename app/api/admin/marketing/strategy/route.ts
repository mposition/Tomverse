export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readLatestMarketingStrategy } from "@/lib/marketingReportRead";
import { prisma } from "@/lib/prisma";

/**
 * GET: the newest weekly marketing plan (lib/marketingStrategyCore.ts), for
 * the strategy card at the top of the Reports tab. Read-only and ordinary
 * admin authentication, like the one-report route beside it: nothing is
 * written or audited, and no feature switch changes whether it answers.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-strategy-read", {
      minute: 60,
      day: 600,
    });
    return NextResponse.json(await readLatestMarketingStrategy(prisma), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read the marketing strategy:", error);
    return NextResponse.json({ error: "Failed to load the strategy." }, { status: 500 });
  }
}
