export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readOwnedAmuxIdeaAnalysisResult } from "@/lib/amux/ideaAnalysisResultOwnerRead";
import { AMUX_V4_ANALYSIS_RESULT_READ_ENV,
  amuxV4AnalysisResultReadEnabled } from "@/lib/amux/ideaAnalysisResultReadCore";
import { AmuxIdeaAnalysisResultReadError } from "@/lib/amux/ideaAnalysisResultReadService";
import { translateAmuxItemsToKorean } from "@/lib/amux/ideaAnalysisTranslation";
import { AMUX_ANALYSIS_TRANSLATION_ENV, amuxAnalysisTranslationEnabled,
  amuxAnalysisTranslationItems, amuxAnalysisTranslationViewKey,
  amuxAnalysisViewReadable } from "@/lib/amux/ideaAnalysisTranslationCore";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const MAX_BODY_BYTES = 512;

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

const body = z.object({
  ideaId: z.string().refine(isAmuxIdeaRequestId),
  chunkIndex: z.number().int().min(0).max(2_147_483_646),
}).strict();

/**
 * A Korean reading aid for one page of the owner's own analysis result. The
 * text is read and decrypted here, never taken from the request, and nothing
 * is stored: the proposal, its cards and worker prompts stay English.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
    }
    if (!amuxAnalysisTranslationEnabled(process.env[AMUX_ANALYSIS_TRANSLATION_ENV]) ||
        !amuxV4AnalysisResultReadEnabled(process.env[AMUX_V4_ANALYSIS_RESULT_READ_ENV])) {
      return NextResponse.json({ error: "analysis_translation_disabled" },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-analysis-translation", {
      minute: 6, day: 60,
    });
    const { ideaId, chunkIndex } = await readLimitedJson(request, MAX_BODY_BYTES, body);
    const view = await readOwnedAmuxIdeaAnalysisResult(session, ideaId, chunkIndex);
    if (!view) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    if (!amuxAnalysisViewReadable(view)) {
      return NextResponse.json({ error: "nothing_to_translate" }, { status: 409, headers: noStore });
    }
    const items = amuxAnalysisTranslationItems(view);
    const outcome = await translateAmuxItemsToKorean(items);
    // A translation can spend on the provider, so each request is in the chain.
    // Ids and counts only: no source or translated text.
    await writeAdminAuditLog({
      session, request,
      action: "amux.idea.analysis_translation",
      targetType: "AmuxIdeaSubmission",
      targetId: ideaId,
      summary: "Requested a Korean reading translation of an AMUX analysis page.",
      metadata: { chunkIndex, itemCount: items.length, outcome: outcome.state,
        cached: outcome.state === "translated" && outcome.cached },
    });
    if (outcome.state === "translated") {
      return NextResponse.json({ viewKey: amuxAnalysisTranslationViewKey(view),
        translations: outcome.translations, cached: outcome.cached }, { headers: noStore });
    }
    const status = outcome.state === "too_large" ? 413 : outcome.state === "empty" ? 409 : 503;
    return NextResponse.json({ error: outcome.state === "empty" ? "nothing_to_translate" :
      outcome.state === "too_large" ? "too_large" : outcome.state === "disabled" ?
        "analysis_translation_disabled" : "translation_unavailable" }, { status, headers: noStore });
  } catch (error) {
    if (error instanceof AmuxIdeaAnalysisResultReadError) {
      return NextResponse.json({ error: error.code },
        { status: error.code === "not_found" ? 404 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    console.error("AMUX analysis translation unavailable");
    return NextResponse.json({ error: "translation_unavailable" },
      { status: 503, headers: noStore });
  }
}
