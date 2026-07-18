export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-scheduled-jobs", {
      minute: 30,
      day: 1_000,
    });
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      jobs: await getScheduledJobsDashboard(),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin scheduled jobs dashboard failed:", error);
    return NextResponse.json(
      { error: "Failed to load scheduled jobs." },
      { status: 500 }
    );
  }
}
