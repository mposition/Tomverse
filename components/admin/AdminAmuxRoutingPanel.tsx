"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxRoutingMessages } from "@/lib/adminMessages/amuxRouting";
import { discardResponseBody } from "@/lib/discardResponseBody";

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
    reason: string;
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
    (value: string) =>
      new Intl.DateTimeFormat(adminIntlLocale(locale), {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(value)),
    [locale],
  );
  const [report, setReport] = useState<AmuxReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const incidentLabel = !report?.incident.valid
    ? m.incidentInvalid
    : report.incident.blocks_admission
      ? m.incidentFrozen
      : m.incidentNormal;

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
          onClick={() => void load()}
          disabled={loading}
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
                  {m.resolutionUnavailable}
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
                          {escalation.reason}
                        </p>
                      </li>
                    ))}
                  </ul>
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
