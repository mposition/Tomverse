export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readGithubOpenPullNumbers } from "@/lib/githubOpenPullNumbers";
import { readQaReleaseLaneRounds } from "@/lib/qaReleaseMergeLaneRoundStore";

/**
 * Admin › QA and release › Merge lane: the lane's latest rounds and verdicts
 * (lib/qaReleaseMergeLaneRoundStore.ts) with the pull requests open on GitHub
 * right now, polled by the lane tab so a pull request closed or merged since
 * the lane's last round leaves the page at once. Any administrator may read it.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-qa-release-lane-read", { minute: 20, day: 5000 });
    const [rounds, open] = await Promise.all([readQaReleaseLaneRounds(), readGithubOpenPullNumbers()]);
    return NextResponse.json({ rounds, open });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read the merge lane:", error);
    return NextResponse.json({ error: "Failed to read the merge lane." }, { status: 500 });
  }
}
