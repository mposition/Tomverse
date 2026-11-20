"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { useCallback, useEffect, useState } from "react";
import { ImageIcon, Loader2 } from "lucide-react";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { optimizerCycleTone } from "@/components/admin/routing/optimizerTone";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";
import { describeAdminApiFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminImageRoutingOptimizerMessages } from "@/lib/adminMessages/imageRoutingOptimizer";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import type { ImageRoutingReport } from "@/lib/imageRoutingReportCore";

type Score = { cases: number; correct: number; falseImage: number; missedImage: number; failed: number };
type Agreement = { judged: number; agreed: number };
type Summary = {
  intent?: { incumbent: Score; candidate: Score | null };
  agreement?: { incumbent: Agreement; candidate: Agreement };
  report?: { findings: string[]; recommendations: { kind: string; text: string }[] };
};
type Cycle = {
  id: string;
  createdAt: string;
  status: string;
  failure: string | null;
  optimizerModelId: string;
  candidateGuidance: string | null;
  summary: Summary | null;
  spentMicroUsd: number;
  promotedAt: string | null;
  promotable: boolean;
};
type Automation = { daily: boolean; autoPromote: boolean; modelEval: boolean };
type State = {
  optimizerModelId: string | null;
  imageTriageOn: boolean;
  automation: Automation;
  listedCycles: number;
  active: { cycleId: string | null; guidance: string; canRollBack: boolean };
  report: { day: ImageRoutingReport | null; week: ImageRoutingReport | null };
  cycles: Cycle[];
};
type Action =
  | { action: "run" }
  | ({ action: "set_automation" } & Automation)
  | { action: "promote"; cycleId: string }
  | { action: "roll_back" };

const ENDPOINT = "/api/admin/auto-llm-router/image-optimizer";
const percent = (share: number) => `${Math.round(share * 100)}%`;
const usd = (microUsd: number | null) => (microUsd === null ? "-" : `$${(microUsd / 1_000_000).toFixed(3)}`);

/**
 * Runs, promotes and rolls back image routing criteria cycles, and shows the
 * image routing report from real Chat traffic (counts only). No user's message
 * is shown; a cycle's cases are messages the optimizer model wrote.
 */
