export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_COLLECTION_REQUEST_MAX_BYTES,
  inspectAmuxIdeaCollectionRequestInput } from "@/lib/amux/ideaCollectionRequestInputCore";
import { AMUX_V4_COLLECTION_REQUEST_READ_ENV,
  AMUX_V4_COLLECTION_REQUEST_WRITE_ENV, AmuxCollectionRequestError,
  collectionRequestReadPermitted, collectionRequestWritePermitted,
  createAmuxIdeaCollectionRequest, readAmuxIdeaCollectionRequest,
} from "@/lib/amux/ideaCollectionRequestService";
import { isAmuxIdeaRequestId } from "@/lib/amux/ideaSubmissionCore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

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
  if (error instanceof AmuxCollectionRequestError) {
    const status = error.code === "not_found" ? 404 :
      error.code === "not_ready" || error.code === "request_exists" ? 409 : 503;
    return NextResponse.json({ error: error.code,
      collectionVerified: false, transferAuthorized: false },
    { status, headers: noStore });
  }
  const approval = adminApprovalErrorResponse(error);
  if (approval) { approval.headers.set("Cache-Control", noStore["Cache-Control"]); return approval; }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 collection request unavailable");
  return NextResponse.json({ error: "collection_unavailable",
    collectionVerified: false, transferAuthorized: false },
  { status: 503, headers: noStore });
}

/** A dark request row only. No GitHub source or model is contacted here. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!collectionRequestWritePermitted(process.env[AMUX_V4_COLLECTION_REQUEST_WRITE_ENV]) ||
        !collectionRequestReadPermitted(process.env[AMUX_V4_COLLECTION_REQUEST_READ_ENV])) {
      return NextResponse.json({ error: "collection_disabled",
        collectionVerified: false, transferAuthorized: false },
      { status: 503, headers: noStore });
    }
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "origin_refused" }, { status: 403, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused" }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-collection-request-write",
      { minute: 3, day: 20 });
    const inspected = inspectAmuxIdeaCollectionRequestInput(
      await readLimitedText(request, AMUX_V4_COLLECTION_REQUEST_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    try {
      const result = await createAmuxIdeaCollectionRequest({ session, request,
        choice: inspected.request });
      return NextResponse.json({ ...result, collectionVerified: false,
        transferAuthorized: false }, { status: 201, headers: noStore });
    } catch (error) {
      if (error instanceof AmuxCollectionRequestError && error.code === "outcome_unknown") {
        return NextResponse.json({ error: "outcome_unknown", retryWrite: false,
          requestId: inspected.request.requestId, readBack: error.readBack ?? "unavailable",
          collectionVerified: false, transferAuthorized: false },
        { status: 503, headers: noStore });
      }
      throw error;
    }
  } catch (error) { return failure(error); }
}

/** Exact-ID readback after ambiguity. Even absent is not a retry instruction. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!collectionRequestReadPermitted(process.env[AMUX_V4_COLLECTION_REQUEST_READ_ENV])) {
      return NextResponse.json({ error: "collection_disabled" }, { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-collection-request-read",
      { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const requestId = params.get("requestId");
    if ([...params.keys()].length !== 1 || !requestId || !isAmuxIdeaRequestId(requestId)) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxIdeaCollectionRequest(session, requestId),
      { headers: noStore });
  } catch (error) { return failure(error); }
}
