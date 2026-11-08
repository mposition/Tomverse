"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminChannelIcon, adminChannelName } from "@/components/admin/ui/AdminChannelIcon";
import { AdminDisclosureTable, type AdminDisclosureColumn } from "@/components/admin/ui/AdminDisclosureTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { amuxAestShort, amuxDurationParts } from "@/lib/adminAmuxBoardView";
import type { AmuxWorkerChannel } from "@/lib/adminAmuxFlow";
import { adminFetch } from "@/lib/adminFetch";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import { adminAmuxRoutingMessages } from "@/lib/adminMessages/amuxRouting";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The part of `GET /api/admin/amux/routing` the Diagnostics tab draws (the
 * same read the review queue used to make): incident mode, the active queue,
 * the planning limits, the latest assignment decisions and each worker's
 * outcomes. The escalation queue in that report belongs to "Waiting on you".
 */
type Report = {
  limits: { decisions: number; attempts: number };
  incident: { valid: boolean; blocks_admission: boolean; state: { ticket: string; reason: string } };
  queue: Record<string, number>;
  policies: Array<{
    scope: string; key: string; displayName: string; active: boolean; wipLimit: number | null;
    capacityPoints: number | null; costBudgetMicrousd: string | null;
  }>;
  workers: Array<{
    name: string; status: string; dispatch_ready: boolean;
    outcomes: { total: number; calibratable_total: number; succeeded: number; failed: number; blocked: number;
      expired: number; average_latency_ms: number | null };
  }>;
  decisions: Array<{
    id: string;
    task: { id: string; title: string; kind: string; priority: string; status: string };
    worker: string; scheduler_score: number; scoring_version: string; task_revision: number; created_at: string;
    evidence: {
      scheduler: Record<string, number>;
      planning: { due_at: string | null; precision: string | null; source: string | null };
      routing: { scoring_version: string | null; preferred_worker: string | null; selected_worker: string | null;
        candidate_count: number; metrics: Record<string, { value: number; observed: boolean }> };
      telemetry: { history_sample_size: number | null;
        quota: { state: string | null; metric: { confidence: number | null } | null } };
    };
  }>;
};

const isReport = (value: unknown): value is Report => {
  const report = value as Partial<Report> | null;
  return !!report && typeof report === "object" && Array.isArray(report.decisions) && Array.isArray(report.workers) &&
    Array.isArray(report.policies) && !!report.queue && !!report.incident?.state && !!report.limits;
};

const readable = (value: string) => value.replaceAll("_", " ");

/**
 * Diagnostics: why AMUX gave work to each worker, how each worker did, and the
 * state the assignment runs in. It draws a read-only report; raw metrics and
 * policy keys are folded under "Technical details". A failed read is said (with
 * a retry), never drawn as an empty list.
 */
