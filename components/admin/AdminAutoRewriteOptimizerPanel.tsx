"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, PencilLine } from "lucide-react";
import {
  describeAdminApiFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminAutoRewriteOptimizerMessages } from "@/lib/adminMessages/autoRewriteOptimizer";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";

type Summary = {
  evaluated: number;
  unchanged: number;
  candidateWins: number;
  incumbentWins: number;
  ties: number;
  undecided?: number;
  unrouted?: number;
};

type SyntheticCase = {
  message: string;
  previousAnswer: string;
  incumbentRewrite: string | null;
  candidateRewrite: string | null;
  answerModelId: string | null;
  verdict: string;
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
  syntheticCases: SyntheticCase[];
};

type RewriteOptimizerState = {
  optimizerModelId: string | null;
  automation: { daily: boolean; autoPromote: boolean };
  liveRewrite: boolean;
  listedCycles: number;
  active: { cycleId: string | null; guidance: string; canRollBack: boolean };
  cycles: Cycle[];
};

type Action =
  | { action: "run" }
  | { action: "set_automation"; daily: boolean; autoPromote: boolean }
  | { action: "promote"; cycleId: string }
  | { action: "roll_back" };

const ENDPOINT = "/api/admin/auto-llm-router/rewrite-optimizer";
const usd = (micro: number) => `US$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

/**
 * Runs, promotes and rolls back rewrite guidance cycles, beside the routing
 * guidance optimizer whose model, spend and caps it shares. A real turn
 * appears only as a count; only synthetic conversations are shown in full.
 */
export function AdminAutoRewriteOptimizerPanel() {
  const m = useAdminMessages(adminAutoRewriteOptimizerMessages);
  const { locale: apiLocale } = useAdminLocale();
  const [state, setState] = useState<RewriteOptimizerState | null>(null);
  const [automation, setAutomation] = useState({ daily: false, autoPromote: false });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = useCallback((next: RewriteOptimizerState) => {
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
      apply((await response.json()) as RewriteOptimizerState);
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
      const response = await adminFetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        const answer = (await response.json().catch(() => null)) as { code?: string } | null;
        setRefusal(answer?.code ?? "unknown");
        return;
      }
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.actionFailed, locale: apiLocale }));
        return;
      }
      apply((await response.json()) as RewriteOptimizerState);
    } catch {
      setFailure(describeAdminApiFailure({ status: 0, fallback: m.actionFailed, locale: apiLocale }));
    } finally {
      setBusy(false);
    }
  };

  const reason = (code: string | null) =>
    code ? (m.reasons as Record<string, string>)[code] ?? code : null;
  const status = (value: string) => (m.statuses as Record<string, string>)[value] ?? value;
  const verdict = (value: string) => (m.verdicts as Record<string, string>)[value] ?? value;

  return (
    <section
      data-testid="admin-auto-rewrite-optimizer"
      className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5"
    >
      <h2 className="flex items-center gap-2 text-base font-bold text-zinc-100">
        <PencilLine className="h-4 w-4 text-blue-300" aria-hidden />
        {m.title}
      </h2>
      <p className="mt-1 text-xs font-bold text-blue-200" data-testid="admin-auto-rewrite-optimizer-target">
        {m.target}
      </p>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{m.description}</p>
      {state ? (
        <p className="mt-2 text-xs text-zinc-400" data-testid="admin-auto-rewrite-optimizer-live">
          {state.liveRewrite ? m.liveOn : m.liveOff}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <button
          type="button"
          onClick={() => void send({ action: "run" })}
          disabled={!state?.optimizerModelId || busy || running}
          data-testid="admin-auto-rewrite-optimizer-run"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-blue-500 px-4 text-sm font-bold text-blue-200 disabled:opacity-50"
        >
          {running || busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {running ? m.running : m.run}
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-500">{m.modelNote}</p>

      <fieldset className="mt-4 flex flex-wrap items-center gap-4" data-testid="admin-auto-rewrite-optimizer-automation">
        <legend className="mb-2 text-xs font-bold text-zinc-300">{m.automationTitle}</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={automation.daily}
            disabled={!state || busy}
            onChange={(event) => setAutomation({ ...automation, daily: event.target.checked })}
            data-testid="admin-auto-rewrite-optimizer-daily"
            className="h-5 w-5"
          />
          {m.daily}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={automation.autoPromote}
            disabled={!state || busy}
            onChange={(event) => setAutomation({ ...automation, autoPromote: event.target.checked })}
            data-testid="admin-auto-rewrite-optimizer-auto-promote"
            className="h-5 w-5"
          />
          {m.autoPromote}
        </label>
        <button
          type="button"
          onClick={() => void send({ action: "set_automation", ...automation })}
          disabled={
            !state ||
            busy ||
            (automation.daily === state.automation.daily &&
              automation.autoPromote === state.automation.autoPromote)
          }
          data-testid="admin-auto-rewrite-optimizer-automation-save"
          className="min-h-11 rounded-xl border border-zinc-600 px-4 text-sm font-bold text-zinc-200 disabled:opacity-50"
        >
          {m.save}
        </button>
        <p className="w-full text-xs text-zinc-500">{m.automationNote}</p>
      </fieldset>

      {refusal ? (
        <p role="status" className="mt-3 rounded-xl border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          {reason(refusal)}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} onRetry={() => void load()} /> : null}

      {state ? (
        <div className="mt-5 rounded-2xl border border-zinc-800 p-4" data-testid="admin-auto-rewrite-optimizer-active">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-zinc-200">
              {m.activeTitle}:{" "}
              <span className="font-medium text-zinc-300">
                {state.active.cycleId ? `${m.activePromoted} ${state.active.cycleId}` : m.activeDefault}
              </span>
            </p>
            <button
              type="button"
              onClick={() => void send({ action: "roll_back" })}
              disabled={busy || !state.active.canRollBack}
              data-testid="admin-auto-rewrite-optimizer-roll-back"
              className="min-h-11 rounded-xl border border-zinc-600 px-4 text-sm font-bold text-zinc-200 disabled:opacity-50"
            >
              {m.rollBack}
            </button>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.showGuidance}</summary>
            <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-300">{state.active.guidance}</pre>
          </details>
        </div>
      ) : null}

      <h3 className="mt-5 text-sm font-bold text-zinc-200">
        {m.cyclesTitle(state?.listedCycles ?? 10)}
      </h3>
      {state && state.cycles.length === 0 ? <p className="mt-2 text-sm text-zinc-500">{m.noCycles}</p> : null}
      <ul className="mt-2 space-y-3">
        {state?.cycles.map((cycle) => (
          <li
            key={cycle.id}
            data-testid="admin-auto-rewrite-optimizer-cycle"
            className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-zinc-100">
                {new Date(cycle.createdAt).toLocaleString()} · {status(cycle.status)}
                {cycle.promotedAt ? ` · ${m.promoted}` : ""}
              </span>
              {cycle.status === "passed" && !cycle.promotedAt ? (
                <button
                  type="button"
                  onClick={() => void send({ action: "promote", cycleId: cycle.id })}
                  disabled={busy}
                  data-testid="admin-auto-rewrite-optimizer-promote"
                  className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white disabled:opacity-50"
                >
                  {m.promote}
                </button>
              ) : null}
            </div>
            {cycle.failure ? <p className="mt-1 text-xs text-amber-300">{reason(cycle.failure)}</p> : null}
            {cycle.summary ? (
              <p className="mt-1 text-xs text-zinc-400">
                {cycle.summary.evaluated} {m.evaluated} · {cycle.summary.unchanged} {m.unchanged} ·{" "}
                {cycle.summary.candidateWins} {m.candidateWins} · {cycle.summary.incumbentWins} {m.incumbentWins} ·{" "}
                {cycle.summary.ties} {m.ties}
                {cycle.summary.undecided !== undefined ? ` · ${cycle.summary.undecided} ${m.undecided}` : ""}
                {cycle.summary.unrouted !== undefined ? ` · ${cycle.summary.unrouted} ${m.unrouted}` : ""}
              </p>
            ) : null}
            {cycle.syntheticCases.length > 0 ? (
              <details className="mt-2" data-testid="admin-auto-rewrite-optimizer-synthetic">
                <summary className="cursor-pointer text-xs font-bold text-zinc-400">
                  {m.syntheticCases} ({cycle.syntheticCases.length})
                </summary>
                <ul className="mt-2 space-y-3">
                  {cycle.syntheticCases.map((item, index) => (
                    <li key={index} className="space-y-1 text-xs text-zinc-300">
                      <p className="whitespace-pre-wrap text-zinc-500">
                        {m.previousAnswer}: {item.previousAnswer}
                      </p>
                      <p className="whitespace-pre-wrap">
                        {m.message}: {item.message}
                      </p>
                      <p className="whitespace-pre-wrap">
                        {m.currentRewrite}: {item.incumbentRewrite ?? m.keptAsWritten}
                      </p>
                      <p className="whitespace-pre-wrap">
                        {m.proposedRewrite}: {item.candidateRewrite ?? m.keptAsWritten}
                      </p>
                      <p className="text-zinc-500">
                        {m.answeredBy} {item.answerModelId ?? "-"} · {verdict(item.verdict)}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
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
    </section>
  );
}
