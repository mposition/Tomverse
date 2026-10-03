export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_COLLECTION_PREVIEW_READ_ENV,
  collectionPreviewReadPermitted } from "@/lib/amux/ideaCollectionPreviewCore";
import { AmuxCollectionPreviewError, readAmuxCollectionPreview } from
  "@/lib/amux/ideaCollectionPreviewService";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";

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

/** Exact-ID owner display only. This endpoint does not approve a model transfer. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!collectionPreviewReadPermitted(process.env[AMUX_V4_COLLECTION_PREVIEW_READ_ENV])) {
      return NextResponse.json({ error: "preview_disabled",
        transferAuthorized: false }, { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-collection-preview-read",
      { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const requestId = params.get("requestId");
    if ([...params.keys()].length !== 1 || !requestId || !isAmuxIdeaRequestId(requestId)) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxCollectionPreview(session, requestId),
      { headers: noStore });
  } catch (error) {
    if (error instanceof AmuxCollectionPreviewError) {
      const status = error.code === "not_found" ? 404 :
        error.code === "not_ready" ? 409 : 503;
      return NextResponse.json({ error: error.code, transferAuthorized: false },
        { status, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    console.error("AMUX v4 collection preview unavailable");
    return NextResponse.json({ error: "preview_unavailable",
      transferAuthorized: false }, { status: 503, headers: noStore });
  }
}
