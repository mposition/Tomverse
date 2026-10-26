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
import {
  AMUX_SESSION_INTAKE_READBACK_ENV,
  amuxSessionIntakeReadbackEnabled,
} from "@/lib/amux/ideaSessionIntakeReadbackCore";
import {
  AMUX_SESSION_INTAKE_ENV,
  amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSubmission,
  inspectAmuxSessionModelChoice,
} from "@/lib/amux/ideaSessionSubmissionCore";
import {
  AmuxIdeaSessionSubmissionError,
  readAmuxIdeaSessionSubmissionRequest,
  submitAmuxIdeaFromSession,
} from "@/lib/amux/ideaSessionSubmissionService";
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

/** amux-intake v19 item 1: the Admin idea input and coding sessions enter the
 * same intake writer. While session intake is on, an Admin idea is stored as
 * a session idea under the owner's operating scope and queued for automatic
 * analysis; otherwise the v4 path below is unchanged. */
const sessionIntakeOn = () =>
  amuxSessionIntakeWritePermitted(process.env[AMUX_SESSION_INTAKE_ENV],
    process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) &&
  amuxSessionIntakeReadbackEnabled(process.env[AMUX_SESSION_INTAKE_READBACK_ENV],
    process.env[AMUX_V4_IDEA_READBACK_ENV]);

const ADMIN_SOURCE = Object.freeze({ toolName: "tomverse-admin",
  modelProvider: "operator", sessionDisplay: "Admin idea input" });

/** Refused before the intake transaction starts, so nothing was written. */
const SESSION_PREWRITE_STATUS: Partial<Record<AmuxIdeaSessionSubmissionError["code"], number>> = {
  submission_disabled: 503,
  audit_unavailable: 503,
  scope_unavailable: 409,
  outside_scope: 409,
  model_not_approved: 409,
  model_not_launchable: 409,
  reference_snapshot_unavailable: 503,
  // key_store_unavailable stays a read-back: the shared UI table treats it so
  // on the v4 path, where a key outcome can be uncertain.
};

const failure = (error: unknown): Response => {
  if (error instanceof AmuxIdeaSessionSubmissionError) {
    const status = SESSION_PREWRITE_STATUS[error.code];
    // An uncertain or already-seen write is read back by its request id.
    return NextResponse.json(status ? { error: error.code }
      : { error: "outcome_unknown", ...(error.readBack ? { readBack: error.readBack } : {}) },
    { status: status ?? 503, headers: noStore });
  }
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
    const raw = await readLimitedText(request, AMUX_IDEA_SUBMISSION_ENVELOPE_MAX_BYTES);
    if (sessionIntakeOn()) {
      let envelope: unknown;
      try { envelope = JSON.parse(raw); } catch { envelope = null; }
      const body = envelope && typeof envelope === "object" && !Array.isArray(envelope)
        ? envelope as Record<string, unknown> : {};
      const inspected = inspectAmuxIdeaSessionSubmission({ version: body.version,
        requestId: body.requestId, input: body.input, source: ADMIN_SOURCE });
      if (!inspected.ok) {
        return NextResponse.json({ error: inspected.code }, { status: 400, headers: noStore });
      }
      // The owner may pick this idea's model; without one the scope's model runs.
      const choice = inspectAmuxSessionModelChoice(body.model);
      if (!choice.ok) {
        return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
      }
      // The session analysis reads its references from pinned checkouts; an
      // idea with none would be claimed and then have nothing to read.
      if (inspected.counts.repositoryCount + inspected.counts.pullRequestCount === 0) {
        return NextResponse.json({ error: "references_required" }, { status: 400, headers: noStore });
      }
      const committed = await submitAmuxIdeaFromSession({ inspected, model: choice.model });
      return NextResponse.json(
        { ideaId: committed.ideaId, requestId: committed.requestId, state: "submitted",
          origin: "session",
          hasExternalSources: inspected.counts.repositoryCount + inspected.counts.pullRequestCount > 0,
          transferReady: false },
        { status: 201, headers: noStore },
      );
    }
    const inspected = inspectAmuxIdeaSubmission(raw);
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
    // A session idea saved from Admin has the operator as its actor, so the v4 owner
    // read finds the row and, with no v4-shaped audit, calls it partial. The session
    // read answers first (it is absent for any row that is not a session idea).
    if (sessionIntakeOn()) {
      const seen = await readAmuxIdeaSessionSubmissionRequest(requestId);
      if (seen.status !== "absent") {
        return NextResponse.json(seen.status === "committed"
          ? { requestId, status: "committed", ideaId: seen.ideaId, origin: "session",
            hasExternalSources: seen.hasExternalSources }
          : { requestId, status: "partial", ideaId: seen.ideaId, origin: "session" },
        { headers: noStore });
      }
    }
    const owned = await readIdeaSubmissionRequest(session, requestId);
    return NextResponse.json(owned, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
