"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminAmuxRoutingMessages } from "@/lib/adminMessages/amuxRouting";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { discardResponseBody } from "@/lib/discardResponseBody";

// The server-side review proxy waits up to 40s. The browser must not abort
// first; an unknown outcome freezes writes until decision ID/digest lookup.
const AMUX_REVIEW_CLIENT_TIMEOUT_MS = 45_000;

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
  escalations: Array<{
    id: string;
    specialty: string | null;
    reason_code: "human_review_required" | "task_blocked" | "operator_review_required" | null;
    status: string;
    createdAt: string;
    task: { id: string; title: string; priority: string; status: string };
  }>;
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
type ReviewDetail = {
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
    outcome: string;
    to_status: string;
    ended_at: string | null;
  } | null;
  review_content: { text: string; digest: string; truncated: boolean } | null;
  review_context: {
    title: string | null;
    description: string | null;
    escalation_reason: string;
    last_attempt_reason: string | null;
    previous_block_reason: string | null;
  };
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

export function AdminAmuxRoutingPanel() {
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
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewUnavailable, setReviewUnavailable] = useState(false);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [selectedOutcome, setSelectedOutcome] = useState<ReviewOutcome | null>(null);
  const [resolution, setResolution] = useState("");
  const [proposal, setProposal] = useState<ReviewProposal | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [decisionStatusUnknown, setDecisionStatusUnknown] = useState(false);
  const [decisionStatusChecking, setDecisionStatusChecking] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const reviewRequestId = useRef(0);

  const closeReview = useCallback(() => {
    reviewRequestId.current += 1;
    setSelectedEscalationId(null);
    setReview(null);
    setReviewLoading(false);
    setReviewBusy(false);
    setReviewError(null);
    setReviewUnavailable(false);
    setReauthenticationRequired(false);
    setSelectedOutcome(null);
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
      const response = await fetch("/api/admin/amux/routing", {
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

  const clearPendingDecision = () => {
    try { window.sessionStorage.removeItem(PENDING_DECISION_KEY); } catch { /* no-op */ }
    setPendingDecision(null);
    setDecisionStatusUnknown(false);
  };

  const openReview = async (escalationId: string) => {
    if (pendingDecision) return;
    const requestId = ++reviewRequestId.current;
    setSelectedEscalationId(escalationId);
    setReview(null);
    setReviewLoading(true);
    setReviewError(null);
    setReviewUnavailable(false);
    setReauthenticationRequired(false);
    setSelectedOutcome(null);
    setResolution("");
    setProposal(null);
    setIdempotencyKey(null);
    setDecisionStatusUnknown(false);
    setDecisionStatusChecking(false);
    try {
      const response = await fetch(
        `/api/admin/amux/escalations/review?escalation_id=${encodeURIComponent(escalationId)}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(AMUX_REVIEW_CLIENT_TIMEOUT_MS),
        },
      );
      if (requestId !== reviewRequestId.current) return;
      if (!response.ok) {
        const code = await responseCode(response);
        if (code === "ADMIN_REAUTHENTICATION_REQUIRED" || response.status === 428) {
          setReauthenticationRequired(true);
        } else if (code === "AMUX_AGENT_APPROVAL_UNAVAILABLE") {
          setReviewUnavailable(true);
        } else {
          setReviewError(m.reviewLoadFailed);
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
    } catch {
      if (requestId === reviewRequestId.current) setReviewError(m.reviewLoadFailed);
    } finally {
      if (requestId === reviewRequestId.current) setReviewLoading(false);
    }
  };

  const prepareProposal = async () => {
    if (!review || !selectedOutcome || reviewBusy || pendingDecision || !review.allowed_outcomes.includes(selectedOutcome)) return;
    if (!hasReviewSubject(review)) return;
    if (resolution.trim().length < 3 || resolution.trim().length > 1_000) {
      setReviewError(m.resolutionLength);
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    setProposal(null);
    setDecisionStatusUnknown(false);
    try {
      const response = await fetch("/api/admin/amux/escalations/proposals", {
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
      const response = await fetch("/api/admin/amux/escalations", {
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
      const response = await fetch(
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
  const reviewOutcomes = hasReviewSubject(review)
    ? review.allowed_outcomes.filter(isReviewOutcome)
    : [];

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
                href={adminRecentAuthenticationHref("/admin/routing")}
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
                {report.escalations.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">
                    {m.noEscalations}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {report.escalations.map((escalation) => (
                      <li
                        key={escalation.id}
                        className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <strong className="text-amber-100">
                            {escalation.task.title}
                          </strong>
                          <span className="text-xs text-amber-200">
                            {escalation.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-amber-100/70">
                          {escalation.specialty ?? m.general} ·{" "}
                          {escalation.reason_code
                            ? m.reasonCode[escalation.reason_code] ?? m.reasonUnspecified
                            : m.reasonUnspecified}
                        </p>
                        <button
                          type="button"
                          onClick={() => void openReview(escalation.id)}
                          disabled={reviewBusy || Boolean(pendingDecision)}
                          className="mt-2 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/10 disabled:opacity-60"
                          data-testid="admin-amux-open-review"
                        >
                          {m.openReview}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
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
                      >
                        {m.closeReview}
                      </button>
                    </div>
                    <p className="mt-2 break-all font-mono text-zinc-500">
                      {m.escalationId}: {selectedEscalationId}
                    </p>
                    {reviewLoading && (
                      <p className="mt-3 inline-flex items-center gap-2">
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
                          href={adminRecentAuthenticationHref("/admin/routing")}
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
                    {review && !reviewUnavailable && (
                      <>
                        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                          <dt className="text-zinc-500">{m.taskId}</dt>
                          <dd className="break-all font-mono">{review.task.id}</dd>
                          <dt className="text-zinc-500">{m.taskState}</dt>
                          <dd>{review.task.status} · r{review.task.revision}</dd>
                          <dt className="text-zinc-500">{m.specialty}</dt>
                          <dd>{review.escalation.specialty ?? m.general}</dd>
                          <dt className="text-zinc-500">{m.dueParseState}</dt>
                          <dd>{review.task.due_parse_state}</dd>
                          <dt className="text-zinc-500">{m.lastAttempt}</dt>
                          <dd>
                            {review.last_attempt
                              ? `${review.last_attempt.id} · ${review.last_attempt.outcome} → ${review.last_attempt.to_status} · ${review.last_attempt.ended_at ? date(review.last_attempt.ended_at) : "—"}`
                              : m.noAttempt}
                          </dd>
                          <dt className="text-zinc-500">{m.attemptBudget}</dt>
                          <dd>{number(review.retry.used)} / {number(review.retry.limit)} · {m.remaining} {number(review.retry.remaining)}</dd>
                        </dl>
                        {review.retry.remaining === 0 && (
                          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100" data-testid="admin-amux-exhausted-task-notice">
                            {m.exhaustedRequiresNewTask} {m.taskId}: <span className="font-mono">{review.task.id}</span>
                          </p>
                        )}
                        <div className="mt-3 grid gap-2 rounded-lg border border-zinc-700 p-3" data-testid="admin-amux-review-context">
                          <p className="font-bold text-zinc-100">{m.reviewTaskContext}</p>
                          <p className="text-zinc-300">{review.review_context.title ?? "—"}</p>
                          {review.review_context.description && (
                            <div>
                              <p className="text-xs font-bold text-zinc-400">{m.taskDescription}</p>
                              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-zinc-300">{review.review_context.description}</pre>
                            </div>
                          )}
                          {review.review_content?.truncated && (
                            <p className="text-sm font-bold text-amber-200">{m.reviewContentTruncated}</p>
                          )}
                          <p className="text-sm text-zinc-400">{m.escalationReason}: {review.review_context.escalation_reason}</p>
                          {review.review_context.last_attempt_reason && (
                            <p className="text-sm text-zinc-400">{m.lastAttemptReason}: {review.review_context.last_attempt_reason}</p>
                          )}
                          {review.review_context.previous_block_reason && (
                            <p className="text-sm text-zinc-400">{m.previousBlockReason}: {review.review_context.previous_block_reason}</p>
                          )}
                        </div>
                        {review.review_artifact &&
                          Number.isSafeInteger(review.review_artifact.pr_number) &&
                          review.review_artifact.pr_number > 0 &&
                          /^[a-f0-9]{40}$/.test(review.review_artifact.base_sha) &&
                          /^[a-f0-9]{40}$/.test(review.review_artifact.head_sha) &&
                          /^[a-f0-9]{64}$/.test(review.review_artifact.diff_digest) && (
                            <div className="mt-3 rounded-lg border border-zinc-700 p-3" data-testid="admin-amux-review-artifact">
                              <a
                                href={`https://github.com/mposition/Tomverse/pull/${review.review_artifact.pr_number}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-bold text-blue-300 underline"
                              >
                                {m.reviewPr} #{review.review_artifact.pr_number}
                              </a>
                              <p className="mt-2 break-all font-mono text-zinc-300">{m.reviewBaseSha}: {review.review_artifact.base_sha}</p>
                              <p className="mt-2 break-all font-mono text-zinc-300">{m.reviewHeadSha}: {review.review_artifact.head_sha}</p>
                              <p className="mt-1 break-all font-mono text-zinc-300">{m.reviewDiffDigest}: {review.review_artifact.diff_digest}</p>
                              <p className="mt-3 text-xs font-bold text-zinc-400">{m.reviewPrDiff}</p>
                              <pre dir="ltr" className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-zinc-300">{review.review_artifact.diff_text}</pre>
                            </div>
                          )}
                        {hasReviewSubject(review) ? (
                          <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950 p-3" data-testid="admin-amux-review-content">
                            <p className="font-bold text-zinc-100">{m.reviewContent}</p>
                            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans leading-5 text-zinc-300">
                              {review.review_content.text}
                            </pre>
                            <p className="mt-2 break-all font-mono text-zinc-500">
                              {m.subjectDigest}: {review.review_content.digest}
                            </p>
                          </div>
                        ) : (
                          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100" data-testid="admin-amux-review-no-content">
                            {m.reviewContentMissing}
                          </p>
                        )}
                        {!review.allowed_outcomes.includes("approve") && (
                          <p className="mt-3 text-amber-200">{m.approveUnavailable}</p>
                        )}
                        {reviewOutcomes.length === 0 ? (
                          <p className="mt-3 text-amber-200">{m.noAllowedOutcome}</p>
                        ) : (
                          <>
                            <p className="mt-3 font-bold text-zinc-100">{m.chooseDecision}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {reviewOutcomes.map((outcome) => (
                                <button
                                  key={outcome}
                                  type="button"
                                  onClick={() => {
                                    setSelectedOutcome(outcome);
                                    setProposal(null);
                                    setIdempotencyKey(null);
                                    setDecisionStatusUnknown(false);
                                    setReviewError(null);
                                  }}
                                  disabled={reviewBusy || reauthenticationRequired || decisionStatusUnknown}
                                  aria-pressed={selectedOutcome === outcome}
                                  className="rounded-lg border border-zinc-600 px-3 py-1.5 font-bold text-zinc-100 hover:bg-zinc-800 aria-pressed:border-blue-400 aria-pressed:bg-blue-500/10 disabled:opacity-50"
                                  data-testid={`admin-amux-select-${outcome}`}
                                >
                                  {m.outcome[outcome]} · {review.proposed_transitions[outcome] ?? "—"}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                        {selectedOutcome && review.allowed_outcomes.includes(selectedOutcome) && (
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
                                disabled={reviewBusy || resolution.trim().length < 3}
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
