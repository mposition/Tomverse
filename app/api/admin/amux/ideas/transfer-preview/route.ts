export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  frontierCatalogReadPermitted,
} from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import {
  ideaTransferBrowserCookieName,
  newIdeaTransferBrowserNonce,
} from "@/lib/amux/ideaTransferBrowserCore";
import {
  AMUX_V4_TRANSFER_PREVIEW_MAX_BYTES,
  AMUX_V4_TRANSFER_PREVIEW_READ_ENV,
  AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV,
  inspectIdeaOnlyTransferPreviewRequest,
  transferPreviewReadPermitted,
  transferPreviewWritePermitted,
} from "@/lib/amux/ideaTransferPreviewInputCore";
import {
  IdeaTransferPreviewError,
  prepareIdeaOnlyTransferPreview,
  readIdeaOnlyTransferPreview,
} from "@/lib/amux/ideaTransferPreviewService";

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
  if (error instanceof IdeaTransferPreviewError) {
    const status = error.code === "not_found" ? 404 :
      error.code === "not_ready" || error.code === "model_changed" ? 409 : 503;
    return NextResponse.json({ error: error.code, transferAuthorized: false },
      { status, headers: noStore });
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) { approval.headers.set("Cache-Control", noStore["Cache-Control"]); return approval; }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 transfer preview unavailable");
  return NextResponse.json({ error: "preview_unavailable", transferAuthorized: false },
    { status: 503, headers: noStore });
}

/** Dark idea-only writer. It neither calls a model nor authorizes a transfer. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!transferPreviewWritePermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV]) ||
        !transferPreviewReadPermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_READ_ENV]) ||
        !frontierCatalogReadPermitted(process.env[AMUX_V4_FRONTIER_CATALOG_READ_ENV])) {
      return NextResponse.json({ error: "preview_disabled", transferAuthorized: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", transferAuthorized: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-transfer-preview-write", {
      minute: 3, day: 20,
    });
    const inspected = inspectIdeaOnlyTransferPreviewRequest(
      await readLimitedText(request, AMUX_V4_TRANSFER_PREVIEW_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code, transferAuthorized: false },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    const browserNonce = newIdeaTransferBrowserNonce();
    const attachBrowserCookie = (response: NextResponse) => {
      response.cookies.set(ideaTransferBrowserCookieName(inspected.request.previewId),
        browserNonce, { httpOnly: true, secure: true, sameSite: "strict",
          path: "/api/admin/amux/ideas", maxAge: 15 * 60 });
      return response;
    };
    try {
      const result = await prepareIdeaOnlyTransferPreview(session, request, inspected.request,
        browserNonce);
      return attachBrowserCookie(NextResponse.json(
        { state: "prepared", ...result, transferAuthorized: false },
        { status: 201, headers: noStore }));
    } catch (error) {
      if (error instanceof IdeaTransferPreviewError && error.code === "outcome_unknown") {
        return attachBrowserCookie(NextResponse.json({ error: "outcome_unknown",
          previewId: inspected.request.previewId, retryWrite: false,
          transferAuthorized: false }, { status: 503, headers: noStore }));
      }
      throw error;
    }
  } catch (error) { return failure(error); }
}

/** Exact-ID read-back after an unknown POST result; absence never means retry. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!transferPreviewReadPermitted(process.env[AMUX_V4_TRANSFER_PREVIEW_READ_ENV])) {
      return NextResponse.json({ error: "preview_disabled", transferAuthorized: false },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-transfer-preview-read", {
      minute: 10, day: 100,
    });
    const params = new URL(request.url).searchParams;
    const previewId = params.get("previewId");
    if ([...params.keys()].length !== 1 || !previewId || !isAmuxIdeaRequestId(previewId)) {
      return NextResponse.json({ error: "schema_rejected", transferAuthorized: false },
        { status: 400, headers: noStore });
    }
    return NextResponse.json(await readIdeaOnlyTransferPreview(session, previewId),
      { headers: noStore });
  } catch (error) { return failure(error); }
}
