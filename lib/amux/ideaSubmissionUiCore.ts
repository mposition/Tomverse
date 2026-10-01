type Reply = { status: number; body: unknown };

type PostDecision =
  | { kind: "submitted"; ideaId: string }
  | { kind: "refused"; code: string }
  | { kind: "verify" };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** These errors are returned before the submission transaction starts. Every
 * other error, malformed response or lost response needs read-back; a retry
 * with a fresh request id could create a duplicate idea. */
const PREWRITE_REFUSALS = new Set([
  "submission_disabled", "forbidden", "ADMIN_REAUTHENTICATION_REQUIRED",
  "content_type_refused", "rate_limited", "schema_rejected", "too_large",
  "content_refused", "metadata_incomplete", "audit_unavailable",
]);

export function classifyIdeaSubmissionPost(reply: Reply, requestId: string): PostDecision {
  const body = record(reply.body);
  if (reply.status === 201 && body?.state === "submitted" &&
      body.requestId === requestId && typeof body.ideaId === "string" && body.ideaId.length > 0) {
    return { kind: "submitted", ideaId: body.ideaId };
  }
  if (reply.status !== 201 && typeof body?.error === "string" &&
      PREWRITE_REFUSALS.has(body.error)) {
    return { kind: "refused", code: body.error };
  }
  return { kind: "verify" };
}

/** A negative read is not permission to retry: the first COMMIT can still be
 * in flight. Only a canonical submission plus its audit confirms success. */
export function classifyIdeaSubmissionReadBack(reply: Reply):
  { kind: "submitted"; ideaId: string } | { kind: "outcome_unknown" } {
  const body = record(reply.body);
  if (reply.status === 200 && body?.status === "committed" &&
      typeof body.ideaId === "string" && body.ideaId.length > 0) {
    return { kind: "submitted", ideaId: body.ideaId };
  }
  return { kind: "outcome_unknown" };
}
