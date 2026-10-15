export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaAnalysisReservationError } from "@/lib/amux/ideaAnalysisBudgetReservationService";
import { IdeaExecutionApprovalError, approveIdeaExecution,
  ideaExecutionApprovalPermitted } from "@/lib/amux/ideaExecutionApprovalService";
import { readIdeaTransferBrowserNonce } from "@/lib/amux/ideaTransferBrowserCore";
import { inspectIdeaTransferConfirmationRequest } from "@/lib/amux/ideaTransferConfirmationCore";
import { IdeaTransferConfirmationError } from "@/lib/amux/ideaTransferConfirmationService";

// amux-intake.md v18 item 1: the owner's execution approval confirms the exact
// transfer preview and reserves its analysis budget in one transaction. Both
// existing routes stay; read-back after an unknown outcome uses their exact-ID
// GETs (transfer-confirmation ?previewId, analysis-reservations ?holdId).

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const bodySchema = z.object({
  version: z.literal(1),
  previewId: z.string(), ideaId: z.string(),
  payloadDigest: z.string(), payloadDigestKeyId: z.string(),
  holdId: id, priceVersionId: id,
}).strict();

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

function failure(error: unknown): Response {
  if (error instanceof IdeaExecutionApprovalError) {
    const status = error.code === "not_found" ? 404 :
      error.code === "price_profile_unapproved" ? 409 : 503;
    return NextResponse.json({ error: error.code, retryWrite: false, modelCallStarted: false },
      { status, headers: noStore });
  }
  if (error instanceof IdeaTransferConfirmationError) {
    const status = error.code === "not_found" ? 404 :
      ["not_ready", "expired", "digest_changed", "browser_mismatch"].includes(error.code) ? 409 : 503;
    return NextResponse.json({ error: error.code, retryWrite: false, modelCallStarted: false },
      { status, headers: noStore });
  }
  if (error instanceof AmuxIdeaAnalysisReservationError) {
    return NextResponse.json({ error: error.code, reason: error.reason, retryWrite: false,
      modelCallStarted: false }, { status: error.code === "integrity_unavailable" ? 503 : 409,
      headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 execution approval unavailable");
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false, modelCallStarted: false },
    { status: 503, headers: noStore });
}

export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!ideaExecutionApprovalPermitted(process.env)) {
      return NextResponse.json({ error: "disabled", modelCallStarted: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", modelCallStarted: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-execution-approval-write",
      { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 1_024, bodySchema);
    // The confirmation half is checked exactly as its own route checks it.
    const inspected = inspectIdeaTransferConfirmationRequest(JSON.stringify({
      version: 1, previewId: body.previewId, ideaId: body.ideaId,
      payloadDigest: body.payloadDigest, payloadDigestKeyId: body.payloadDigestKeyId,
    }));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code, modelCallStarted: false },
        { status: 400, headers: noStore });
    }
    const browserNonce = readIdeaTransferBrowserNonce(
      request.headers.get("cookie"), inspected.request.previewId);
    if (!browserNonce) {
      return NextResponse.json({ error: "browser_mismatch", modelCallStarted: false },
        { status: 409, headers: noStore });
    }
    const result = await approveIdeaExecution(session, request,
      { confirmation: inspected.request, holdId: body.holdId, priceVersionId: body.priceVersionId },
      browserNonce);
    return NextResponse.json({ state: "approved", ...result, modelCallStarted: false },
      { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
