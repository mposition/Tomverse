import { createHash } from "node:crypto";
import { amuxReviewPrivateProxyOrigin } from "@/lib/originProtection";

export const AMUX_REVIEW_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1_000;
export const AMUX_REVIEW_DISPLAY_MAX_BYTES = 200_000;

export const amuxReviewTextExceedsDisplay = (value: string | null) =>
  value !== null &&
  Buffer.byteLength(value.normalize("NFC"), "utf8") > AMUX_REVIEW_DISPLAY_MAX_BYTES;

const cleanedReviewDisplayText = (value: string) => value.normalize("NFC")
  .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\p{Cf}\p{Cs}]/gu, "");

export const safeReviewDisplayText = (value: string | null) => {
  if (value === null) return null;
  const cleaned = cleanedReviewDisplayText(value);
  let text = "";
  let bytes = 0;
  for (const character of cleaned) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > AMUX_REVIEW_DISPLAY_MAX_BYTES) break;
    text += character;
    bytes += size;
  }
  return text;
};

export const amuxReviewDisplayIsExact = (value: string | null) =>
  value === null || cleanedReviewDisplayText(value) === value;

export const isAmuxAgentApprovalEnabled = (value: string | undefined) =>
  value === "true";

export const amuxReviewApprovalReadiness = (env: {
  TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED?: string;
  TOMVERSE_AMUX_SYNC_SECRET?: string;
  AMUX_REVIEW_GITHUB_READ_TOKEN?: string;
  NEXTAUTH_URL?: string;
  TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN?: string;
  RAILWAY_PRIVATE_DOMAIN?: string;
  PORT?: string;
}) => {
  const enabled = isAmuxAgentApprovalEnabled(env.TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED);
  const invalidPrivateOrigin = Boolean(
    env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN?.trim() &&
    !amuxReviewPrivateProxyOrigin(env),
  );
  if (!enabled) return {
    ready: !invalidPrivateOrigin,
    enabled: false,
    missing: invalidPrivateOrigin
      ? ["TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN"]
      : [] as string[],
  };
  const missing: string[] = [];
  if ((env.TOMVERSE_AMUX_SYNC_SECRET ?? "").length < 32)
    missing.push("TOMVERSE_AMUX_SYNC_SECRET");
  if (!env.AMUX_REVIEW_GITHUB_READ_TOKEN?.trim())
    missing.push("AMUX_REVIEW_GITHUB_READ_TOKEN");
  try {
    const url = new URL(env.NEXTAUTH_URL ?? "");
    if (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      missing.push("NEXTAUTH_URL");
    }
  } catch {
    missing.push("NEXTAUTH_URL");
  }
  if (invalidPrivateOrigin) missing.push("TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN");
  return { ready: missing.length === 0, enabled, missing };
};

export type AmuxReviewOutcome = "approve" | "retry" | "block";
export type AmuxReviewTaskStatus = "review" | "blocked";

export const amuxReviewApprovalHasEvidence = (input: {
  sourceSystem: string | null; cardType: string | null;
  taskRole: string | null; reviewPrNumber: number | null;
  artifactAvailable: boolean; v4EvidenceVerified: boolean;
  displayTruncated: boolean; displayExact: boolean;
}) => !input.displayTruncated && input.displayExact &&
  (input.sourceSystem === "admin-idea-v4" ?
  input.cardType === "task" &&
    (input.reviewPrNumber !== null ?
    input.artifactAvailable :
    input.v4EvidenceVerified &&
      ["design", "test", "review", "verify", "investigate", "operate"]
        .includes(input.taskRole ?? "")) : input.artifactAvailable);

export const amuxV4ReviewEvidenceMatches = (input: {
  task: { id: string; sourceSystem: string | null; revision: number;
    titleDigest: string | null; bodyDigest: string | null;
    briefDigest: string | null };
  evidence: { taskId: string; revision: number;
    titleDigest: string | null; bodyDigest: string | null;
    briefDigest: string | null; resultAttemptId: string | null;
    resultSha256: string | null } | null;
  result: { attemptId: string; sourceSha256: string;
    bodyPurgedAt: Date | null } | null;
  attempt: { id: string; v22AssignmentId: string | null } | null;
}) => input.task.sourceSystem === "admin-idea-v4" &&
  input.evidence !== null && input.result !== null && input.attempt !== null &&
  input.evidence.taskId === input.task.id &&
  input.evidence.revision === input.task.revision &&
  input.evidence.titleDigest === input.task.titleDigest &&
  input.evidence.bodyDigest === input.task.bodyDigest &&
  input.evidence.briefDigest === input.task.briefDigest &&
  input.evidence.resultAttemptId !== null &&
  input.evidence.resultSha256 !== null &&
  input.result.attemptId === input.evidence.resultAttemptId &&
  input.result.sourceSha256 === input.evidence.resultSha256 &&
  input.result.bodyPurgedAt === null &&
  input.attempt.id === input.evidence.resultAttemptId &&
  input.attempt.v22AssignmentId !== null;

