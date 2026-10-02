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
import { AMUX_V4_SOURCE_SCOPE_APPROVAL_MAX_BYTES,
  AMUX_V4_SOURCE_SCOPE_APPROVAL_READ_ENV,
  AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE_ENV,
  inspectAmuxSourceScopeApprovalRequest,
  sourceScopeApprovalReadPermitted,
  sourceScopeApprovalWritePermitted } from "@/lib/amux/ideaSourceScopeApprovalCore";
import { AmuxSourceScopeApprovalError, approveAmuxSourceScope,
  readAmuxSourceScopeApproval } from "@/lib/amux/ideaSourceScopeApprovalService";

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
  if (error instanceof AmuxSourceScopeApprovalError) {
    const status = error.code === "not_found" ? 404 :
      error.code === "not_ready" || error.code === "preview_changed" ||
      error.code === "approval_exists" ? 409 : 503;
    return NextResponse.json({ error: error.code, collectionVerified: false,
      transferAuthorized: false }, { status, headers: noStore });
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) { approval.headers.set("Cache-Control", noStore["Cache-Control"]); return approval; }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 source scope approval unavailable");
  return NextResponse.json({ error: "approval_unavailable", collectionVerified: false,
    transferAuthorized: false }, { status: 503, headers: noStore });
}

/** Human collection-scope decision only; GitHub files are not fetched. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!sourceScopeApprovalWritePermitted(process.env[AMUX_V4_SOURCE_SCOPE_APPROVAL_WRITE_ENV]) ||
        !sourceScopeApprovalReadPermitted(process.env[AMUX_V4_SOURCE_SCOPE_APPROVAL_READ_ENV])) {
      return NextResponse.json({ error: "approval_disabled", collectionVerified: false,
        transferAuthorized: false }, { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", collectionVerified: false,
        transferAuthorized: false }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-source-scope-approval-write",
      { minute: 3, day: 20 });
    const inspected = inspectAmuxSourceScopeApprovalRequest(
      await readLimitedText(request, AMUX_V4_SOURCE_SCOPE_APPROVAL_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code, collectionVerified: false,
        transferAuthorized: false },
      { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    try {
      const result = await approveAmuxSourceScope(session, request, inspected.request);
      return NextResponse.json({ state: "approved", ...result,
        collectionVerified: false, transferAuthorized: false },
      { status: 201, headers: noStore });
    } catch (error) {
      if (error instanceof AmuxSourceScopeApprovalError && error.code === "outcome_unknown") {
        return NextResponse.json({ error: "outcome_unknown", retryWrite: false,
          approvalId: inspected.request.approvalId, collectionVerified: false,
          transferAuthorized: false }, { status: 503, headers: noStore });
      }
      throw error;
    }
  } catch (error) { return failure(error); }
}

/** Exact-ID read-back after an ambiguous write; absence is not retry permission. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!sourceScopeApprovalReadPermitted(process.env[AMUX_V4_SOURCE_SCOPE_APPROVAL_READ_ENV])) {
      return NextResponse.json({ error: "approval_disabled", collectionVerified: false,
        transferAuthorized: false }, { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-source-scope-approval-read",
      { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const approvalId = params.get("approvalId");
    if ([...params.keys()].length !== 1 || !approvalId || !isAmuxIdeaRequestId(approvalId)) {
      return NextResponse.json({ error: "schema_rejected", collectionVerified: false,
        transferAuthorized: false }, { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxSourceScopeApproval(session, approvalId),
      { headers: noStore });
  } catch (error) { return failure(error); }
}
