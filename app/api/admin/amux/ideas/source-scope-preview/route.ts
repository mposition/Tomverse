export const dynamic = "force-dynamic";

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
import { AmuxSourceScopePreviewError, previewAmuxSourceScope } from "@/lib/amux/ideaSourceScopePreviewService";
import { authOptions } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** Dark, declarative preview. No GitHub fetch, excerpt, transfer approval or model call. */
export async function POST(request: Request) {
  try {
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
        return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
      }
      throw error;
    }
    if (!sourceScopePreviewPermitted(process.env[AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV])) {
      return NextResponse.json({ error: "preview_disabled" }, { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused" }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-v4-source-scope-preview", {
      minute: 5,
      day: 50,
    });
    const inspected = inspectAmuxSourceScopePreviewRequest(
      await readLimitedText(request, AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES),
    );
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code }, {
        status: inspected.code === "too_large" ? 413 : 400, headers: noStore,
      });
    }
    return NextResponse.json(await previewAmuxSourceScope(session, inspected.request), { headers: noStore });
  } catch (error) {
    if (error instanceof AmuxSourceScopePreviewError) {
      return NextResponse.json({ error: error.code }, { status: error.status, headers: noStore });
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
    return NextResponse.json({ error: "preview_unavailable" }, { status: 503, headers: noStore });
  }
}
