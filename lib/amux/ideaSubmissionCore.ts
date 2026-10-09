import {
  inspectAmuxIdeaInput,
  type IdeaInput,
  type IdeaInputInspection,
} from "./ideaInputCore.ts";
import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";

export { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";

export const AMUX_IDEA_SUBMISSION_ENVELOPE_MAX_BYTES = 70_000;

const exactKeys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

export type IdeaSubmissionInspection =
  | { ok: true; requestId: string; input: IdeaInput; counts: Pick<Extract<IdeaInputInspection, { ok: true }>, "ideaBytes" | "repositoryCount" | "pullRequestCount"> }
  | { ok: false; code: "schema_rejected" | "too_large" | "content_refused" | "metadata_incomplete" };

/** The caller creates one high-entropy request nonce and keeps it for
 * read-back after an uncertain response. The idea id itself is server-issued. */
export function inspectAmuxIdeaSubmission(raw: string): IdeaSubmissionInspection {
  if (Buffer.byteLength(raw, "utf8") > AMUX_IDEA_SUBMISSION_ENVELOPE_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["version", "requestId", "input"]) || record.version !== 1 ||
      typeof record.requestId !== "string" || !isAmuxIdeaRequestId(record.requestId) ||
      !record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
    return { ok: false, code: "schema_rejected" };
  }
  const inspected = inspectAmuxIdeaInput(JSON.stringify(record.input));
  if (!inspected.ok) return inspected;
  return {
    ok: true,
    requestId: record.requestId,
    input: inspected.input,
    counts: {
      ideaBytes: inspected.ideaBytes,
      repositoryCount: inspected.repositoryCount,
      pullRequestCount: inspected.pullRequestCount,
    },
  };
}

/** v4 code is available; only its dedicated environment gate opens writes. */
export const AMUX_V4_IDEA_SUBMISSION_CODE_LATCH = true;
export const AMUX_V4_IDEA_SUBMISSION_ENV = "TOMVERSE_AMUX_V4_IDEA_SUBMIT";
export const ideaSubmissionWritePermitted = (value: string | undefined) =>
  AMUX_V4_IDEA_SUBMISSION_CODE_LATCH && value === "enabled";

/** Read-back has an independent gate so stopping new writes cannot hide an
 * uncertain in-flight submission. The environment gate remains independent. */
export const AMUX_V4_IDEA_READBACK_CODE_LATCH = true;
export const AMUX_V4_IDEA_READBACK_ENV = "TOMVERSE_AMUX_V4_IDEA_READBACK";
export const ideaSubmissionReadBackPermitted = (value: string | undefined) =>
  AMUX_V4_IDEA_READBACK_CODE_LATCH && value === "enabled";

/** Only the requestId unique index means "this request was already seen".
 * Other unique failures must not be relabeled as an idempotency hit. */
export function isIdeaRequestIdUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } };
  return candidate.code === "P2002" &&
    candidate.meta?.modelName === "AmuxIdeaSubmission" &&
    Array.isArray(candidate.meta.target) && candidate.meta.target.length === 1 &&
    candidate.meta.target[0] === "requestId";
}

/** Once a transaction callback returned, every COMMIT error is ambiguous,
 * regardless of driver code or message text. */
export function submissionFailureKind(callbackReturned: boolean, error: unknown):
  "outcome_unknown" | "request_already_seen" | "definitive_failure" {
  if (callbackReturned) return "outcome_unknown";
  if (isIdeaRequestIdUniqueViolation(error)) return "request_already_seen";
  // The adapter may omit P2002 metadata. Do not call a different unique
  // failure an idempotency hit, but do not invite a new request id either.
  if (error && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === "P2002") return "outcome_unknown";
  return "definitive_failure";
}
