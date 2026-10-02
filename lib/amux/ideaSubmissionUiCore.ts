type Reply = { status: number; body: unknown };

type PostDecision =
  | { kind: "submitted"; ideaId: string; hasExternalSources: boolean }
  | { kind: "refused"; code: string }
  | { kind: "verify" };

/** A new request ID is safe only after the previous write is definitively
 * confirmed. Unknown outcomes must be read back, never silently reset. */
export function canStartAnotherIdea(
  state: "idle" | "pending" | "submitted" | "outcome_unknown" | "recovery_unavailable" | "refused",
  busy: boolean,
): boolean {
  return state === "submitted" && !busy;
}

export function canSelectRecentIdea(
  state: "idle" | "pending" | "submitted" | "outcome_unknown" | "recovery_unavailable" | "refused",
  busy: boolean,
): boolean {
  return !busy && (state === "idle" || state === "submitted" || state === "refused");
}

export type RecentIdea = { ideaId: string; requestId: string;
  submittedAt: string; analysisDeadlineAt: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function classifyRecentIdeaList(reply: Reply): RecentIdea[] | null {
  const body = record(reply.body);
  if (reply.status !== 200 || body?.status !== "recent" ||
      !Array.isArray(body.items) || body.items.length > 20) return null;
  const seen = new Set<string>();
  const items: RecentIdea[] = [];
  for (const value of body.items) {
    const item = record(value);
    if (!item || typeof item.ideaId !== "string" || !UUID.test(item.ideaId) ||
        typeof item.requestId !== "string" || !UUID.test(item.requestId) ||
        !validIsoDate(item.submittedAt) || !validIsoDate(item.analysisDeadlineAt) ||
        seen.has(item.requestId)) return null;
    seen.add(item.requestId);
    items.push({ ideaId: item.ideaId, requestId: item.requestId,
      submittedAt: item.submittedAt, analysisDeadlineAt: item.analysisDeadlineAt });
  }
  return items;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** These errors are returned before the submission transaction starts. Every
 * other error, malformed response or lost response needs read-back; a retry
 * with a fresh request id could create a duplicate idea. */
const PREWRITE_REFUSALS: Record<string, number> = {
  submission_disabled: 503,
  forbidden: 403,
  ADMIN_REAUTHENTICATION_REQUIRED: 428,
  content_type_refused: 415,
  rate_limited: 429,
  schema_rejected: 400,
  too_large: 413,
  content_refused: 400,
  metadata_incomplete: 400,
  audit_unavailable: 503,
};

export function classifyIdeaSubmissionPost(reply: Reply, requestId: string): PostDecision {
  const body = record(reply.body);
  if (reply.status === 201 && body?.state === "submitted" &&
      body.requestId === requestId && typeof body.ideaId === "string" && body.ideaId.length > 0 &&
      typeof body.hasExternalSources === "boolean" && body.transferReady === false) {
    return { kind: "submitted", ideaId: body.ideaId, hasExternalSources: body.hasExternalSources };
  }
  if (typeof body?.error === "string" && PREWRITE_REFUSALS[body.error] === reply.status) {
    return { kind: "refused", code: body.error };
  }
  return { kind: "verify" };
}

/** A negative read is not permission to retry: the first COMMIT can still be
 * in flight. Only a canonical submission plus its audit confirms success. */
export function classifyIdeaSubmissionReadBack(reply: Reply, requestId: string):
  { kind: "submitted"; ideaId: string; hasExternalSources: boolean } | { kind: "outcome_unknown" } {
  const body = record(reply.body);
  if (reply.status === 200 && body?.status === "committed" && body.requestId === requestId &&
      typeof body.ideaId === "string" && body.ideaId.length > 0 &&
      typeof body.hasExternalSources === "boolean") {
    return { kind: "submitted", ideaId: body.ideaId, hasExternalSources: body.hasExternalSources };
  }
  return { kind: "outcome_unknown" };
}
