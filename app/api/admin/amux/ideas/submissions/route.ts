export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import {
  AMUX_IDEA_SUBMISSION_ENVELOPE_MAX_BYTES,
  AMUX_V4_IDEA_READBACK_ENV,
  AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionReadBackPermitted,
  ideaSubmissionWritePermitted,
  inspectAmuxIdeaSubmission,
  isAmuxIdeaRequestId,
} from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError, readIdeaSubmissionRequest, submitIdea } from "@/lib/amux/ideaSubmissionService";
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
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
};

const failure = (error: unknown): Response => {
  if (error instanceof IdeaSubmissionError) {
    return NextResponse.json(
      { error: error.code, ...(error.readBack ? { readBack: error.readBack } : {}),
        ...(error.ideaId ? { ideaId: error.ideaId } : {}) },
      { status: error.status, headers: noStore },
    );
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
  console.error("AMUX v4 idea submission failed");
  return NextResponse.json({ error: "submission_failed" }, { status: 500, headers: noStore });
};

/** Dark v4 route. It cannot be enabled by the v1-v3 intake switches. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    // A write without its independent read-back gate could strand an
    // ambiguous COMMIT with no safe operator recovery path.
    if (!ideaSubmissionWritePermitted(process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) ||
        !ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV])) {
      return NextResponse.json({ error: "submission_disabled" }, { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused" }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-idea-submission", {
      minute: 3,
      day: 20,
    });
    const inspected = inspectAmuxIdeaSubmission(await readLimitedText(request, AMUX_IDEA_SUBMISSION_ENVELOPE_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json(
        { error: inspected.code },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore },
      );
    }
    const committed = await submitIdea({ session, request, inspected });
    return NextResponse.json(
      { ideaId: committed.ideaId, requestId: committed.requestId, state: "submitted",
        hasExternalSources: inspected.counts.repositoryCount + inspected.counts.pullRequestCount > 0,
        transferReady: false },
      { status: 201, headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}

/** A lost response is checked by request id. Absence never triggers retry. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!ideaSubmissionReadBackPermitted(process.env[AMUX_V4_IDEA_READBACK_ENV])) {
      return NextResponse.json({ error: "submission_disabled" }, { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-idea-readback", {
      minute: 10,
      day: 100,
    });
    const requestId = new URL(request.url).searchParams.get("requestId");
    if (!requestId || !isAmuxIdeaRequestId(requestId)) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    return NextResponse.json(
      await readIdeaSubmissionRequest(session, requestId),
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}
