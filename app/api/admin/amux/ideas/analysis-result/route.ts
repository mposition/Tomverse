export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  AMUX_V4_ANALYSIS_RESULT_READ_ENV,
  amuxV4AnalysisResultReadEnabled,
} from "@/lib/amux/ideaAnalysisResultReadCore";
import { AmuxIdeaAnalysisResultReadError } from
  "@/lib/amux/ideaAnalysisResultReadService";
import { readAmuxIdeaAnalysisResult } from
  "@/lib/amux/ideaContinuedAnalysisResultReadService";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

async function owner(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
}

/** Read-only owner view of a complete, independently encrypted proposal. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!amuxV4AnalysisResultReadEnabled(process.env[AMUX_V4_ANALYSIS_RESULT_READ_ENV])) {
      return NextResponse.json({ error: "analysis_result_disabled" },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-analysis-result", {
      minute: 10, day: 100,
    });
    const params = new URL(request.url).searchParams;
    const ideaId = params.get("ideaId");
    const cursor = params.get("startChunkIndex");
    const startChunkIndex = cursor === null ? 0 : Number(cursor);
    if ((params.size !== 1 && params.size !== 2) ||
        (params.size === 2 && cursor === null) ||
        !ideaId || !isAmuxIdeaRequestId(ideaId) ||
        (cursor !== null && (!/^(0|[1-9][0-9]*)$/.test(cursor) ||
          !Number.isSafeInteger(startChunkIndex) ||
          startChunkIndex >= 2_147_483_647))) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const result = await readAmuxIdeaAnalysisResult(session, ideaId,
      loadCurrentAmuxContentKeys(process.env), startChunkIndex);
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof AmuxIdeaAnalysisResultReadError) {
      return NextResponse.json({ error: error.code },
        { status: error.code === "not_found" ? 404 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    console.error("AMUX v4 analysis result unavailable");
    return NextResponse.json({ error: "analysis_result_unavailable" },
      { status: 503, headers: noStore });
  }
}