export function AmuxDiagnosticsPanel({ workerChannels }: { workerChannels?: Record<string, AmuxWorkerChannel> | null }) {
  const m = useAdminMessages(adminAmuxBoardViewsMessages).diag;
  const routing = useAdminMessages(adminAmuxRoutingMessages);
  const { locale } = useAdminLocale();
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const number = useCallback((value: number) => value.toLocaleString(adminIntlLocale(locale)), [locale]);
  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await adminFetch("/api/admin/amux/routing", { cache: "no-store" });
      if (!response.ok) { await discardResponseBody(response); throw new Error(String(response.status)); }
      const body: unknown = await response.json();
      if (!isReport(body)) throw new Error("shape");
      setReport(body); setState("ready");
    } catch { setState("failed"); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const duration = (ms: number | null) => {
    const parts = amuxDurationParts(ms);
    return parts === null ? null : new Intl.NumberFormat(adminIntlLocale(locale), { style: "unit", unit: parts.unit, unitDisplay: "short" }).format(parts.value);
  };
  const channelOf = (worker: string) => workerChannels?.[worker] ?? null;
  const workerMark = (worker: string, size = 18) => {
    const channel = channelOf(worker);
    return <span className="inline-flex items-center gap-1.5 font-bold text-zinc-100">
      {channel && <AdminChannelIcon channel={channel} size={size} label={adminChannelName(channel)} />}{worker}</span>;
  };

  return <div className="flex min-w-0 flex-col gap-4" data-testid="amux-diagnostics-panel">
    <div className="flex justify-end">
      <button type="button" onClick={() => void load()} disabled={state === "loading"} data-testid="amux-diagnostics-refresh"
        className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-60">
        <RefreshCw className={"h-3.5 w-3.5 " + (state === "loading" ? "animate-spin" : "")} aria-hidden="true" />{m.refresh}</button>
    </div>
    {state === "failed" && <AdminStateBlock kind="error" title={m.readFailedTitle} detail={m.readFailedDetail} onRetry={() => void load()} />}
    {state === "loading" && report === null && <AdminStateBlock kind="loading" />}
    {report !== null && state !== "failed" && <>
      <AdminTile title={m.state.title} description={m.state.lede} data-testid="amux-diagnostics-state">
        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <div data-testid="admin-amux-incident-state">
            <p className="text-xs font-medium text-zinc-500">{m.state.incident}</p>
            <p className="mt-1.5"><AdminStatusChip tone={!report.incident.valid ? "unknown" : report.incident.blocks_admission ? "bad" : "ok"}>
              {!report.incident.valid ? m.state.incidentInvalid : report.incident.blocks_admission ? m.state.incidentFrozen : m.state.incidentNormal}
            </AdminStatusChip></p>
          </div>
          <div>
            <p className="text-xs font-medium text-zinc-500">{m.state.queue}</p>
            {Object.keys(report.queue).length === 0 ? <p className="mt-1.5 text-sm text-zinc-400">{m.state.queueEmpty}</p> :
              <ul className="mt-1.5 flex flex-wrap gap-2">{Object.entries(report.queue).map(([status, count]) =>
                <li key={status} className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
                  {readable(status)} <strong className="ml-1 tabular-nums text-white">{number(count)}</strong></li>)}</ul>}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-zinc-500">{m.state.policies}</p>
          {report.policies.length === 0 ? <p className="mt-1.5 text-sm text-zinc-400">{m.state.policiesEmpty}</p> :
            <ul className="mt-1.5 flex flex-col divide-y divide-zinc-800">{report.policies.map((policy) =>
              <li key={`${policy.scope}:${policy.key}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="font-bold text-zinc-100">{policy.displayName}</span>
                <span className="flex items-center gap-2 text-xs text-zinc-400">
                  {m.state.policyLimits(policy.wipLimit === null ? m.state.unlimited : String(policy.wipLimit),
                    policy.capacityPoints === null ? m.state.unlimited : String(policy.capacityPoints))}
                  <AdminStatusChip tone={policy.active ? "ok" : "idle"}>{policy.active ? m.state.policyOn : m.state.policyOff}</AdminStatusChip>
                </span>
              </li>)}</ul>}
        </div>
        {report.policies.length > 0 && <AdminTechInfo summary={m.state.techSummary}>
          <ul className="flex flex-col gap-1">{report.policies.map((policy) =>
            <li key={`${policy.scope}:${policy.key}`} className="break-all">{policy.scope}:{policy.key}
              {policy.costBudgetMicrousd !== null ? " · " + m.state.budget(policy.costBudgetMicrousd) : ""}</li>)}</ul>
        </AdminTechInfo>}
      </AdminTile>

      <AdminTile title={m.assignment.title} description={m.assignment.lede}
        action={<span className="text-xs text-zinc-500">{m.assignment.latest(report.limits.decisions)}</span>}
        data-testid="amux-diagnostics-assignment">
        <div className="-mx-5 -mb-5 overflow-hidden border-t border-zinc-800">
          <AdminDisclosureTable
            columns={[
              { key: "task", header: m.assignment.columns.task, render: (row) => <span className="block max-w-xs truncate font-medium text-zinc-100">{row.task.title}</span> },
              { key: "worker", header: m.assignment.columns.worker, render: (row) => workerMark(row.worker) },
              { key: "why", header: m.assignment.columns.why, render: (row) => {
                const routingEvidence = row.evidence.routing;
                const parts = [
                  routingEvidence.candidate_count > 0 ? m.assignment.chose(routingEvidence.candidate_count) : null,
                  routingEvidence.preferred_worker && routingEvidence.preferred_worker !== row.worker ?
                    m.assignment.preferred(routingEvidence.preferred_worker) : null,
                  row.evidence.telemetry.history_sample_size ? m.assignment.history(row.evidence.telemetry.history_sample_size) : null,
                ].filter(Boolean);
                return <span className="text-zinc-300">{parts.length > 0 ? parts.join(" · ") : m.assignment.noReason}</span>;
              } },
              { key: "score", header: m.assignment.columns.score, align: "right", render: (row) =>
                <span className="font-mono text-xs tabular-nums text-zinc-400">{m.assignment.score(number(row.scheduler_score))}</span> },
              { key: "at", header: m.assignment.columns.at, align: "right", render: (row) =>
                <time dateTime={row.created_at} title={formatAestDateTime(row.created_at) ?? undefined}
                  className="font-mono text-xs tabular-nums text-zinc-500">{amuxAestShort(row.created_at) ?? "-"}</time> },
            ] satisfies AdminDisclosureColumn<Report["decisions"][number]>[]}
            rows={report.decisions} rowKey={(row) => row.id} caption={m.assignment.title}
            expandLabel={(row) => m.assignment.techSummary + ": " + row.task.title}
            collapseLabel={(row) => m.assignment.techSummary + ": " + row.task.title}
            emptyState={<AdminStateBlock kind="empty" title={m.assignment.empty} />}
            detail={(row) => <AdminTechInfo summary={m.assignment.techSummary} defaultOpen>
              <p className="break-all">{row.task.id} · r{row.task_revision} · {row.task.kind} · {row.task.priority} · {row.scoring_version}</p>
              <p className="mt-2 font-bold text-zinc-200">{m.assignment.scheduler}</p>
              <p className="mt-1 flex flex-wrap gap-1.5">{Object.entries(row.evidence.scheduler).map(([key, value]) =>
                <span key={key} className="rounded-md bg-zinc-800 px-2 py-0.5">{readable(key)} <strong className="text-white">{number(value)}</strong></span>)}</p>
              <p className="mt-2 font-bold text-zinc-200">{m.assignment.routing} · {row.evidence.routing.scoring_version ?? "-"}</p>
              <p className="mt-1 flex flex-wrap gap-1.5">{Object.entries(row.evidence.routing.metrics).map(([key, metric]) =>
                <span key={key} className="rounded-md bg-zinc-800 px-2 py-0.5">{readable(key)} <strong className="text-white">{metric.value.toFixed(2)}</strong>
                  {" · "}{metric.observed ? m.assignment.observed : m.assignment.prior}</span>)}</p>
              <p className="mt-2">{m.assignment.deadline}: {row.evidence.planning.due_at ?
                `${formatAestDateTime(row.evidence.planning.due_at) ?? row.evidence.planning.due_at} · ${row.evidence.planning.precision ?? "-"} · ${row.evidence.planning.source ?? "-"}` :
                m.assignment.noDeadline}</p>
              <p className="mt-1">{routing.quota} {row.evidence.telemetry.quota.state ?? "-"}
                {typeof row.evidence.telemetry.quota.metric?.confidence === "number" ?
                  ` · ${routing.confidence} ${(row.evidence.telemetry.quota.metric.confidence * 100).toFixed(0)}%` : ""}</p>
            </AdminTechInfo>} />
        </div>
        <p className="text-xs text-zinc-500">{m.assignment.note}</p>
      </AdminTile>

      <section aria-labelledby="amux-diagnostics-workers" data-testid="amux-diagnostics-workers" className="flex flex-col gap-3">
        <div>
          <h2 id="amux-diagnostics-workers" className="text-base font-bold text-white">{m.workers.title}</h2>
          <p className="mt-0.5 text-sm text-zinc-400">{m.workers.lede(report.limits.attempts)}</p>
        </div>
        {report.workers.length === 0 ? <AdminStateBlock kind="empty" title={m.workers.empty} /> :
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{report.workers.map((worker) => {
            const average = duration(worker.outcomes.average_latency_ms);
            const rate = worker.outcomes.calibratable_total > 0 ?
              ((worker.outcomes.succeeded / worker.outcomes.calibratable_total) * 100).toFixed(0) + "%" : null;
            return <li key={worker.name} data-testid={"amux-diagnostics-worker-" + worker.name}
              className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {workerMark(worker.name, 22)}
                <AdminStatusChip tone={worker.dispatch_ready ? "ok" : "warn"}>{worker.dispatch_ready ? m.workers.ready : m.workers.notReady}</AdminStatusChip>
              </div>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-300">
                {([["success", worker.outcomes.succeeded], ["failed", worker.outcomes.failed],
                  ["blocked", worker.outcomes.blocked], ["expired", worker.outcomes.expired]] as const).map(([key, value]) =>
                  <span key={key}>{m.workers[key]} <strong className="tabular-nums text-white">{number(value)}</strong></span>)}
              </p>
              <p className="text-xs text-zinc-500">{m.workers.runs(worker.outcomes.total)} · {rate === null ? m.workers.noRate : m.workers.rate(rate)} ·
                {" "}{m.workers.average} {average ?? m.workers.noAverage}</p>
            </li>;
          })}</ul>}
      </section>
    </>}
  </div>;
}
