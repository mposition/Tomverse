export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import {
  AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES,
  AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV,
  inspectAmuxSourceScopePreviewRequest,
  sourceScopePreviewPermitted,
} from "@/lib/amux/ideaSourceScopePreviewCore";
import {
  AmuxSourceScopePreviewError,
  previewAmuxSourceScope,
} from "@/lib/amux/ideaSourceScopePreviewService";
import { authOptions } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

const owner = async (): Promise<Session | NextResponse> => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
};

const failure = (error: unknown): Response => {
  if (error instanceof AmuxSourceScopePreviewError) {
    return NextResponse.json({ error: error.code, transferAuthorized: false },
      { status: error.status, headers: noStore });
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) {
    approval.headers.set("Cache-Control", noStore["Cache-Control"]);
    return approval;
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  console.error("AMUX v4 source scope preview failed");
  return NextResponse.json({ error: "preview_unavailable", transferAuthorized: false },
    { status: 503, headers: noStore });
};

/** A declarative owner-only read. It never collects GitHub bytes, creates a
 * source approval or authorizes a model transfer. The code switch stays off
 * until the separate collection/preview and S0 gates are approved. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!sourceScopePreviewPermitted(process.env[AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV])) {
      return NextResponse.json({ error: "preview_disabled", transferAuthorized: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", transferAuthorized: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-source-scope-preview", {
      minute: 5, day: 40,
    });
    const inspected = inspectAmuxSourceScopePreviewRequest(
      await readLimitedText(request, AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code, transferAuthorized: false },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    const preview = await previewAmuxSourceScope(session, inspected.request);
    return NextResponse.json(preview, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
