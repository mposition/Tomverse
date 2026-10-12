"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from "lucide-react";

import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { adminIntlLocale, type AdminMessageShape } from "@/lib/adminLocale";
import { adminAmuxRoutingMessages } from "@/lib/adminMessages/amuxRouting";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { adminFetch } from "@/lib/adminFetch";
import { amuxOwnerRecoveryPreparation } from "@/lib/amux/ownerRecoveryCore";
import { amuxReviewReadError } from "@/lib/amux/reviewReadErrorCore";

// The server-side review proxy waits up to 40s. The browser must not abort
// first; an unknown outcome freezes writes until decision ID/digest lookup.
const AMUX_REVIEW_CLIENT_TIMEOUT_MS = 45_000;
export const AMUX_OWNER_EXECUTION_READ_TIMEOUT_MS = 10_000;

type Metric = { value: number; observed: boolean };
type MetricEvidence = {
  value: number | null;
  raw_value: number | null;
  confidence: number | null;
  observed: boolean | null;
  source: string | null;
  sample_size: number | null;
  observed_at: string | null;
} | null;
export type AmuxEscalationSummary = {
  id: string;
  specialty: string | null;
  reason_code: "human_review_required" | "task_blocked" | "operator_review_required" | null;
  status: string;
  createdAt: string;
  task: {
    id: string;
    title: string;
    sourceKey?: string | null;
    priority: string;
    status: string;
  };
};
type AmuxReport = {
  generated_at: string;
  limits: { decisions: number; attempts: number };
  incident: {
    valid: boolean;
    blocks_admission: boolean;
    state: {
      state: "normal" | "frozen";
      reason: string;
      ticket: string;
      changed_at: string;
    };
  };
  queue: Record<string, number>;
  policies: Array<{
    scope: string;
    key: string;
    displayName: string;
    active: boolean;
    wipLimit: number | null;
    capacityPoints: number | null;
    costBudgetMicrousd: string | null;
    budgetWindowStartsAt: string | null;
    budgetWindowEndsAt: string | null;
  }>;
  escalations_total?: number;
  escalations_limit?: number;
  escalations: AmuxEscalationSummary[];
  workers: Array<{
    name: string;
    status: string;
    dispatch_ready: boolean;
    generation: number;
    heartbeat_at: string;
    outcomes: {
      total: number;
      calibratable_total: number;
      succeeded: number;
      failed: number;
      blocked: number;
      expired: number;
      average_latency_ms: number | null;
    };
  }>;
  decisions: Array<{
    id: string;
    task: {
      id: string;
      title: string;
      kind: string;
      priority: string;
      status: string;
    };
    worker: string;
    scheduler_score: number;
    scoring_version: string;
    task_revision: number;
    created_at: string;
    evidence: {
      scheduler: Record<string, number>;
      planning: {
        due_at: string | null;
        precision: string | null;
        source: string | null;
        capacity_weight: number | null;
        incident_admission: string | null;
      };
      routing: {
        scoring_version: string | null;
        preferred_worker: string | null;
        selected_worker: string | null;
        preferred_score: number | null;
        selected_score: number | null;
        candidate_count: number;
        provider: string | null;
        operationally_allowed: boolean | null;
        provider_exhausted: boolean | null;
        metrics: Record<string, Metric>;
      };
      telemetry: {
        history_sample_size: number | null;
        predicted_success: MetricEvidence;
        expected_speed: MetricEvidence;
        low_rework: MetricEvidence;
        low_human_attention: MetricEvidence;
        cost_efficiency: MetricEvidence;
        quota: {
          metric: MetricEvidence;
          state: string | null;
          provider_exhausted: boolean | null;
          reset_at: string | null;
        };
      };
    };
  }>;
};

type ReviewOutcome = "approve" | "retry" | "block";
export type AmuxReviewDetail = {
  available: boolean;
  escalation: {
    id: string;
    status: string;
    specialty: string | null;
    reason_code: string | null;
    created_at: string;
  };
  task: {
    id: string;
    title: string;
    status: string;
    revision: number;
    due_parse_state: string;
  };
  last_attempt: {
    id: string;
    task_revision: number;
    outcome: string;
    to_status: string;
    ended_at: string | null;
  } | null;
  review_content: { text: string; digest: string;
    truncated: boolean; display_mismatch?: boolean } | null;
  review_context: {
    title: string | null;
    description: string | null;
    result_sha256: string | null;
    escalation_reason: string;
    last_attempt_reason: string | null;
    previous_block_reason: string | null;
  };
  review_report: {
    scope_and_completion_criteria: string | null;
    approved_execution_brief: string | null;
    worker_report: string | null;
    worker_report_verified: boolean;
  } | null;
  review_artifact: {
    pr_number: number;
    base_sha: string;
    head_sha: string;
    diff_digest: string;
    diff_text: string;
    html_url: string;
  } | null;
  allowed_outcomes: ReviewOutcome[];
  retry: { used: number; limit: number; remaining: number };
  proposed_transitions: Partial<Record<ReviewOutcome, string>>;
};
type ReviewDetail = AmuxReviewDetail;

export type AmuxOwnerExecutionMetadata = {
  worker: string;
  attemptNumber: number;
  reservedCostMicrousd: string;
  actualCostMicrousd: string | null;
  actualCostConfirmed: boolean;
};

type OwnerExecutionState =
  | { state: "idle" | "loading" | "unavailable" }
  | { state: "ready"; metadata: AmuxOwnerExecutionMetadata };

export type AmuxOwnerExecutionReadFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number | null },
) => Promise<Response>;

type RoutingMessages = AdminMessageShape<
  (typeof adminAmuxRoutingMessages)["en"]
>;
type ReviewProposal = {
  id: string;
  decision_id: string;
  outcome: ReviewOutcome;
  task_revision: number;
  subject_digest: string;
  source_status: string;
  target_status: string;
  expires_at: string;
};
type PendingDecision = {
  decision_id: string;
  subject_digest: string;
  outcome: ReviewOutcome;
  escalation_id: string;
};
const PENDING_DECISION_KEY = "amux-review-pending-decision-v1";
// These codes are emitted by the server only after a definite pre-decision
// refusal or a rolled-back transaction. Transport errors and unknown codes
// remain frozen until the decision ledger confirms their outcome.
const DEFINITIVE_REVIEW_REFUSALS = new Set([
  "AMUX_REVIEW_PROPOSAL_CHANGED",
  "AMUX_REVIEW_SOURCE_CHANGED",
  "AMUX_REVIEW_SOURCE_UNAVAILABLE",
  "AMUX_REVIEW_COST_GUARD_BLOCKED",
  "AMUX_REVIEW_OUTCOME_UNAVAILABLE",
  "AMUX_REVIEW_TASK_CONFLICT",
  "AMUX_REVIEW_ESCALATION_CONFLICT",
]);

const isPendingDecision = (value: unknown): value is PendingDecision => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingDecision>;
  return typeof item.decision_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.decision_id) &&
    typeof item.subject_digest === "string" && /^[a-f0-9]{64}$/.test(item.subject_digest) &&
    typeof item.escalation_id === "string" && /^c[a-z0-9]{20,}$/i.test(item.escalation_id) &&
    typeof item.outcome === "string" && isReviewOutcome(item.outcome);
};

const isReviewOutcome = (value: string): value is ReviewOutcome =>
  value === "approve" || value === "retry" || value === "block";

const hasReviewSubject = (review: ReviewDetail | null): review is ReviewDetail & {
  review_content: { text: string; digest: string };
} => Boolean(
  typeof review?.review_content?.text === "string" &&
  review.review_content.text.trim() &&
  typeof review.review_content.digest === "string" &&
  /^[a-f0-9]{64}$/.test(review.review_content.digest),
);

const responseCode = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as {
    code?: string;
  } | null;
  return body?.code ?? null;
};

const readable = (value: string) => value.replaceAll("_", " ");
const pct = (numerator: number, denominator: number) =>
  denominator === 0 ? "—" : `${((numerator / denominator) * 100).toFixed(1)}%`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isValidAmuxReviewArtifact = (value: unknown): value is NonNullable<
  AmuxReviewDetail["review_artifact"]
> => isRecord(value) && Number.isSafeInteger(value.pr_number) &&
  (value.pr_number as number) > 0 &&
  typeof value.base_sha === "string" && /^[0-9a-f]{40}$/i.test(value.base_sha) &&
  typeof value.head_sha === "string" && /^[0-9a-f]{40}$/i.test(value.head_sha) &&
  typeof value.diff_digest === "string" && /^[0-9a-f]{64}$/i.test(value.diff_digest);

const isMicrousd = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

