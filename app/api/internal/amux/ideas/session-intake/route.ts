export const dynamic = "force-dynamic";

import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import {
  AMUX_SESSION_INTAKE_ENV,
  amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSubmission,
} from "@/lib/amux/ideaSessionSubmissionCore";
import {
  AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV,
  AMUX_SESSION_INTAKE_READBACK_ENV,
  amuxSessionIntakeConflictingSecretValues,
  amuxSessionIntakeReadbackEnabled,
  amuxSessionIntakeReadbackReply,
  amuxSessionIntakeReadbackRequestId,
  isAmuxSessionIntakeClientAuthorized,
} from "@/lib/amux/ideaSessionIntakeReadbackCore";
import {
  AmuxIdeaSessionSubmissionError,
  readAmuxIdeaSessionSubmissionRequest,
  submitAmuxIdeaFromSession,
} from "@/lib/amux/ideaSessionSubmissionService";
import {
  AMUX_V4_IDEA_READBACK_ENV,
  AMUX_V4_IDEA_SUBMISSION_ENV,
} from "@/lib/amux/ideaSubmissionCore";

const authorized = (request: Request): boolean =>
  isAmuxSessionIntakeClientAuthorized(
    request,
    process.env[AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV],
    amuxSessionIntakeConflictingSecretValues(process.env),
  );

const readbackPath = (requestId: string) =>
  ["/api/internal/amux/ideas/session-intake",
    new URLSearchParams({ requestId }).toString()].join("?");

const SUBMISSION_ERROR_STATUS: Record<
  AmuxIdeaSessionSubmissionError["code"],
  409 | 503
> = {
  submission_disabled: 503,
  audit_unavailable: 503,
  scope_unavailable: 409,
  outside_scope: 409,
  model_not_approved: 409,
  reference_snapshot_unavailable: 503,
  key_store_unavailable: 503,
  request_already_seen: 409,
  outcome_unknown: 503,
};

const submissionFailure = (
  error: unknown,
  requestId?: string,
): Response => {
  if (error instanceof AmuxIdeaSessionSubmissionError) {
    const hasReadback = error.code === "request_already_seen" ||
      error.code === "outcome_unknown";
    return amuxJsonNoStore({
      error: error.code,
      retryWrite: false,
      ...(requestId ? { requestId, readbackPath: readbackPath(requestId) } : {}),
      ...(hasReadback && error.readBack ? { readBack: error.readBack } : {}),
      ...(hasReadback && error.ideaId ? { ideaId: error.ideaId } : {}),
    }, SUBMISSION_ERROR_STATUS[error.code]);
  }
  return amuxJsonNoStore({
    error: "session_intake_submission_failed",
    retryWrite: false,
    ...(requestId ? { requestId, readbackPath: readbackPath(requestId) } : {}),
  }, 500);
};

/** Dedicated-credential session intake. The service repeats the current scope
 * and model checks after taking the audit-chain lock and commits no partial
 * intake. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  // A write is never opened without the exact-ID recovery path needed after
  // an interrupted response.
  if (!amuxSessionIntakeWritePermitted(
    process.env[AMUX_SESSION_INTAKE_ENV],
    process.env[AMUX_V4_IDEA_SUBMISSION_ENV],
  ) || !amuxSessionIntakeReadbackEnabled(
    process.env[AMUX_SESSION_INTAKE_READBACK_ENV],
    process.env[AMUX_V4_IDEA_READBACK_ENV],
  )) {
    return amuxJsonNoStore({ error: "submission_disabled", retryWrite: false }, 503);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "content_type_refused", retryWrite: false }, 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return amuxJsonNoStore({ error: "schema_rejected", retryWrite: false }, 400);
  }
  const inspected = inspectAmuxIdeaSessionSubmission(body);
  if (!inspected.ok) {
    return amuxJsonNoStore({ error: inspected.code, retryWrite: false }, 400);
  }
  try {
    const committed = await submitAmuxIdeaFromSession({ inspected });
    return amuxJsonNoStore(amuxSessionIntakeReadbackReply(
      inspected.requestId,
      {
        status: "committed",
        requestId: committed.requestId,
        ideaId: committed.ideaId,
        reservationId: committed.reservationId,
        hasExternalSources:
          inspected.counts.repositoryCount + inspected.counts.pullRequestCount > 0,
      },
    ).body, 201);
  } catch (error) {
    return submissionFailure(error, inspected.requestId);
  }
}

/** Exact-ID, metadata-only recovery after an uncertain session intake reply. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);

  if (!amuxSessionIntakeReadbackEnabled(
    process.env[AMUX_SESSION_INTAKE_READBACK_ENV],
    process.env[AMUX_V4_IDEA_READBACK_ENV],
  )) {
    return amuxJsonNoStore({ available: false,
      reason: "session_intake_readback_disabled" }, 409);
  }

  const requestId = amuxSessionIntakeReadbackRequestId(request);
  if (!requestId) return amuxJsonNoStore({ error: "Invalid request." }, 400);

  try {
    const reply = amuxSessionIntakeReadbackReply(
      requestId,
      await readAmuxIdeaSessionSubmissionRequest(requestId),
    );
    return amuxJsonNoStore(reply.body, reply.status);
  } catch {
    return amuxJsonNoStore({ error: "session_intake_readback_unavailable",
      retryWrite: false }, 503);
  }
}
