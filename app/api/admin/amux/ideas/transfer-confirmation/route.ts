export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import { readIdeaTransferBrowserNonce } from "@/lib/amux/ideaTransferBrowserCore";
import {
  AMUX_V4_TRANSFER_CONFIRM_MAX_BYTES,
  AMUX_V4_TRANSFER_CONFIRM_READ_ENV,
  AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV,
  inspectIdeaTransferConfirmationRequest,
  transferConfirmReadPermitted,
  transferConfirmWritePermitted,
} from "@/lib/amux/ideaTransferConfirmationCore";
import {
  IdeaTransferConfirmationError,
  confirmIdeaTransferPreview,
  readIdeaTransferConfirmation,
} from "@/lib/amux/ideaTransferConfirmationService";

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

function failure(error: unknown): Response {
  if (error instanceof IdeaTransferConfirmationError) {
    const status = error.code === "not_found" ? 404 :
      error.code === "not_ready" || error.code === "expired" ||
      error.code === "digest_changed" || error.code === "browser_mismatch" ? 409 : 503;
    return NextResponse.json({ error: error.code, modelCallStarted: false },
      { status, headers: noStore });
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) { approval.headers.set("Cache-Control", noStore["Cache-Control"]); return approval; }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 transfer confirmation unavailable");
  return NextResponse.json({ error: "confirmation_unavailable", modelCallStarted: false },
    { status: 503, headers: noStore });
}

/** A dark human confirmation writer. It records a decision but cannot call a model. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!transferConfirmWritePermitted(process.env[AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV]) ||
        !transferConfirmReadPermitted(process.env[AMUX_V4_TRANSFER_CONFIRM_READ_ENV])) {
      return NextResponse.json({ error: "confirmation_disabled", modelCallStarted: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", modelCallStarted: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-transfer-confirm-write",
      { minute: 3, day: 20 });
    const inspected = inspectIdeaTransferConfirmationRequest(
      await readLimitedText(request, AMUX_V4_TRANSFER_CONFIRM_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code, modelCallStarted: false },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    const browserNonce = readIdeaTransferBrowserNonce(
      request.headers.get("cookie"), inspected.request.previewId);
    if (!browserNonce) {
      return NextResponse.json({ error: "browser_mismatch", modelCallStarted: false },
        { status: 409, headers: noStore });
    }
    try {
      const result = await confirmIdeaTransferPreview(session, request,
        inspected.request, browserNonce);
      return NextResponse.json({ state: "confirmed", ...result, modelCallStarted: false },
        { status: 201, headers: noStore });
    } catch (error) {
      if (error instanceof IdeaTransferConfirmationError && error.code === "outcome_unknown") {
        return NextResponse.json({ error: "outcome_unknown",
          previewId: inspected.request.previewId, retryWrite: false,
          modelCallStarted: false }, { status: 503, headers: noStore });
      }
      throw error;
    }
  } catch (error) { return failure(error); }
}

/** Exact-ID read-back after an ambiguous commit; absence never invites a retry. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!transferConfirmReadPermitted(process.env[AMUX_V4_TRANSFER_CONFIRM_READ_ENV])) {
      return NextResponse.json({ error: "confirmation_disabled", modelCallStarted: false },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-transfer-confirm-read",
      { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const previewId = params.get("previewId");
    if ([...params.keys()].length !== 1 || !previewId || !isAmuxIdeaRequestId(previewId)) {
      return NextResponse.json({ error: "schema_rejected", modelCallStarted: false },
        { status: 400, headers: noStore });
    }
    return NextResponse.json(await readIdeaTransferConfirmation(session, previewId),
      { headers: noStore });
  } catch (error) { return failure(error); }
}