/** Owner-only execution data is useful only when it describes the exact task,
 * revision, attempt and retained result that the protected review describes. */
export const bindAmuxOwnerExecutionMetadata = (
  review: AmuxReviewDetail,
  value: unknown,
): AmuxOwnerExecutionMetadata | null => {
  if (!isRecord(value) || value.id !== review.task.id ||
      value.revision !== review.task.revision || !review.last_attempt ||
      !Array.isArray(value.attempts)) return null;
  const attempt = value.attempts.find((candidate) => isRecord(candidate) &&
    candidate.id === review.last_attempt?.id &&
    candidate.taskRevision === review.last_attempt?.task_revision);
  if (!isRecord(attempt) || typeof attempt.worker !== "string" ||
      !Number.isInteger(attempt.attemptNumber) ||
      !isMicrousd(attempt.reservedCostMicrousd)) return null;
  if (review.review_context.result_sha256) {
    if (!isRecord(value.result) || value.result.state !== "available" ||
        value.result.attemptId !== review.last_attempt.id ||
        value.result.sha256 !== review.review_context.result_sha256) return null;
  }
  const actualCostConfirmed = attempt.costConfirmed === true &&
    isMicrousd(attempt.settledCostMicrousd);
  return {
    worker: attempt.worker,
    attemptNumber: attempt.attemptNumber as number,
    reservedCostMicrousd: attempt.reservedCostMicrousd,
    actualCostMicrousd: actualCostConfirmed ?
      attempt.settledCostMicrousd as string : null,
    actualCostConfirmed,
  };
};

export const formatAmuxMicrousd = (value: string) => {
  if (!isMicrousd(value)) return null;
  const amount = BigInt(value);
  const microusdPerUsd = BigInt(1_000_000);
  const whole = amount / microusdPerUsd;
  const fraction = (amount % microusdPerUsd).toString().padStart(6, "0")
    .replace(/0+$/, "");
  return `US$${whole}${fraction ? `.${fraction}` : ""}`;
};

/** Reads supplemental owner-only attempt metadata without letting an older
 * response overwrite a newer review. The caller owns the controller so close,
 * replacement and unmount can cancel the read; this function owns its bounded
 * deadline and rechecks identity after every awaited response body. */
export async function readAmuxOwnerExecutionMetadata({
  review,
  controller,
  isCurrent,
  fetcher = adminFetch,
  timeoutMs = AMUX_OWNER_EXECUTION_READ_TIMEOUT_MS,
}: {
  review: AmuxReviewDetail;
  controller: AbortController;
  isCurrent: () => boolean;
  fetcher?: AmuxOwnerExecutionReadFetcher;
  timeoutMs?: number;
}): Promise<OwnerExecutionState | null> {
  if (!isCurrent()) return null;
  if (controller.signal.aborted) return { state: "unavailable" };
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(
      `/api/admin/amux/execution-view?view=detail&taskId=${encodeURIComponent(review.task.id)}`,
      { cache: "no-store", signal: controller.signal, timeoutMs },
    );
    if (!isCurrent()) return null;
    if (controller.signal.aborted) return { state: "unavailable" };
    if (!response.ok) {
      await discardResponseBody(response);
      if (!isCurrent()) return null;
      return { state: "unavailable" };
    }
    const body: unknown = await response.json();
    if (!isCurrent()) return null;
    if (controller.signal.aborted) return { state: "unavailable" };
    const metadata = bindAmuxOwnerExecutionMetadata(review, body);
    return metadata ? { state: "ready", metadata } : { state: "unavailable" };
  } catch {
    if (!isCurrent()) return null;
    return { state: "unavailable" };
  } finally {
    clearTimeout(deadline);
  }
}

const isOutcomeUnknown = (review: ReviewDetail) => {
  const attemptOutcome = review.last_attempt?.outcome?.toLowerCase() ?? "";
  const attemptReason = review.review_context.last_attempt_reason?.toLowerCase() ?? "";
  return attemptOutcome === "expired" || attemptOutcome.includes("unknown") ||
    attemptReason.includes("outcome_unknown");
};

const recoveryPreparationForReview = (review: ReviewDetail) =>
  amuxOwnerRecoveryPreparation({
    taskStatus: review.task.status,
    taskRevision: review.task.revision,
    escalationReason: review.review_context.escalation_reason,
    lastAttemptReason: review.review_context.last_attempt_reason,
    lastAttemptTaskRevision: review.last_attempt?.task_revision ?? null,
    lastAttemptOutcome: review.last_attempt?.outcome ?? null,
    lastAttemptToStatus: review.last_attempt?.to_status ?? null,
    lastAttemptEndedAt: review.last_attempt?.ended_at ?? null,
    assignmentConnected: Boolean(
      review.review_report?.scope_and_completion_criteria ||
      review.review_context.description,
    ),
    workerReportConnected: Boolean(review.review_report?.worker_report),
    workerReportVerified:
      review.review_report?.worker_report_verified === true,
    artifactConnected: isValidAmuxReviewArtifact(review.review_artifact),
    serverAllowsRetry: review.allowed_outcomes.includes("retry") &&
      review.proposed_transitions.retry === "todo",
  });

export const visibleAmuxOwnerReviewOutcomes = (review: ReviewDetail) => {
  if (!hasReviewSubject(review)) return [];
  const recovery = recoveryPreparationForReview(review);
  const validArtifact = isValidAmuxReviewArtifact(review.review_artifact);
  const hasApprovalEvidence = Boolean(
    (review.review_report?.worker_report &&
      review.review_report.worker_report_verified) || validArtifact,
  );
  const unknown = isOutcomeUnknown(review);
  if (!recovery.decisionContextReady) return [];
  return review.allowed_outcomes.filter(isReviewOutcome)
    .filter((outcome) => outcome !== "approve" ||
      (recovery.approvalExecutionSourceReady && hasApprovalEvidence))
    .filter((outcome) => outcome !== "retry" ||
      (!unknown && recovery.retryPreviewReady));
};

export type AmuxOwnerQueueClassification =
  | "needs_read"
  | "owner_decision"
  | "technical_recovery";

const UUID_TITLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_CARD_TITLE = /^(?:legacy\s+)?(?:closed\s+)?card(?:\s+[0-9a-f-]{8,64})?$/i;

export const amuxQueueTaskTitle = (task: AmuxEscalationSummary["task"]) => {
  const title = task.title.trim();
  if (!title || UUID_TITLE.test(title) || GENERIC_CARD_TITLE.test(title)) return null;
  return title;
};

/** Queue summaries never prove that an owner decision is ready. Only the exact
 * protected review currently open for the same escalation and task can promote
 * one loaded row from evidence-check to a real, server-permitted decision. */
export const classifyAmuxOwnerQueueItem = (
  escalation: AmuxEscalationSummary,
  currentReview: ReviewDetail | null,
): AmuxOwnerQueueClassification => {
  if (!currentReview || currentReview.escalation.id !== escalation.id ||
      currentReview.task.id !== escalation.task.id) return "needs_read";
  const recovery = recoveryPreparationForReview(currentReview);
  if (isOutcomeUnknown(currentReview) || !recovery.decisionContextReady) {
    return "technical_recovery";
  }
  return visibleAmuxOwnerReviewOutcomes(currentReview).length > 0
    ? "owner_decision"
    : "needs_read";
};

