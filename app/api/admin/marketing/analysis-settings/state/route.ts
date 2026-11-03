export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readMarketingAnalysisSetting } from "@/lib/marketingAnalysisStore";
import { prisma } from "@/lib/prisma";

/**
 * GET: the marketing analysis and brief switch and its compare-and-set
 * version, for the screen that changes it (../route.ts). Ordinary admin
 * authentication, as for every marketing read; nothing is written.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-analysis-settings-read", {
      minute: 30,
      day: 300,
    });
    return NextResponse.json(await readMarketingAnalysisSetting(prisma), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read the marketing analysis switch:", error);
    return NextResponse.json({ error: "Failed to read the switch." }, { status: 500 });
  }
}
