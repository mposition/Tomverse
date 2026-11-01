import {
  AMUX_ANALYSIS_SCHEMA_FIELDS, AMUX_ANALYSIS_SCHEMA_RULES, amuxAnalysisTextSafe, type AmuxAnalysisSchemaRejectAt,
} from "./ideaAnalysisChunkCore.ts";

/**
 * Why a session analysis answer became no plan, read back for the owner from
 * the answer the app keeps for seven days after intake (v19 retention; owner
 * decision 2026-10-23). The plan writer records no reason, so this reads the
 * answer itself: an owner question is shown as the model wrote it, anything
 * else is the closed "not a plan" word. Nothing here changes what the writer
 * decided.
 */
/** Where a not-a-plan answer of a first page failed the plan writer's own
 * inspection: a closed, content-free code read again from the kept answer.
 * A later page carries none, since its inspection depends on stored history. */
export const AMUX_SESSION_REVIEW_DETAILS = [
  "chunk_schema_rejected", "chunk_too_large", "chunk_content_refused",
  "chunk_source_ref_unapproved", "chunk_target_ref_unapproved",
  "chunk_metadata_incomplete", "history_invalid", "history_closed",
  "cursor_metadata_incomplete", "cursor_history_invalid",
  "cursor_chunk_index_mismatch", "cursor_output_part_mismatch",
  "cursor_output_cursor_mismatch", "cursor_remaining_mismatch",
  "cursor_owner_input_required", "cursor_source_invalid",
  "owner_question_unreadable", "draft_refused",
] as const;
export type AmuxSessionReviewDetail = (typeof AMUX_SESSION_REVIEW_DETAILS)[number];

export type AmuxSessionReview =
  | { reason: "owner_question"; question: string }
  | { reason: "not_a_plan"; detail?: AmuxSessionReviewDetail; at?: AmuxAnalysisSchemaRejectAt };

const QUESTION_MAX = 2_000;

export function classifyAmuxSessionReviewAnswer(raw: string): AmuxSessionReview {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { reason: "not_a_plan" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "not_a_plan" };
  }
  const answer = parsed as Record<string, unknown>;
  const question = typeof answer.ownerQuestion === "string" ? answer.ownerQuestion.trim() : "";
  if (answer.coverageStatus !== "needs_owner_input" || question.length === 0 ||
      question.length > QUESTION_MAX || !amuxAnalysisTextSafe(question)) {
    return { reason: "not_a_plan" };
  }
  return { reason: "owner_question", question };
}

const UNIT_KINDS: readonly unknown[] = ["node", "card", "evidence"];

/** A schema rule's location, exactly as the inspection names it. */
const readAt = (value: unknown): AmuxAnalysisSchemaRejectAt | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const at = value as Record<string, unknown>;
  const keys = Object.keys(at);
  if (!keys.every((key) => ["rule", "field", "unit", "kind"].includes(key)) ||
      !(AMUX_ANALYSIS_SCHEMA_RULES as readonly unknown[]).includes(at.rule) ||
      (at.field !== undefined && !(AMUX_ANALYSIS_SCHEMA_FIELDS as readonly unknown[]).includes(at.field)) ||
      (at.unit !== undefined && !(Number.isSafeInteger(at.unit) && (at.unit as number) >= 0 &&
        (at.unit as number) < 1_000)) ||
      (at.kind !== undefined && (at.unit === undefined || !UNIT_KINDS.includes(at.kind)))) return null;
  return at as AmuxAnalysisSchemaRejectAt;
};

/** The Admin screen trusts only an exact reply of the review route. */
export function readAmuxSessionReviewReply(body: unknown): AmuxSessionReview | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const review = (body as Record<string, unknown>).review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const row = review as Record<string, unknown>;
  if (row.reason === "not_a_plan" && Object.keys(row).length === 1) return { reason: "not_a_plan" };
  if (row.reason === "not_a_plan" && Object.keys(row).length === 2 &&
      (AMUX_SESSION_REVIEW_DETAILS as readonly unknown[]).includes(row.detail)) {
    return { reason: "not_a_plan", detail: row.detail as AmuxSessionReviewDetail };
  }
  // Only a schema refusal names the rule and place that refused it.
  if (row.reason === "not_a_plan" && Object.keys(row).length === 3 && row.detail === "chunk_schema_rejected") {
    const at = readAt(row.at);
    if (at) return { reason: "not_a_plan", detail: "chunk_schema_rejected", at };
  }
  if (row.reason === "owner_question" && Object.keys(row).length === 2 &&
      typeof row.question === "string" && row.question.length > 0 &&
      row.question.length <= QUESTION_MAX) {
    return { reason: "owner_question", question: row.question };
  }
  return null;
}