export function AdminImageRoutingOptimizerPanel({ canWrite = true }: { canWrite?: boolean } = {}) {
  const m = useAdminMessages(adminImageRoutingOptimizerMessages);
  const screens = useAdminMessages(adminRoutingScreensMessages);
  const { locale: apiLocale } = useAdminLocale();
  const [confirming, setConfirming] = useState<{ kind: "promote"; cycleId: string } | { kind: "roll_back" } | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [automation, setAutomation] = useState<Automation>({ daily: false, autoPromote: false, modelEval: false });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = useCallback((next: State) => {
    setState(next);
    setAutomation(next.automation);
  }, []);
  const load = useCallback(async () => {
    try {
      const response = await adminFetch(ENDPOINT);
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.loadFailed, locale: apiLocale }));
        return;
      }
      apply((await response.json()) as State);
      setFailure(null);
    } catch {
      setFailure(describeAdminApiFailure({ status: 0, fallback: m.loadFailed, locale: apiLocale }));
    }
  }, [apiLocale, apply, m.loadFailed]);
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);
  const running = state?.cycles.some((cycle) => cycle.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [running, load]);

  const send = async (body: Action) => {
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    try {
      const response = await adminFetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 409) {
        const answer = (await response.json().catch(() => null)) as { code?: string } | null;
        setRefusal(answer?.code ?? "unknown");
        return;
      }
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.actionFailed, locale: apiLocale }));
        return;
      }
      apply((await response.json()) as State);
    } catch {
      setFailure(describeAdminApiFailure({ status: 0, fallback: m.actionFailed, locale: apiLocale }));
    } finally {
      setBusy(false);
    }
  };
  const reason = (code: string | null) => (code ? (m.reasons as Record<string, string>)[code] ?? code : null);
  const status = (value: string) => (m.statuses as Record<string, string>)[value] ?? value;
  const writeProps = { writable: canWrite, requiredRole: screens.needsRole } as const;
  const changed =
    !!state &&
    (automation.daily !== state.automation.daily ||
      automation.autoPromote !== state.automation.autoPromote ||
      automation.modelEval !== state.automation.modelEval);

  const report = (title: string, value: ImageRoutingReport | null, testId: string) => (
    <div className="rounded-2xl border border-zinc-800 p-4 text-xs text-zinc-300" data-testid={testId}>
      <p className="mb-2 text-sm font-bold text-zinc-200">{title}</p>
      {!value || value.decisions.total === 0 ? (
        <p className="text-zinc-500">{m.noTraffic}</p>
      ) : (
        <>
          <p>
            {value.decisions.total} {m.decisions} · {m.images} {value.decisions.byOutcome.image ?? 0} · {m.texts}{" "}
            {value.decisions.byOutcome.chat ?? 0} · {m.errors} {value.decisions.byOutcome.error ?? 0}
          </p>
          <p>
            {m.fallback} {percent(value.decisions.fallbackShare)} · {m.linked} {percent(value.decisions.linkedShare)} · {m.wantedText}{" "}
            {value.wantedText}
          </p>
          <p className="mt-2 font-bold text-zinc-400">{m.perModel}</p>
          <ul className="space-y-0.5 text-zinc-400">
            {value.models.slice(0, 8).map((row) => (
              <li key={row.modelId}>
                {row.modelId} · {row.generations} · {m.failures} {percent(row.failureShare)} · {m.latency} {row.latencySeconds.p50 ?? "-"}/
                {row.latencySeconds.p90 ?? "-"} · {m.cost} {usd(row.costPerSuccessMicroUsd)} · {m.downloads} {row.signals.download ?? 0}
                {row.helpfulShare !== null ? ` · ${m.helpful} ${percent(row.helpfulShare)}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );

  return (
    <AdminTile
      data-testid="admin-image-routing-optimizer"
      title={
        <span className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-blue-300" aria-hidden />
          {m.title}
        </span>
      }
      description={m.description}
    >
      <p className="text-xs font-bold text-blue-300">{m.target}</p>
      {state && !state.imageTriageOn ? <p className="text-xs text-amber-300">{m.triageOff}</p> : null}

      <h3 className="text-sm font-bold text-zinc-200">{m.reportTitle}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {report(m.reportDay, state?.report.day ?? null, "admin-image-routing-optimizer-report-day")}
        {report(m.reportWeek, state?.report.week ?? null, "admin-image-routing-optimizer-report-week")}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <AdminWriteButton
          {...writeProps}
          variant="secondary"
          onClick={() => void send({ action: "run" })}
          disabled={!state?.optimizerModelId || !state.imageTriageOn || busy || running}
          data-testid="admin-image-routing-optimizer-run"
        >
          {running || busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {running ? m.running : m.run}
        </AdminWriteButton>
      </div>
      <p className="text-xs text-zinc-500">{m.modelNote}</p>

      <fieldset className="flex flex-wrap items-center gap-4" data-testid="admin-image-routing-optimizer-automation">
        <legend className="mb-2 text-xs font-bold text-zinc-300">{m.automationTitle}</legend>
        {(["daily", "autoPromote", "modelEval"] as const).map((key) => (
          <label key={key} className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={automation[key]}
              disabled={!state || busy || !canWrite}
              onChange={(event) => setAutomation({ ...automation, [key]: event.target.checked })}
              data-testid={`admin-image-routing-optimizer-${key}`}
              className="h-5 w-5"
            />
            {m[key]}
          </label>
        ))}
        <AdminWriteButton
          {...writeProps}
          variant="secondary"
          onClick={() => void send({ action: "set_automation", ...automation })}
          disabled={!state || busy || !changed}
          data-testid="admin-image-routing-optimizer-automation-save"
        >
          {m.save}
        </AdminWriteButton>
        <p className="w-full text-xs text-zinc-500">{m.automationNote}</p>
      </fieldset>

      {refusal ? <p role="status" className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{reason(refusal)}</p> : null}
      {failure ? <AdminApiFailureNotice failure={failure} onRetry={() => void load()} /> : null}

      {state ? (
        <div className="rounded-2xl border border-zinc-800 p-4" data-testid="admin-image-routing-optimizer-active">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-zinc-200">
              {m.activeTitle}:{" "}
              <span className="font-medium text-zinc-300">{state.active.cycleId ? `${m.activePromoted} ${state.active.cycleId}` : m.activeDefault}</span>
            </p>
            <AdminWriteButton
              {...writeProps}
              variant="secondary"
              onClick={() => setConfirming({ kind: "roll_back" })}
              disabled={busy || !state.active.canRollBack}
              data-testid="admin-image-routing-optimizer-roll-back"
            >
              {m.rollBack}
            </AdminWriteButton>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.showGuidance}</summary>
            <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-300">{state.active.guidance}</pre>
          </details>
        </div>
      ) : null}

      <h3 className="text-sm font-bold text-zinc-200">{m.cyclesTitle(state?.listedCycles ?? 10)}</h3>
      {state && state.cycles.length === 0 ? <p className="text-sm text-zinc-500">{m.noCycles}</p> : null}
      <ul className="flex flex-col gap-3">
        {state?.cycles.map((cycle) => (
          <li key={cycle.id} data-testid="admin-image-routing-optimizer-cycle" className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 font-bold text-zinc-100">
                {formatAestDateTime(cycle.createdAt, { seconds: true }) ?? "-"}
                <AdminStatusChip tone={optimizerCycleTone(cycle.status)}>{status(cycle.status)}</AdminStatusChip>
                {cycle.promotedAt ? <AdminStatusChip tone="info">{m.promoted}</AdminStatusChip> : null}
              </span>
              {cycle.promotable && !cycle.promotedAt ? (
                <AdminWriteButton
                  {...writeProps}
                  onClick={() => setConfirming({ kind: "promote", cycleId: cycle.id })}
                  disabled={busy}
                  data-testid="admin-image-routing-optimizer-promote"
                >
                  {m.promote}
                </AdminWriteButton>
              ) : null}
            </div>
            {cycle.failure ? <p className="mt-1 text-xs text-amber-300">{reason(cycle.failure)}</p> : null}
            {cycle.summary?.intent ? (
              <p className="mt-1 text-xs text-zinc-400">
                {m.intent}: {m.current} {cycle.summary.intent.incumbent.correct}/{cycle.summary.intent.incumbent.cases} {m.correct} (
                {m.falseImage} {cycle.summary.intent.incumbent.falseImage})
                {cycle.summary.intent.candidate
                  ? ` · ${m.proposed} ${cycle.summary.intent.candidate.correct}/${cycle.summary.intent.candidate.cases} ${m.correct} (${m.falseImage} ${cycle.summary.intent.candidate.falseImage})`
                  : ""}
              </p>
            ) : null}
            {cycle.summary?.agreement && cycle.summary.agreement.incumbent.judged > 0 ? (
              <p className="mt-1 text-xs text-zinc-400">
                {m.agreement}: {m.current} {cycle.summary.agreement.incumbent.agreed}/{cycle.summary.agreement.incumbent.judged} · {m.proposed}{" "}
                {cycle.summary.agreement.candidate.agreed}/{cycle.summary.agreement.candidate.judged}
              </p>
            ) : null}
            {cycle.summary?.report && cycle.summary.report.findings.length > 0 ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-300">
                {cycle.summary.report.findings.map((finding, index) => (
                  <li key={index}>{finding}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-1 text-xs text-zinc-500">
              {cycle.optimizerModelId} · {m.spent} {usd(cycle.spentMicroUsd)}
            </p>
            {cycle.candidateGuidance ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.showGuidance}</summary>
                <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-300">{cycle.candidateGuidance}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>

      <AdminConfirmDialog
        open={confirming !== null}
        title={confirming?.kind === "promote" ? m.confirm.promoteTitle : m.confirm.rollBackTitle}
        summary={confirming?.kind === "promote" ? m.confirm.promoteSummary : m.confirm.rollBackSummary}
        effects={[confirming?.kind === "promote" ? m.confirm.promoteEffect : m.confirm.rollBackEffect]}
        confirmLabel={confirming?.kind === "promote" ? m.promote : m.rollBack}
        busy={busy}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target?.kind === "promote") void send({ action: "promote", cycleId: target.cycleId });
          else if (target?.kind === "roll_back") void send({ action: "roll_back" });
        }}
      />
    </AdminTile>
  );
}