/** An unknown v22 worker result may still be running outside the app lease.
 * Legacy review keeps its existing contract; a v22 retry needs an exact,
 * receipt-backed terminal result rather than an operator guess. */
export const amuxV22ReviewRetryHasVerifiedOutcome = (input: {
  sourceSystem: string | null;
  attempt: { v22AssignmentId: string | null; outcome: string | null;
    toStatus: string | null; reason: string | null } | null;
}) => input.sourceSystem !== "admin-idea-v4" || input.attempt === null ||
  (input.attempt.v22AssignmentId !== null &&
    input.attempt.outcome === "blocked" &&
    input.attempt.toStatus === "blocked" &&
    input.attempt.reason === "reported_result");

export type AmuxReviewSubject = {
  escalation_id: string;
  task_id: string;
  task_revision: number;
  task_status: AmuxReviewTaskStatus;
  title: string;
  description: string | null;
  due_parse_state: string;
  due_at: string | null;
  escalation_specialty: string | null;
  escalation_reason: string;
  last_attempt_id: string | null;
  last_attempt_revision: number | null;
  last_attempt_outcome: string | null;
  last_attempt_to_status: string | null;
  last_attempt_reason: string | null;
  previous_block_reason: string | null;
  review_pr_number: number | null;
  review_base_sha: string | null;
  review_head_sha: string | null;
  review_diff_digest: string | null;
  v4_evidence?: {
    title_digest: string | null;
    body_digest: string | null;
    brief_digest: string | null;
    result_attempt_id: string | null;
    result_sha256: string | null;
  };
};

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Canonical and versioned: the exact fields shown at review are bound to the
 * person's proposal. Objects are constructed in this fixed key order; none of
 * the fields may be sourced from a client-supplied digest.
 */
export const amuxReviewSubjectDigest = (subject: AmuxReviewSubject) =>
  sha256Hex(
    JSON.stringify({
      version: subject.v4_evidence ? 6 : 5,
      escalation_id: subject.escalation_id,
      task_id: subject.task_id,
      task_revision: subject.task_revision,
      task_status: subject.task_status,
      title: subject.title,
      description: subject.description,
      due_parse_state: subject.due_parse_state,
      due_at: subject.due_at,
      escalation_specialty: subject.escalation_specialty,
      escalation_reason: subject.escalation_reason,
      last_attempt_id: subject.last_attempt_id,
      last_attempt_revision: subject.last_attempt_revision,
      last_attempt_outcome: subject.last_attempt_outcome,
      last_attempt_to_status: subject.last_attempt_to_status,
      last_attempt_reason: subject.last_attempt_reason,
      previous_block_reason: subject.previous_block_reason,
      review_pr_number: subject.review_pr_number,
      review_base_sha: subject.review_base_sha,
      review_head_sha: subject.review_head_sha,
      review_diff_digest: subject.review_diff_digest,
      ...(subject.v4_evidence ? { v4_evidence: subject.v4_evidence } : {}),
    }),
  );

export const amuxReviewRequestDigest = (input: {
  proposal_id: string;
  idempotency_key: string;
  resolution: string;
}) =>
  sha256Hex(
    JSON.stringify({
      version: 1,
      proposal_id: input.proposal_id,
      idempotency_key: input.idempotency_key,
      resolution: input.resolution,
    }),
  );

export const amuxReviewTargetStatus = (
  source: AmuxReviewTaskStatus,
  outcome: AmuxReviewOutcome,
): "done" | "blocked" | "todo" | null => {
  if (source === "review") {
    if (outcome === "approve") return "done";
    if (outcome === "block") return "blocked";
    return null;
  }
  if (outcome === "retry") return "todo";
  if (outcome === "block") return "blocked";
  return null;
};

export const amuxReviewProposalExpiry = (issuedAt: Date) =>
  new Date(issuedAt.getTime() + AMUX_REVIEW_PROPOSAL_TTL_MS);