export function AmuxOwnerReviewView({
  m,
  review,
  ownerExecution,
  canInspectCards,
  selectedOutcome,
  retryReadConfirmed,
  reviewBusy,
  reauthenticationRequired,
  decisionStatusUnknown,
  date,
  number,
  onSelectOutcome,
  onRetryReadConfirmed,
  onReread,
}: {
  m: RoutingMessages;
  review: ReviewDetail;
  ownerExecution: OwnerExecutionState;
  canInspectCards: boolean;
  selectedOutcome: ReviewOutcome | null;
  retryReadConfirmed: boolean;
  reviewBusy: boolean;
  reauthenticationRequired: boolean;
  decisionStatusUnknown: boolean;
  date: (value: string) => string;
  number: (value: number) => string;
  onSelectOutcome: (outcome: ReviewOutcome) => void;
  onRetryReadConfirmed: (confirmed: boolean) => void;
  onReread: () => void;
}) {
  const outcomes = visibleAmuxOwnerReviewOutcomes(review);
  const report = review.review_report;
  const recovery = recoveryPreparationForReview(review);
  const unknown = isOutcomeUnknown(review);
  const succeeded = review.last_attempt?.outcome === "succeeded";
  const validArtifact = isValidAmuxReviewArtifact(review.review_artifact)
    ? review.review_artifact
    : null;
  const hasWorkerEvidence = Boolean(report?.worker_report || validArtifact);
  const technicalOnly = !recovery.decisionContextReady;
  const decisionQuestion = outcomes.includes("approve")
    ? m.ownerQuestionApprove
    : outcomes.includes("retry")
      ? m.ownerQuestionRetry
      : outcomes.includes("block")
        ? m.ownerQuestionBlock
        : null;
  const cost = ownerExecution.state === "ready" ? ownerExecution.metadata : null;
  const retryScope = report?.scope_and_completion_criteria ??
    review.review_context.description;
  const previousReservation = ownerExecution.state === "loading"
    ? m.costLoading
    : cost
      ? formatAmuxMicrousd(cost.reservedCostMicrousd) ?? m.unknownValue
      : m.unknownValue;
  const previousSettlement = ownerExecution.state === "loading"
    ? m.costLoading
    : cost?.actualCostConfirmed && cost.actualCostMicrousd
      ? formatAmuxMicrousd(cost.actualCostMicrousd) ?? m.unknownValue
      : m.unknownValue;
  const outputEvidence = recovery.outputState === "verified"
    ? m.outputVerified
    : recovery.outputState === "unverified"
      ? m.outputUnverified
      : m.outputMissing;
  const recoveryChecklist = [
    { label: m.checklistAssignment, ready: recovery.assignmentConnected },
    { label: m.checklistExecution, ready: recovery.executionOutcomeKnown },
    { label: m.checklistOutput, ready: recovery.outputState !== "missing" },
  ];
  const blockEffect = review.task.status === "blocked"
    ? m.blockDecisionWarning.blocked
    : m.blockDecisionWarning.review;

  return (
    <div className="mt-4 space-y-4" data-testid="admin-amux-owner-review">
      <header className="rounded-xl border border-zinc-700 bg-zinc-900/70 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-300">
              {m.ownerReviewEyebrow}
            </p>
            <h4 className="mt-2 break-words text-xl font-black text-white">
              {review.review_context.title ?? review.task.title}
            </h4>
          </div>
          <span className="rounded-full border border-zinc-600 bg-zinc-950 px-3 py-1 text-xs font-semibold text-zinc-300"
            data-testid="admin-amux-task-lifecycle">
            {m.taskLifecycleStatus(review.task.status)}
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-400">{m.ownerReviewIntro}</p>
        {review.review_content?.truncated && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm font-bold text-amber-100">
            {m.reviewContentTruncated}
          </p>
        )}
        {review.review_content?.display_mismatch && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm font-bold text-amber-100">
            {m.reviewDisplayMismatch}
          </p>
        )}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-zinc-700 bg-zinc-950 p-5" data-testid="admin-amux-assigned-work">
          <div className="flex items-center gap-2 text-zinc-100">
            <FileText aria-hidden="true" className="h-5 w-5 text-blue-300" />
            <h5 className="font-bold">{m.assignedWork}</h5>
          </div>
          {report?.scope_and_completion_criteria ? (
            <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-zinc-300 [overflow-wrap:anywhere]">
              {report.scope_and_completion_criteria}
            </pre>
          ) : review.review_context.description ? (
            <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-zinc-300 [overflow-wrap:anywhere]">
              {review.review_context.description}
            </pre>
          ) : (
            <p className="mt-4 text-sm leading-6 text-amber-200">{m.assignmentNotConnected}</p>
          )}
          {report?.approved_execution_brief && (
            <details className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
              <summary className="min-h-11 cursor-pointer py-2 font-semibold text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                {m.approvedBrief}
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-zinc-300 [overflow-wrap:anywhere]">
                {report.approved_execution_brief}
              </pre>
            </details>
          )}
        </section>

        <section className="rounded-xl border border-zinc-700 bg-zinc-950 p-5" data-testid="admin-amux-worker-report">
          <div className="flex items-center gap-2 text-zinc-100">
            <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-blue-300" />
            <h5 className="font-bold">{m.workerReport}</h5>
          </div>
          {report?.worker_report ? (
            <>
              <p className="mt-3 text-xs font-semibold text-zinc-400">
                {report.worker_report_verified ? m.verifiedResultBinding : m.unverifiedResultBinding}
              </p>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-zinc-300 [overflow-wrap:anywhere]">
                {report.worker_report}
              </pre>
            </>
          ) : validArtifact ? (
            <div className="mt-4">
              <a href={`https://github.com/mposition/Tomverse/pull/${validArtifact.pr_number}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center rounded-lg border border-blue-500/40 px-3 py-2 font-bold text-blue-200 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                {m.reviewPr} #{validArtifact.pr_number}
              </a>
              <p className="mt-2 text-sm text-zinc-400">{m.prIsWorkerEvidence}</p>
            </div>
          ) : (
            <p className="mt-4 text-sm leading-6 text-amber-200" data-testid="admin-amux-report-not-connected">
              {m.workerReportNotConnected}
            </p>
          )}
          {succeeded && (
            <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100">
              {m.succeededNotApproved}
            </p>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-zinc-700 bg-zinc-950 p-5" data-testid="admin-amux-review-progress">
        <h5 className="font-bold text-zinc-100">{m.reviewProgress}</h5>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <dt className="text-xs font-bold uppercase tracking-wide text-zinc-500">{m.finished}</dt>
            <dd className="mt-2 text-sm leading-5 text-zinc-200">
              {hasWorkerEvidence ? m.resultSubmitted : m.noResultConnected}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <dt className="text-xs font-bold uppercase tracking-wide text-zinc-500">{m.remainingWork}</dt>
            <dd className="mt-2 text-sm leading-5 text-zinc-200">
              {outcomes.length > 0 ? m.ownerDecisionRemaining : m.noDecisionAvailable}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <dt className="text-xs font-bold uppercase tracking-wide text-zinc-500">{m.unverified}</dt>
            <dd className="mt-2 text-sm leading-5 text-zinc-200">{m.qualityStillUnverified}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-zinc-700 bg-zinc-950 p-5" data-testid="admin-amux-cost-summary">
        <h5 className="font-bold text-zinc-100">{m.attemptAndCost}</h5>
        {ownerExecution.state === "loading" ? (
          <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> {m.costLoading}
          </p>
        ) : cost ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div><dt className="text-xs text-zinc-500">{m.worker}</dt><dd className="mt-1 break-words text-zinc-200">{cost.worker}</dd></div>
            <div><dt className="text-xs text-zinc-500">{m.reservedMaximum}</dt><dd className="mt-1 text-zinc-200">{formatAmuxMicrousd(cost.reservedCostMicrousd) ?? m.unknownValue}</dd></div>
            <div><dt className="text-xs text-zinc-500">{m.actualSettledCost}</dt><dd className="mt-1 text-zinc-200">{cost.actualCostConfirmed && cost.actualCostMicrousd ? formatAmuxMicrousd(cost.actualCostMicrousd) : m.unknownValue}</dd></div>
          </dl>
        ) : (
          <p className="mt-3 text-sm leading-6 text-zinc-400">{m.costUnavailable}</p>
        )}
        <p className="mt-3 text-xs leading-5 text-zinc-500">{m.costBoundary}</p>
      </section>

      {(unknown || technicalOnly) && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5" data-testid="admin-amux-technical-recovery">
          <div className="flex items-center gap-2 text-amber-100">
            <Wrench aria-hidden="true" className="h-5 w-5" />
            <h5 className="font-bold">{m.technicalRecovery}</h5>
          </div>
          <p className="mt-3 text-sm leading-6 text-amber-100/90">{m.recoveryPreparationIntro}</p>
          <div className="mt-4 rounded-lg border border-amber-300/20 bg-zinc-950/40 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-amber-200">{m.recoveryWhyStopped}</p>
            <p className="mt-2 text-sm leading-6 text-zinc-200">
              {m.recoveryReason[recovery.reason]}
            </p>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/60 p-4"
            data-testid="admin-amux-recovery-evidence">
            <h6 className="font-bold text-zinc-100">{m.recoveryKnownUnknown}</h6>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-[minmax(9rem,0.7fr)_minmax(0,1.3fr)]">
              <dt className="text-zinc-400">{m.originalWorkEvidence}</dt>
              <dd className="text-zinc-200">{recovery.assignmentConnected
                ? m.originalWorkConnected : m.originalWorkMissing}</dd>
              <dt className="text-zinc-400">{m.previousExecutionEvidence}</dt>
              <dd className="text-zinc-200">{recovery.executionOutcomeKnown
                ? m.executionKnown : m.executionUnknown}</dd>
              <dt className="text-zinc-400">{m.workerOutputEvidence}</dt>
              <dd className="text-zinc-200">{outputEvidence}</dd>
              <dt className="text-zinc-400">{m.reservedMaximum}</dt>
              <dd className="text-zinc-200">{previousReservation}</dd>
              <dt className="text-zinc-400">{m.actualSettledCost}</dt>
              <dd className="text-zinc-200">{previousSettlement}</dd>
            </dl>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/60 p-4"
            data-testid="admin-amux-recovery-checklist">
            <h6 className="font-bold text-zinc-100">{m.recoveryChecklist}</h6>
            <p className="mt-2 text-xs leading-5 text-zinc-400">{m.recoveryChecklistBoundary}</p>
            <ul className="mt-3 space-y-2 text-sm">
              {recoveryChecklist.map((item) => (
                <li key={item.label} className="flex min-h-11 flex-col justify-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-zinc-200">{item.label}</span>
                  <span className={item.ready ? "font-semibold text-emerald-300" : "font-semibold text-amber-200"}>
                    {item.ready ? m.checklistReady : m.checklistMissing}
                  </span>
                </li>
              ))}
            </ul>
            {recovery.missingEvidence.length > 0 && (
              <p className="mt-3 text-sm leading-6 text-amber-100" data-testid="admin-amux-missing-evidence">
                {m.missingEvidence}: {recovery.missingEvidence
                  .map((item) => m.missingEvidenceItem[item]).join(" · ")}
              </p>
            )}
          </div>

          <p className="mt-4 text-sm leading-6 text-amber-100">{m.duplicateCostRisk}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 p-4">
              <p className="font-bold text-zinc-100">{m.amuxNextStep}</p>
              <p className="mt-2 text-sm leading-6 text-zinc-300">{m.amuxNextStepDetail}</p>
            </div>
            <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 p-4">
              <p className="font-bold text-zinc-100">{m.operatorNextStep}</p>
              <p className="mt-2 text-sm leading-6 text-zinc-300">{m.operatorNextStepDetail}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={onReread}
              className="min-h-11 rounded-lg border border-amber-300/40 px-4 py-2 font-semibold text-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
              data-testid="admin-amux-owner-reread">
              {m.retryReviewRead}
            </button>
            {canInspectCards && (
              <Link href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(review.task.id)}`}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-600 px-4 py-2 font-semibold text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                {m.openCardDetail}
              </Link>
            )}
          </div>
        </section>
      )}

      {recovery.retryPreviewReady && retryScope && (
        <section className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-5"
          data-testid="admin-amux-retry-preview">
          <h5 className="text-lg font-black text-white">{m.retryPreviewTitle}</h5>
          <p className="mt-2 text-sm leading-6 text-zinc-300">{m.retryPreviewIntro}</p>
          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/70 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryScope}</p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-zinc-200 [overflow-wrap:anywhere]">
              {retryScope}
            </pre>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryAttemptLimit}</dt>
              <dd className="mt-2 text-sm leading-6 text-zinc-200">
                {m.retryAttemptLimitValue(review.retry.used, review.retry.limit, review.retry.remaining)}
              </dd>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryCorrectionEvidence}</dt>
              <dd className="mt-2 text-sm leading-6 text-zinc-200">{m.retryCorrectionUnavailable}</dd>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryPreviousReservation}</dt>
              <dd className="mt-2 text-sm leading-6 text-zinc-200">{previousReservation}</dd>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryPreviousSettlement}</dt>
              <dd className="mt-2 text-sm leading-6 text-zinc-200">{previousSettlement}</dd>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryNewCost}</dt>
              <dd className="mt-2 text-sm leading-6 text-zinc-200">{m.retryNewCostUnavailable}</dd>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryDuplicateControl}</dt>
              <dd className="mt-2 text-sm leading-6 text-zinc-200">{m.retryDuplicateControlDetail}</dd>
            </div>
          </dl>
          <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/70 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{m.retryEffect}</p>
            <p className="mt-2 text-sm leading-6 text-zinc-200">
              {m.retryEffectDetail(review.task.status,
                review.proposed_transitions.retry ?? "todo")}
            </p>
          </div>
          <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-sm font-semibold leading-6 text-blue-100">
            <input type="checkbox" checked={retryReadConfirmed}
              onChange={(event) => onRetryReadConfirmed(event.target.checked)}
              disabled={reviewBusy || decisionStatusUnknown}
              className="mt-1 h-4 w-4 shrink-0 accent-blue-500"
              data-testid="admin-amux-retry-read-confirmation" />
            <span>{m.retryReadConfirmation}</span>
          </label>
        </section>
      )}

      <details className="rounded-xl border border-zinc-700 bg-zinc-950 p-4" data-testid="admin-amux-developer-details">
        <summary className="min-h-11 cursor-pointer py-2 font-bold text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
          {m.developerDetails}
        </summary>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          <dt className="text-zinc-500">{m.taskId}</dt><dd className="break-all font-mono text-zinc-300">{review.task.id}</dd>
          <dt className="text-zinc-500">{m.revision}</dt><dd className="font-mono text-zinc-300">{review.task.revision}</dd>
          <dt className="text-zinc-500">{m.escalationId}</dt><dd className="break-all font-mono text-zinc-300">{review.escalation.id}</dd>
          <dt className="text-zinc-500">{m.specialty}</dt><dd className="break-words font-mono text-zinc-300">{review.escalation.specialty ?? m.general}</dd>
          <dt className="text-zinc-500">{m.dueParseState}</dt><dd className="break-words font-mono text-zinc-300">{review.task.due_parse_state}</dd>
          <dt className="text-zinc-500">{m.lastAttempt}</dt><dd className="break-all font-mono text-zinc-300">{review.last_attempt?.id ?? m.noAttempt}</dd>
          <dt className="text-zinc-500">{m.lastAttemptState}</dt><dd className="break-words font-mono text-zinc-300">{review.last_attempt ? `${review.last_attempt.outcome} → ${review.last_attempt.to_status}` : "—"}</dd>
          <dt className="text-zinc-500">{m.attemptBudget}</dt><dd className="text-zinc-300">{number(review.retry.used)} / {number(review.retry.limit)} · {m.remaining} {number(review.retry.remaining)}</dd>
          <dt className="text-zinc-500">{m.serverAllowedOutcomes}</dt><dd className="break-words font-mono text-zinc-300">{review.allowed_outcomes.join(", ") || "—"}</dd>
          {review.review_content && <><dt className="text-zinc-500">{m.subjectDigest}</dt><dd className="break-all font-mono text-zinc-300">{review.review_content.digest}</dd></>}
          {review.review_context.result_sha256 && <><dt className="text-zinc-500">{m.reviewResultSha256}</dt><dd className="break-all font-mono text-zinc-300">{review.review_context.result_sha256}</dd></>}
          <dt className="text-zinc-500">{m.lastAttemptReason}</dt><dd className="break-words font-mono text-zinc-300 [overflow-wrap:anywhere]">{review.review_context.last_attempt_reason ?? "—"}</dd>
          <dt className="text-zinc-500">{m.escalationReason}</dt><dd className="break-words font-mono text-zinc-300 [overflow-wrap:anywhere]">{review.review_context.escalation_reason}</dd>
          <dt className="text-zinc-500">{m.previousBlockReason}</dt><dd className="break-words font-mono text-zinc-300 [overflow-wrap:anywhere]">{review.review_context.previous_block_reason ?? "—"}</dd>
          <dt className="text-zinc-500">{m.attemptEndedAt}</dt><dd className="text-zinc-300">{review.last_attempt?.ended_at ? date(review.last_attempt.ended_at) : "—"}</dd>
        </dl>
        {review.review_content && (
          <div className="mt-4 border-t border-zinc-800 pt-4" data-testid="admin-amux-review-content">
            <p className="text-xs font-bold text-zinc-500">{m.reviewContent}</p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-zinc-300 [overflow-wrap:anywhere]">
              {review.review_content.text}
            </pre>
          </div>
        )}
        {validArtifact && (
          <div className="mt-4 border-t border-zinc-800 pt-4" data-testid="admin-amux-review-artifact">
            <p className="break-all font-mono text-xs text-zinc-300">{m.reviewBaseSha}: {validArtifact.base_sha}</p>
            <p className="mt-2 break-all font-mono text-xs text-zinc-300">{m.reviewHeadSha}: {validArtifact.head_sha}</p>
            <p className="mt-2 break-all font-mono text-xs text-zinc-300">{m.reviewDiffDigest}: {validArtifact.diff_digest}</p>
            <p className="mt-3 text-xs font-bold text-zinc-500">{m.reviewPrDiff}</p>
            <pre dir="ltr" className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-zinc-300 [overflow-wrap:anywhere]">
              {validArtifact.diff_text}
            </pre>
          </div>
        )}
      </details>

      {!review.allowed_outcomes.includes("approve") && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">
          {m.approveUnavailable}
        </p>
      )}
      {outcomes.length === 0 ? (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200" data-testid="admin-amux-no-owner-decision">
          {unknown ? m.unknownNoRetry : m.noAllowedOutcome}
        </p>
      ) : (
        <section className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-5" data-testid="admin-amux-owner-decision">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-300">{m.ownerDecision}</p>
          <h5 className="mt-2 text-lg font-black text-white">{decisionQuestion}</h5>
          {outcomes.includes("block") && recovery.outputState === "missing" && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100"
              data-testid="admin-amux-block-without-result">
              {m.blockWithoutResultNotice(review.task.status,
                review.proposed_transitions.block ?? "blocked")}
            </p>
          )}
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {outcomes.map((outcome) => (
              <button key={outcome} type="button"
                onClick={() => onSelectOutcome(outcome)}
                disabled={reviewBusy || reauthenticationRequired || decisionStatusUnknown}
                aria-pressed={selectedOutcome === outcome}
                className="min-h-11 rounded-lg border border-zinc-600 px-4 py-3 text-left font-bold text-zinc-100 transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 aria-pressed:border-blue-400 aria-pressed:bg-blue-500/10 disabled:opacity-50"
                data-testid={`admin-amux-select-${outcome}`}>
                <span className="block">{m.outcome[outcome]} · {review.proposed_transitions[outcome] ?? "—"}</span>
                <span className="mt-1 block text-xs font-normal leading-5 text-zinc-400">
                  {outcome === "block" ? blockEffect : m.decisionWarning[outcome]}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const QUEUE_CLASSIFICATION_ORDER: AmuxOwnerQueueClassification[] = [
  "needs_read",
  "owner_decision",
  "technical_recovery",
];

const queueClassificationTone = (classification: AmuxOwnerQueueClassification) =>
  classification === "owner_decision"
    ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
    : classification === "technical_recovery"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
      : "border-zinc-700 bg-zinc-900 text-zinc-300";

export function AmuxOwnerReviewQueueView({
  m,
  escalations,
  escalationsTotal,
  currentReview,
  canInspectCards,
  reviewBusy,
  writesFrozen,
  onOpenReview,
}: {
  m: RoutingMessages;
  escalations: AmuxEscalationSummary[];
  escalationsTotal?: number;
  currentReview: ReviewDetail | null;
  canInspectCards: boolean;
  reviewBusy: boolean;
  writesFrozen: boolean;
  onOpenReview: (escalationId: string) => void;
}) {
  const items = escalations.map((escalation) => ({
    escalation,
    classification: classifyAmuxOwnerQueueItem(escalation, currentReview),
  }));
  const counts = Object.fromEntries(QUEUE_CLASSIFICATION_ORDER.map((classification) => [
    classification,
    items.filter((item) => item.classification === classification).length,
  ])) as Record<AmuxOwnerQueueClassification, number>;

  return (
    <div data-testid="admin-amux-owner-queue-view">
      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
        data-testid="admin-amux-queue-classifications">
        <p className="text-xs leading-5 text-zinc-400">{m.queueLoadedScope(escalations.length)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUEUE_CLASSIFICATION_ORDER.map((classification) => (
            <span key={classification}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold ${queueClassificationTone(classification)}`}
              data-testid={`admin-amux-queue-count-${classification}`}>
              {m.queueClassification[classification]} · {counts[classification]}
            </span>
          ))}
        </div>
        {typeof escalationsTotal === "number" && escalationsTotal > escalations.length ? (
          <p className="mt-3 text-xs text-zinc-400" data-testid="admin-amux-escalations-bounded">
            {m.escalationsBounded(escalations.length, escalationsTotal)}
          </p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">{m.noEscalations}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map(({ escalation, classification }) => {
            const taskTitle = amuxQueueTaskTitle(escalation.task);
            return (
              <li key={escalation.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm"
                data-testid={`admin-amux-queue-item-${classification}`}>
                <span className={`inline-flex rounded-lg border px-2.5 py-1 text-xs font-semibold ${queueClassificationTone(classification)}`}
                  data-testid="admin-amux-queue-classification">
                  {m.queueClassification[classification]}
                </span>
                <strong className="mt-3 block break-words text-base text-zinc-100"
                  data-testid="admin-amux-queue-task-title">
                  {taskTitle ?? m.taskPurposeUnavailable}
                </strong>
                <p className="mt-2 text-sm leading-6 text-zinc-300">
                  {m.queueClassificationDescription[classification]}
                </p>
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  {escalation.reason_code
                    ? m.reasonCode[escalation.reason_code] ?? m.reasonUnspecified
                    : m.reasonUnspecified}
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <button type="button"
                    onClick={() => onOpenReview(escalation.id)}
                    disabled={reviewBusy || writesFrozen}
                    className="min-h-11 rounded-lg border border-zinc-600 px-4 py-2 text-left text-xs font-semibold text-zinc-100 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-60"
                    data-testid="admin-amux-open-review">
                    {m.openReview}
                  </button>
                  {canInspectCards && <Link
                    href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(escalation.task.id)}`}
                    className="inline-flex min-h-11 items-center text-xs underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                    {m.openCardDetail}
                  </Link>}
                </div>
                <details className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3"
                  data-testid="admin-amux-queue-developer-details">
                  <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold text-zinc-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                    {m.queueDeveloperIdentifiers}
                  </summary>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 pb-3 text-xs">
                    <dt className="text-zinc-600">{m.sourceKey}</dt><dd className="break-all font-mono text-zinc-400">{escalation.task.sourceKey ?? "—"}</dd>
                    <dt className="text-zinc-600">{m.taskId}</dt><dd className="break-all font-mono text-zinc-400">{escalation.task.id}</dd>
                    <dt className="text-zinc-600">{m.taskState}</dt><dd className="break-words text-zinc-400">{m.taskLifecycleStatus(escalation.task.status)}</dd>
                    <dt className="text-zinc-600">{m.escalationId}</dt><dd className="break-all font-mono text-zinc-400">{escalation.id}</dd>
                    <dt className="text-zinc-600">{m.escalationState}</dt><dd className="break-words font-mono text-zinc-400">{escalation.status}</dd>
                    <dt className="text-zinc-600">{m.specialty}</dt><dd className="break-words font-mono text-zinc-400">{escalation.specialty ?? m.general}</dd>
                  </dl>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function AdminAmuxRoutingPanel({ focusEscalationId = null, canInspectCards = false }: {
  focusEscalationId?: string | null;
  canInspectCards?: boolean;
} = {}) {
  const m = useAdminMessages(adminAmuxRoutingMessages);
  const { locale } = useAdminLocale();
  const number = useCallback(
    (value: number) => value.toLocaleString(adminIntlLocale(locale)),
    [locale],
  );
  const date = useCallback(
    (value: string) => Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(adminIntlLocale(locale), {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(value))
      : "—",
    [locale],
  );
  const [report, setReport] = useState<AmuxReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEscalationId, setSelectedEscalationId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [ownerExecution, setOwnerExecution] = useState<OwnerExecutionState>({ state: "idle" });
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewUnavailable, setReviewUnavailable] = useState(false);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [selectedOutcome, setSelectedOutcome] = useState<ReviewOutcome | null>(null);
  const [retryReadConfirmed, setRetryReadConfirmed] = useState(false);
  const [resolution, setResolution] = useState("");
  const [proposal, setProposal] = useState<ReviewProposal | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [decisionStatusUnknown, setDecisionStatusUnknown] = useState(false);
  const [decisionStatusChecking, setDecisionStatusChecking] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const reviewRequestId = useRef(0);
  const ownerExecutionController = useRef<AbortController | null>(null);
  const openedFocus = useRef<string | null>(null);

  const closeReview = useCallback(() => {
    reviewRequestId.current += 1;
    ownerExecutionController.current?.abort();
    ownerExecutionController.current = null;
    setSelectedEscalationId(null);
    setReview(null);
    setOwnerExecution({ state: "idle" });
    setReviewLoading(false);
    setReviewBusy(false);
    setReviewError(null);
    setReviewUnavailable(false);
    setReauthenticationRequired(false);
    setSelectedOutcome(null);
    setRetryReadConfirmed(false);
    setResolution("");
    setProposal(null);
    setIdempotencyKey(null);
    setDecisionStatusUnknown(false);
    setDecisionStatusChecking(false);
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await adminFetch("/api/admin/amux/routing", {
        cache: "no-store",
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      setReport((await response.json()) as AmuxReport);
    } catch {
      setError(m.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [m]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(PENDING_DECISION_KEY);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (!isPendingDecision(parsed)) return;
      queueMicrotask(() => {
        setPendingDecision(parsed);
        setDecisionStatusUnknown(true);
      });
    } catch {
      // Storage is not an authority. An invalid or unavailable entry can
      // never cause a write; the server decision ledger remains authoritative.
    }
  }, []);

  useEffect(() => () => {
    reviewRequestId.current += 1;
    ownerExecutionController.current?.abort();
    ownerExecutionController.current = null;
  }, []);

  const clearPendingDecision = () => {
    try { window.sessionStorage.removeItem(PENDING_DECISION_KEY); } catch { /* no-op */ }
    setPendingDecision(null);
    setDecisionStatusUnknown(false);
  };

  const openReview = useCallback(async (escalationId: string) => {
    if (pendingDecision) return;
    ownerExecutionController.current?.abort();
    ownerExecutionController.current = null;
    const requestId = ++reviewRequestId.current;
    setSelectedEscalationId(escalationId);
    setReview(null);
    setOwnerExecution({ state: "idle" });
    setReviewLoading(true);
    setReviewError(null);
    setReviewUnavailable(false);
    setReauthenticationRequired(false);
    setSelectedOutcome(null);
    setRetryReadConfirmed(false);
    setResolution("");
    setProposal(null);
    setIdempotencyKey(null);
    setDecisionStatusUnknown(false);
    setDecisionStatusChecking(false);
    try {
      const response = await adminFetch(
        `/api/admin/amux/escalations/review?escalation_id=${encodeURIComponent(escalationId)}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(AMUX_REVIEW_CLIENT_TIMEOUT_MS),
        },
      );
      if (requestId !== reviewRequestId.current) return;
      if (!response.ok) {
        const code = await responseCode(response);
        const failure = amuxReviewReadError(response.status, code);
        if (failure === "reauthentication") {
          setReauthenticationRequired(true);
        } else if (failure === "disabled") {
          setReviewUnavailable(true);
        } else {
          setReviewError(failure === "proxy_configuration" ? m.reviewProxyConfigurationFailed
            : failure === "access_refused" ? m.reviewAccessRefused
            : failure === "not_found" ? m.reviewNotFound
            : failure === "temporarily_unavailable" ? m.reviewTemporarilyUnavailable
            : m.reviewLoadFailed);
        }
        return;
      }
      const detail = (await response.json()) as ReviewDetail;
      if (requestId !== reviewRequestId.current) return;
      if (!detail.available) {
        setReviewUnavailable(true);
        return;
      }
      setReview(detail);
      if (canInspectCards) {
        const controller = new AbortController();
        ownerExecutionController.current = controller;
        const isCurrent = () => requestId === reviewRequestId.current &&
          ownerExecutionController.current === controller;
        setOwnerExecution({ state: "loading" });
        void readAmuxOwnerExecutionMetadata({
          review: detail,
          controller,
          isCurrent,
        }).then((nextOwnerExecution) => {
          if (!isCurrent()) return;
          if (nextOwnerExecution) setOwnerExecution(nextOwnerExecution);
          ownerExecutionController.current = null;
        });
      }
    } catch {
      if (requestId === reviewRequestId.current) setReviewError(m.reviewLoadFailed);
    } finally {
      if (requestId === reviewRequestId.current) setReviewLoading(false);
    }
  }, [pendingDecision, canInspectCards, m.reviewLoadFailed, m.reviewProxyConfigurationFailed,
    m.reviewAccessRefused, m.reviewNotFound, m.reviewTemporarilyUnavailable]);

  useEffect(() => {
    if (!report || !focusEscalationId || pendingDecision ||
        openedFocus.current === focusEscalationId) return;
    openedFocus.current = focusEscalationId;
    queueMicrotask(() => void openReview(focusEscalationId));
  }, [report, focusEscalationId, pendingDecision, openReview]);

  const prepareProposal = async () => {
    if (!review || !selectedOutcome || reviewBusy || pendingDecision || !review.allowed_outcomes.includes(selectedOutcome)) return;
    if (!hasReviewSubject(review)) return;
    if (selectedOutcome === "retry" && !retryReadConfirmed) {
      setReviewError(m.retryConfirmationRequired);
      return;
    }
    if (resolution.trim().length < 3 || resolution.trim().length > 1_000) {
      setReviewError(m.resolutionLength);
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    setProposal(null);
    setDecisionStatusUnknown(false);
    try {
      const response = await adminFetch("/api/admin/amux/escalations/proposals", {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(AMUX_REVIEW_CLIENT_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          escalation_id: review.escalation.id,
          outcome: selectedOutcome,
          expected_subject_digest: review.review_content.digest,
        }),
      });
      if (!response.ok) {
        const code = await responseCode(response);
        if (code === "ADMIN_REAUTHENTICATION_REQUIRED" || response.status === 428) {
          setReauthenticationRequired(true);
        } else if (code === "AMUX_AGENT_APPROVAL_UNAVAILABLE") {
          setReviewUnavailable(true);
        } else {
          setReviewError(m.proposalFailed);
        }
        return;
      }
      const body = (await response.json()) as { proposal?: ReviewProposal };
      if (!body.proposal || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.proposal.decision_id) ||
        body.proposal.outcome !== selectedOutcome ||
        body.proposal.task_revision !== review.task.revision ||
        body.proposal.subject_digest !== review.review_content.digest ||
        body.proposal.source_status !== review.task.status ||
        body.proposal.target_status !== review.proposed_transitions[selectedOutcome] ||
        !Number.isFinite(Date.parse(body.proposal.expires_at)) ||
        Date.parse(body.proposal.expires_at) <= Date.now()) {
        setReviewError(m.proposalMismatch);
        return;
      }
      setProposal(body.proposal);
      setIdempotencyKey(crypto.randomUUID());
    } catch {
      setReviewError(m.proposalFailed);
    } finally {
      setReviewBusy(false);
    }
  };

  const confirmDecision = async () => {
    if (!review || !proposal || !idempotencyKey || reviewBusy || decisionStatusUnknown || pendingDecision ||
      !selectedOutcome || selectedOutcome !== proposal.outcome) return;
    if (selectedOutcome === "retry" && !retryReadConfirmed) {
      setReviewError(m.retryConfirmationRequired);
      return;
    }
    if (!Number.isFinite(Date.parse(proposal.expires_at)) ||
      Date.parse(proposal.expires_at) <= Date.now()) {
      setReviewError(m.proposalExpired);
      setProposal(null);
      setIdempotencyKey(null);
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    const pending: PendingDecision = {
      decision_id: proposal.decision_id,
      subject_digest: proposal.subject_digest,
      outcome: proposal.outcome,
      escalation_id: review.escalation.id,
    };
    try {
      // Only IDs, digest and outcome survive a reload; never PR diff, reason,
      // credential, resolution text or idempotency key.
      window.sessionStorage.setItem(PENDING_DECISION_KEY, JSON.stringify(pending));
      setPendingDecision(pending);
    } catch {
      setReviewBusy(false);
      setReviewError(m.pendingDecisionStorageUnavailable);
      return;
    }
    try {
      const response = await adminFetch("/api/admin/amux/escalations", {
        method: "PATCH",
        cache: "no-store",
        signal: AbortSignal.timeout(AMUX_REVIEW_CLIENT_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resolve",
          escalation_id: review.escalation.id,
          proposal_id: proposal.id,
          idempotency_key: idempotencyKey,
          resolution: resolution.trim(),
        }),
      });
      if (!response.ok) {
        const code = await responseCode(response);
        if (code === "ADMIN_REAUTHENTICATION_REQUIRED" || response.status === 428) {
          setReauthenticationRequired(true);
          clearPendingDecision();
        } else if (code === "AMUX_REVIEW_PROPOSAL_EXPIRED") {
          setReviewError(m.proposalExpired);
          setProposal(null);
          setIdempotencyKey(null);
          clearPendingDecision();
        } else if (code === "AMUX_AGENT_APPROVAL_UNAVAILABLE") {
          clearPendingDecision();
          setReviewUnavailable(true);
        } else if (code && DEFINITIVE_REVIEW_REFUSALS.has(code)) {
          clearPendingDecision();
          setProposal(null);
          setIdempotencyKey(null);
          setReviewError(m.decisionRefused);
        } else {
          // After dispatch, an error can race a committed DB transaction.
          // Freeze writes until a read-only decision-ID/digest lookup resolves it.
          setDecisionStatusUnknown(true);
          setReviewError(m.decisionUncertain);
        }
        return;
      }
      const result = (await response.json()) as { success?: boolean };
      if (!result.success) {
        setDecisionStatusUnknown(true);
        setReviewError(m.decisionUncertain);
        return;
      }
      clearPendingDecision();
      closeReview();
      void load();
    } catch {
      setDecisionStatusUnknown(true);
      setReviewError(m.decisionUncertain);
    } finally {
      setReviewBusy(false);
    }
  };

  const checkDecisionStatus = async () => {
    const identity = pendingDecision ?? (proposal && review ? {
      decision_id: proposal.decision_id,
      subject_digest: proposal.subject_digest,
      outcome: proposal.outcome,
      escalation_id: review.escalation.id,
    } : null);
    if (!identity || !decisionStatusUnknown || decisionStatusChecking) return;
    setDecisionStatusChecking(true);
    setReviewError(null);
    try {
      const query = new URLSearchParams({
        decision_id: identity.decision_id,
        subject_digest: identity.subject_digest,
      });
      const response = await adminFetch(
        `/api/admin/amux/escalations/review/decision-status?${query}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(AMUX_REVIEW_CLIENT_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        const code = await responseCode(response);
        if (code === "ADMIN_REAUTHENTICATION_REQUIRED" || response.status === 428) {
          setReauthenticationRequired(true);
        }
        setReviewError(m.decisionUncertain);
        return;
      }
      const result = (await response.json()) as {
        status?: string;
        decision_id?: string;
        subject_digest?: string;
        outcome?: ReviewOutcome;
      };
      if (result.status === "committed" &&
          result.decision_id === identity.decision_id &&
          result.subject_digest === identity.subject_digest &&
          result.outcome === identity.outcome) {
        clearPendingDecision();
        closeReview();
        void load();
      } else {
        setReviewError(m.decisionUncertain);
      }
    } catch {
      setReviewError(m.decisionUncertain);
    } finally {
      setDecisionStatusChecking(false);
    }
  };

  const incidentLabel = !report?.incident.valid
    ? m.incidentInvalid
    : report.incident.blocks_admission
      ? m.incidentFrozen
      : m.incidentNormal;
  const reviewOutcomes = review ? visibleAmuxOwnerReviewOutcomes(review) : [];

  return (
    <section
      className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20"
      data-testid="admin-amux-routing-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 p-5">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
            <Activity className="h-3.5 w-3.5" />
            {m.eyebrow}
          </div>
          <h2 className="mt-3 text-2xl font-black text-white">{m.title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-400">
            {m.description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { closeReview(); void load(); }}
          disabled={loading || Boolean(pendingDecision)}
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="admin-amux-routing-refresh"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {m.refresh}
        </button>
      </div>

      <div className="space-y-5 p-5">
        {error && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {pendingDecision && decisionStatusUnknown && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100" data-testid="admin-amux-pending-decision">
            <p className="font-bold">{m.decisionUncertain}</p>
            <p className="mt-2 break-all font-mono text-xs">{m.decisionId}: {pendingDecision.decision_id}</p>
            <p className="mt-1 break-all font-mono text-xs">{m.subjectDigest}: {pendingDecision.subject_digest}</p>
            {reauthenticationRequired && (
              <Link
                href={adminRecentAuthenticationHref("/admin/amux-execution?tab=assignment")}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block font-bold underline"
              >
                {m.reauthenticate}
              </Link>
            )}
            <button
              type="button"
              onClick={() => void checkDecisionStatus()}
              disabled={decisionStatusChecking}
              className="mt-3 block rounded-lg border border-amber-400 px-3 py-2 font-bold disabled:opacity-50"
              data-testid="admin-amux-check-pending-decision-status"
            >
              {decisionStatusChecking ? m.working : m.checkDecisionStatus}
            </button>
          </div>
        )}

        {report && (
          <>
            <div className="grid gap-3 lg:grid-cols-[1.3fr_2fr]">
              <div
                className={`rounded-xl border p-4 ${
                  report.incident.blocks_admission
                    ? "border-red-500/30 bg-red-500/10"
                    : "border-zinc-800 bg-zinc-950"
                }`}
                data-testid="admin-amux-incident-state"
              >
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
                  <ShieldAlert className="h-4 w-4" /> {m.incident}
                </p>
                <p className="mt-2 font-bold text-white">{incidentLabel}</p>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  {report.incident.state.ticket} ·{" "}
                  {report.incident.state.reason}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500">
                  {m.queue}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(report.queue).map(([status, count]) => (
                    <span
                      key={status}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300"
                    >
                      {readable(status)}{" "}
                      <strong className="ml-1 text-white">
                        {number(count)}
                      </strong>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <h3 className="text-xs font-black uppercase tracking-[0.14em] text-zinc-500">
                  {m.policies}
                </h3>
                {report.policies.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">{m.noPolicies}</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {report.policies.map((policy) => (
                      <li
                        key={`${policy.scope}:${policy.key}`}
                        className="rounded-lg bg-zinc-900 p-3 text-sm text-zinc-300"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <strong className="text-white">
                            {policy.displayName}
                          </strong>
                          <span className="font-mono text-xs text-zinc-500">
                            {policy.scope}:{policy.key}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">
                          {m.wip} {policy.wipLimit ?? "—"} · {m.capacity}{" "}
                          {policy.capacityPoints ?? "—"} · {m.costBudget}{" "}
                          {policy.costBudgetMicrousd ?? "—"} µUSD ·{" "}
                          {policy.active ? m.active : m.inactive}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <h3 className="text-xs font-black uppercase tracking-[0.14em] text-zinc-500">
                  {m.escalations}
                </h3>
                <p className="mt-2 text-xs leading-5 text-amber-200/80">
                  {m.resolutionAvailability}
                </p>
                <AmuxOwnerReviewQueueView
                  m={m}
                  escalations={report.escalations}
                  escalationsTotal={report.escalations_total}
                  currentReview={review}
                  canInspectCards={canInspectCards}
                  reviewBusy={reviewBusy}
                  writesFrozen={Boolean(pendingDecision)}
                  onOpenReview={(escalationId) => void openReview(escalationId)}
                />
                {selectedEscalationId && (
                  <div
                    className="mt-4 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-300"
                    data-testid="admin-amux-review-detail"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-bold text-white">{m.reviewDetail}</h4>
                      <button
                        type="button"
                        onClick={closeReview}
                        disabled={reviewBusy || decisionStatusUnknown || decisionStatusChecking}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
                        data-testid="admin-amux-close-review"
                      >
                        {m.closeReview}
                      </button>
                    </div>
                    <p className="mt-2 break-all font-mono text-zinc-500">
                      {m.escalationId}: {selectedEscalationId}
                    </p>
                    {reviewLoading && (
                      <p className="mt-3 inline-flex items-center gap-2"
                        data-testid="admin-amux-review-loading">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {m.reviewLoading}
                      </p>
                    )}
                    {reviewUnavailable && (
                      <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100" data-testid="admin-amux-review-unavailable">
                        {m.reviewUnavailable}
                      </p>
                    )}
                    {reauthenticationRequired && (
                      <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
                        {m.reauthenticationRequired}{" "}
                        <Link
                          href={adminRecentAuthenticationHref("/admin/amux-execution?tab=assignment")}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-bold underline underline-offset-2"
                        >
                          {m.reauthenticate}
                        </Link>
                      </p>
                    )}
                    {reviewError && (
                      <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-200">
                        {reviewError}
                      </p>
                    )}
                    {!review && !reviewLoading && (reviewError || reauthenticationRequired) && (
                      <div className="mt-3">
                        <button type="button"
                          data-testid="admin-amux-retry-review-read"
                          disabled={reviewBusy || decisionStatusUnknown || pendingDecision !== null}
                          onClick={() => void openReview(selectedEscalationId)}
                          className="rounded-md border border-zinc-700 px-3 py-2 text-zinc-200 hover:bg-zinc-800 disabled:opacity-60">
                          {m.retryReviewRead}
                        </button>
                        <p className="mt-2 text-zinc-400">{m.retryReviewReadDescription}</p>
                      </div>
                    )}
                    {review && !reviewUnavailable && (
                      <>
                        {review.retry.remaining === 0 && (
                          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100" data-testid="admin-amux-exhausted-task-notice">
                            {m.exhaustedRequiresNewTask} {m.taskId}: <span className="font-mono">{review.task.id}</span>
                          </p>
                        )}
                        <AmuxOwnerReviewView
                          m={m}
                          review={review}
                          ownerExecution={ownerExecution}
                          canInspectCards={canInspectCards}
                          selectedOutcome={selectedOutcome}
                          retryReadConfirmed={retryReadConfirmed}
                          reviewBusy={reviewBusy}
                          reauthenticationRequired={reauthenticationRequired}
                          decisionStatusUnknown={decisionStatusUnknown}
                          date={date}
                          number={number}
                          onReread={() => void openReview(review.escalation.id)}
                          onRetryReadConfirmed={(confirmed) => {
                            setRetryReadConfirmed(confirmed);
                            setProposal(null);
                            setIdempotencyKey(null);
                            setReviewError(null);
                          }}
                          onSelectOutcome={(outcome) => {
                            setSelectedOutcome(outcome);
                            if (outcome !== "retry") setRetryReadConfirmed(false);
                            setProposal(null);
                            setIdempotencyKey(null);
                            setDecisionStatusUnknown(false);
                            setReviewError(null);
                          }}
                        />
                        {selectedOutcome && reviewOutcomes.includes(selectedOutcome) && (
                          <div className="mt-3 border-t border-zinc-700 pt-3">
                            <p className="font-bold text-zinc-100">
                              {m.outcome[selectedOutcome]} · {review.task.status} → {review.proposed_transitions[selectedOutcome] ?? "—"}
                            </p>
                            <p className="mt-1 text-amber-200">{m.decisionWarning[selectedOutcome]}</p>
                            <label htmlFor="admin-amux-resolution" className="mt-3 block font-semibold text-zinc-200">
                              {m.resolutionLabel}
                            </label>
                            <textarea
                              id="admin-amux-resolution"
                              value={resolution}
                              onChange={(event) => setResolution(event.target.value)}
                              disabled={reviewBusy || Boolean(proposal)}
                              maxLength={1_000}
                              rows={3}
                              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-white disabled:opacity-60"
                              data-testid="admin-amux-resolution"
                            />
                            {!proposal ? (
                              <button
                                type="button"
                                onClick={() => void prepareProposal()}
                                disabled={reviewBusy || resolution.trim().length < 3 ||
                                  (selectedOutcome === "retry" && !retryReadConfirmed)}
                                className="mt-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-2 font-bold text-blue-100 disabled:opacity-50"
                                data-testid="admin-amux-prepare-proposal"
                              >
                                {reviewBusy ? m.working : m.prepareProposal}
                              </button>
                            ) : (
                              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" data-testid="admin-amux-proposal-confirmation">
                                <p className="font-bold text-amber-100">{m.confirmHeading[selectedOutcome]}</p>
                                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-amber-100/90">
                                  <dt>{m.proposalId}</dt><dd className="break-all font-mono">{proposal.id}</dd>
                                  <dt>{m.decisionId}</dt><dd className="break-all font-mono">{proposal.decision_id}</dd>
                                  <dt>{m.revision}</dt><dd>r{proposal.task_revision}</dd>
                                  <dt>{m.transition}</dt><dd>{proposal.source_status} → {proposal.target_status}</dd>
                                  <dt>{m.expiry}</dt><dd>{date(proposal.expires_at)}</dd>
                                  <dt>{m.subjectDigest}</dt><dd className="break-all font-mono">{proposal.subject_digest}</dd>
                                  <dt>{m.attemptBudget}</dt><dd>{number(review.retry.remaining)} {m.remaining}</dd>
                                </dl>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void confirmDecision()}
                                    disabled={reviewBusy || reauthenticationRequired || decisionStatusUnknown}
                                    className="rounded-lg border border-amber-400 bg-amber-400/20 px-3 py-2 font-bold text-amber-100 disabled:opacity-50"
                                    data-testid={`admin-amux-confirm-${selectedOutcome}`}
                                  >
                                    {reviewBusy ? m.working : m.confirmDecision[selectedOutcome]}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setProposal(null); setIdempotencyKey(null); }}
                                    disabled={reviewBusy || decisionStatusUnknown}
                                    className="rounded-lg border border-zinc-600 px-3 py-2 disabled:opacity-50"
                                  >
                                    {m.changeDecision}
                                  </button>
                                  {decisionStatusUnknown && (
                                    <button
                                      type="button"
                                      onClick={() => void checkDecisionStatus()}
                                      disabled={decisionStatusChecking}
                                      className="rounded-lg border border-blue-400 px-3 py-2 font-bold text-blue-100 disabled:opacity-50"
                                      data-testid="admin-amux-check-decision-status"
                                    >
                                      {decisionStatusChecking ? m.working : m.checkDecisionStatus}
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h3 className="text-sm font-black uppercase tracking-[0.14em] text-zinc-400">
                  {m.workers}
                </h3>
                <p className="text-xs text-zinc-600">
                  {m.latestAttempts} {number(report.limits.attempts)}
                </p>
              </div>
              {report.workers.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">{m.noWorkers}</p>
              ) : (
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {report.workers.map((worker) => (
                    <div
                      key={worker.name}
                      className="rounded-xl border border-zinc-800 bg-zinc-950 p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <strong className="font-mono text-sm text-white">
                          {worker.name}
                        </strong>
                        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
                          {worker.status} ·{" "}
                          {worker.dispatch_ready ? m.ready : m.notReady}
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-zinc-400">
                        {number(worker.outcomes.total)} {m.attempts} ·{" "}
                        {m.success}{" "}
                        {pct(
                          worker.outcomes.succeeded,
                          worker.outcomes.calibratable_total,
                        )}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {m.failed} {number(worker.outcomes.failed)} · {m.blocked}{" "}
                        {number(worker.outcomes.blocked)} · {m.expired}{" "}
                        {number(worker.outcomes.expired)} · {m.averageLatency}{" "}
                        {worker.outcomes.average_latency_ms === null
                          ? "—"
                          : `${number(worker.outcomes.average_latency_ms)}ms`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h3 className="text-sm font-black uppercase tracking-[0.14em] text-zinc-400">
                  {m.decisions}
                </h3>
                <p className="text-xs text-zinc-600">
                  {m.latestDecisions} {number(report.limits.decisions)}
                </p>
              </div>
              {report.decisions.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">{m.noDecisions}</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {report.decisions.map((decision) => (
                    <details
                      key={decision.id}
                      className="group rounded-xl border border-zinc-800 bg-zinc-950 p-4"
                    >
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold text-white">
                              {decision.task.title}
                            </p>
                            <p className="mt-1 font-mono text-xs text-zinc-500">
                              {decision.task.priority} · {decision.task.kind} ·
                              r{decision.task_revision} ·{" "}
                              {date(decision.created_at)}
                            </p>
                          </div>
                          <div className="text-right text-sm text-zinc-300">
                            <strong className="text-white">
                              {decision.worker}
                            </strong>
                            <p className="mt-1 text-xs text-zinc-500">
                              {m.score} {number(decision.scheduler_score)}
                            </p>
                          </div>
                        </div>
                      </summary>
                      <div className="mt-4 grid gap-3 border-t border-zinc-800 pt-4 lg:grid-cols-2">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-500">
                            {m.scheduler} · {decision.scoring_version}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {Object.entries(decision.evidence.scheduler).map(
                              ([key, value]) => (
                                <span
                                  key={key}
                                  className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                                >
                                  {readable(key)}{" "}
                                  <strong className="text-white">
                                    {number(value)}
                                  </strong>
                                </span>
                              ),
                            )}
                          </div>
                          <p className="mt-3 text-xs leading-5 text-zinc-500">
                            {m.deadline}{" "}
                            {decision.evidence.planning.due_at
                              ? `${date(decision.evidence.planning.due_at)} · ${decision.evidence.planning.precision} · ${decision.evidence.planning.source}`
                              : "—"}
                            {" · "}
                            {m.historySamples} n=
                            {decision.evidence.telemetry.history_sample_size ??
                              0}{" "}
                            · {m.quota}{" "}
                            {decision.evidence.telemetry.quota.state ??
                              "unknown"}
                            {decision.evidence.telemetry.quota.metric
                              ?.confidence !== null &&
                            decision.evidence.telemetry.quota.metric
                              ?.confidence !== undefined
                              ? ` · ${m.confidence} ${(decision.evidence.telemetry.quota.metric.confidence * 100).toFixed(0)}%`
                              : ""}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-500">
                            {m.routing} ·{" "}
                            {decision.evidence.routing.scoring_version ?? "—"}
                          </p>
                          <p className="mt-2 text-sm text-zinc-300">
                            {m.selected}{" "}
                            <strong className="text-white">
                              {decision.evidence.routing.selected_worker ?? "—"}
                            </strong>{" "}
                            · {m.preferred}{" "}
                            {decision.evidence.routing.preferred_worker ?? "—"}{" "}
                            · {m.candidates}{" "}
                            {number(decision.evidence.routing.candidate_count)}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {Object.entries(
                              decision.evidence.routing.metrics,
                            ).map(([key, metric]) => (
                              <span
                                key={key}
                                className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                              >
                                {readable(key)}{" "}
                                <strong className="text-white">
                                  {metric.value.toFixed(2)}
                                </strong>{" "}
                                · {metric.observed ? m.observed : m.prior}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>

            <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs leading-6 text-zinc-400">
              {m.evidenceNote}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
