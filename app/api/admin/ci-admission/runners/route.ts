export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readCiRunnerUsage } from "@/lib/ciRunnerUsage";

/**
 * Admin › Agent digests: GitHub Actions runner usage right now
 * (lib/ciRunnerUsage.ts), polled by the CI admission section. Any
 * administrator may read it; the answer is shared and cached server-side.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-ci-runner-usage-read", { minute: 20, day: 5000 });
    return NextResponse.json(await readCiRunnerUsage());
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read runner usage:", error);
    return NextResponse.json({ error: "Failed to read runner usage." }, { status: 500 });
  }
}
