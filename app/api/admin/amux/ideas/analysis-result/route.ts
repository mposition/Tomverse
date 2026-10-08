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
import { AmuxIdeaAnalysisResultReadError,
  readAmuxFirstIdeaAnalysisResult } from "@/lib/amux/ideaAnalysisResultReadService";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import { amuxAnalysisFreeformSubjectId } from
  "@/lib/amux/ideaAnalysisDraftSealCore";
import { loadAmuxContentKeyRing,
  type AmuxContentKeyIdentity } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";

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
    const chunkText = params.get("chunkIndex");
    const chunkIndex = chunkText === null ? 0 : Number(chunkText);
    if (![1, 2].includes(params.size) || !ideaId ||
        !isAmuxIdeaRequestId(ideaId) ||
        (params.size === 2 && (params.getAll("chunkIndex").length !== 1 ||
          !/^(0|[1-9][0-9]*)$/.test(chunkText ?? ""))) ||
        !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
        chunkIndex >= 2_147_483_647) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const owned = await prisma.amuxIdeaSubmission.findFirst({
      where: { id: ideaId, actorUserId: session.user!.id! },
      select: { id: true },
    });
    if (!owned) return NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore });
    const [chunks, units] = await Promise.all([
      prisma.amuxIdeaAnalysisChunk.findMany({ where: { ideaId,
        chunkIndex, freeformCiphertext: { not: null } },
        select: { currentPreviewId: true } }),
      prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId,
        chunkIndex, derivationGroupId: null,
        bodyCiphertext: { not: null } }, select: { id: true } }),
    ]);
    const identities: AmuxContentKeyIdentity[] = [];
    for (const chunk of chunks) {
      if (chunk.currentPreviewId) identities.push({ ideaId,
        purpose: "analysis_freeform",
        subjectId: amuxAnalysisFreeformSubjectId(ideaId,
          chunk.currentPreviewId) });
    }
    for (const unit of units) identities.push({ ideaId,
      purpose: "analysis_draft", subjectId: unit.id });
    const keys = await loadAmuxContentKeyRing(identities);
    const result = await readAmuxFirstIdeaAnalysisResult(session, ideaId, keys,
      chunkIndex);
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
