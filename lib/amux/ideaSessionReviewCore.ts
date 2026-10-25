import { amuxAnalysisTextSafe } from "./ideaAnalysisChunkCore.ts";

/**
 * Why a session analysis answer became no plan, read back for the owner from
 * the answer the app keeps for seven days after intake (v19 retention; owner
 * decision 2026-10-23). The plan writer records no reason, so this reads the
 * answer itself: an owner question is shown as the model wrote it, anything
 * else is the closed "not a plan" word. Nothing here changes what the writer
 * decided.
 */
export type AmuxSessionReview =
  | { reason: "owner_question"; question: string }
  | { reason: "not_a_plan" };

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

/** The Admin screen trusts only an exact reply of the review route. */
export function readAmuxSessionReviewReply(body: unknown): AmuxSessionReview | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const review = (body as Record<string, unknown>).review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const row = review as Record<string, unknown>;
  if (row.reason === "not_a_plan" && Object.keys(row).length === 1) return { reason: "not_a_plan" };
  if (row.reason === "owner_question" && Object.keys(row).length === 2 &&
      typeof row.question === "string" && row.question.length > 0 &&
      row.question.length <= QUESTION_MAX) {
    return { reason: "owner_question", question: row.question };
  }
  return null;
}
