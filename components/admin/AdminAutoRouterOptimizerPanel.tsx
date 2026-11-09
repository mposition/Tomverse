"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { ResponseLatencyEvidenceView } from "@/components/admin/ResponseLatencyEvidenceView";
import type { ResponseLatencyEvidence } from "@/lib/responseLatencyCore";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { optimizerCycleTone } from "@/components/admin/routing/optimizerTone";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";
import {
  describeAdminApiFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AutoRouterTunables, type TunableAction, type TunableSettingsState } from "@/components/admin/AdminAutoRouterTunables";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import {
  OpenRecommendationsInbox,
  RecommendationControls,
  optimizerCycleAnchor,
  recommendationKey,
  type RecommendationSendState,
} from "@/components/admin/AdminAutoRouterRecommendations";
import {
  actionableRecommendations,
  type RecommendationStatus,
} from "@/lib/autoRouterRecommendationsCore";

type Summary = {
  responseLatency?: ResponseLatencyEvidence;
  evaluated: number;
  unchanged: number;
  candidateWins: number;
  incumbentWins: number;
  ties: number;
  /** Absent on a cycle recorded before answers were judged. */
  undecided?: number;
  /** Judge calls that returned no verdict; absent on older cycles. */
  judgeFailed?: number;
  incumbentCredits: number;
  candidateCredits: number;
  /** Absent on a cycle recorded before the direct comparison and the report. */
  report?: {
    findings: string[];
    recommendations: { kind: string; text: string }[];
  } | null;
  comparisons?: { kind: string | null; a: string | null; b: string | null; verdict: string }[];
  gate?: { basis: "judged" | "direct"; towardWinner: number; towardLoser: number } | null;
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
  syntheticCases?: {
    message: string;
    kind: "easy" | "hard" | null;
    incumbentPick: string | null;
    candidatePick: string | null;
    verdict: string;
  }[];
};

type OptimizerState = {
  optimizerModelId: string | null;
  automation: { daily: boolean; autoPromote: boolean };
  options: { id: string; name: string; provider: string }[];
  active: { cycleId: string | null; guidance: string; canRollBack: boolean };
  cycles: Cycle[];
  spend: {
    todayMicroUsd: number;
    monthMicroUsd: number;
    runCapMicroUsd: number;
    dayCapMicroUsd: number;
    monthCapMicroUsd: number;
  };
  /** The optimizer's own setting changes; absent from an older server. */
  settings?: TunableSettingsState;
  /** The coding agent on the Ubuntu runner; absent from an older server. */
  recAgent?: { enabled: boolean };
};

type Action =
  | { action: "set_model"; modelId: string | null }
  | { action: "run" }
  | { action: "set_automation"; daily: boolean; autoPromote: boolean }
  | { action: "promote"; cycleId: string }
  | { action: "roll_back" }
  | TunableAction
  | { action: "set_recommendation"; cycleId: string; index: number; status: RecommendationStatus }
  | { action: "set_rec_agent"; enabled: boolean };

const OFF = "";
const ENDPOINT = "/api/admin/auto-llm-router/optimizer";
const SEND_ENDPOINT = `${ENDPOINT}/recommendations/send`;
const usd = (micro: number) => `US$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

/**
 * Runs, promotes and rolls back Auto router guidance cycles. Shows counts
 * only: the decisions a cycle replayed are users' messages, and none of them
 * reach this screen.
 */
export function AdminAutoRouterOptimizerPanel({
  canSendToAmux,
  canWrite = true,
}: {
  canSendToAmux: boolean;
  /** Draws the controls locked with the access they need; the route still decides. */
  canWrite?: boolean;
}) {
  const m = useAdminMessages(adminAutoRouterOptimizerMessages);
  const screens = useAdminMessages(adminRoutingScreensMessages);
  const [confirming, setConfirming] = useState<
    { kind: "promote"; cycleId: string } | { kind: "roll_back" } | null
  >(null);
  const { locale: apiLocale } = useAdminLocale();
  const [state, setState] = useState<OptimizerState | null>(null);
  const [draft, setDraft] = useState(OFF);
  const [automation, setAutomation] = useState({ daily: false, autoPromote: false });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [sendState, setSendState] = useState<RecommendationSendState>({ sendingKey: null, failure: null });

  const apply = useCallback((next: OptimizerState) => {
    setState(next);
    setDraft(next.optimizerModelId ?? OFF);
    setAutomation(next.automation);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await adminFetch(ENDPOINT);
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.loadFailed, locale: apiLocale }));
        return;
      }
      apply((await response.json()) as OptimizerState);
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
      apply((await response.json()) as OptimizerState);
    } catch {
      setFailure(describeAdminApiFailure({ status: 0, fallback: m.actionFailed, locale: apiLocale }));
    } finally {
      setBusy(false);
    }
  };

  const setRecommendation = (cycleId: string, index: number, status: RecommendationStatus) =>
    void send({ action: "set_recommendation", cycleId, index, status });

  const reason = (code: string | null) =>
    code ? (m.reasons as Record<string, string>)[code] ?? code : null;

  const sendToAmux = async (cycleId: string, index: number) => {
    const key = recommendationKey(cycleId, index);
    let refused: AdminApiFailure | null = null;
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    setSendState({ sendingKey: key, failure: null });
    try {
      const response = await adminFetch(SEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycleId, index }),
      });
      if (!response.ok) {
        // The send route answers its refusals with a code.
        const failed = await readAdminApiFailure(response, { fallback: m.actionFailed, locale: apiLocale });
        refused = { ...failed, message: reason(failed.message) ?? failed.message };
      }
    } catch {
      refused = describeAdminApiFailure({ status: 0, fallback: m.actionFailed, locale: apiLocale });
    } finally {
      // Refused or not, show what is stored now: a send that stopped part-way has its own status.
      await load();
      setSendState({ sendingKey: null, failure: refused ? { key, failure: refused } : null });
      setBusy(false);
    }
  };

  const status = (value: string) => (m.statuses as Record<string, string>)[value] ?? value;
  const verdict = (value: string) => (m.verdicts as Record<string, string>)[value] ?? value;
  const comparisonVerdict = (value: string) =>
    (m.comparisonVerdicts as Record<string, string>)[value] ?? value;
  const recommendationKind = (value: string) =>
    (m.recommendationKinds as Record<string, string>)[value] ?? value;

  const locked = !canWrite;
  const writeProps = { writable: canWrite, requiredRole: screens.needsRole } as const;
  const confirmCopy = screens.confirm.router;

  return (
    <AdminTile
      data-testid="admin-auto-router-optimizer"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-blue-300" aria-hidden />
          {m.title}
        </span>
      }
      description={m.description}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-64 flex-col gap-1 text-xs font-bold text-zinc-300">
          {m.modelLabel}
          <select
            value={draft}
            disabled={!state || busy || locked}
            onChange={(event) => setDraft(event.target.value)}
            data-testid="admin-auto-router-optimizer-model"
            className="min-h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-medium text-zinc-100"
          >
            <option value={OFF}>{m.off}</option>
            {state?.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.provider})
              </option>
            ))}
          </select>
        </label>
        <AdminWriteButton
          {...writeProps}
          onClick={() => void send({ action: "set_model", modelId: draft === OFF ? null : draft })}
          disabled={!state || busy || draft === (state.optimizerModelId ?? OFF)}
          data-testid="admin-auto-router-optimizer-save"
        >
          {m.save}
        </AdminWriteButton>
        <AdminWriteButton
          {...writeProps}
          variant="secondary"
          onClick={() => void send({ action: "run" })}
          disabled={!state?.optimizerModelId || busy || running}
          data-testid="admin-auto-router-optimizer-run"
        >
          {running || busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {running ? m.running : m.run}
        </AdminWriteButton>
      </div>
      <p className="text-xs text-zinc-500">{m.costNote}</p>

      <fieldset className="flex flex-wrap items-center gap-4" data-testid="admin-auto-router-optimizer-automation">
        <legend className="mb-2 text-xs font-bold text-zinc-300">{m.automationTitle}</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={automation.daily}
            disabled={!state || busy || locked}
            onChange={(event) => setAutomation({ ...automation, daily: event.target.checked })}
            data-testid="admin-auto-router-optimizer-daily"
            className="h-5 w-5"
          />
          {m.daily}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={automation.autoPromote}
            disabled={!state || busy || locked}
            onChange={(event) => setAutomation({ ...automation, autoPromote: event.target.checked })}
            data-testid="admin-auto-router-optimizer-auto-promote"
            className="h-5 w-5"
          />
          {m.autoPromote}
        </label>
        <AdminWriteButton
          {...writeProps}
          variant="secondary"
          onClick={() => void send({ action: "set_automation", ...automation })}
          disabled={
            !state ||
            busy ||
            (automation.daily === state.automation.daily &&
              automation.autoPromote === state.automation.autoPromote)
          }
          data-testid="admin-auto-router-optimizer-automation-save"
        >
          {m.save}
        </AdminWriteButton>
        <p className="w-full text-xs text-zinc-500">{m.automationNote}</p>
      </fieldset>

      {state ? (
        <p className="text-xs text-zinc-400" data-testid="admin-auto-router-optimizer-spend">
          {m.spend}: {usd(state.spend.todayMicroUsd)} {m.today} · {usd(state.spend.monthMicroUsd)} {m.month} ·{" "}
          {m.caps} {usd(state.spend.runCapMicroUsd)} / {usd(state.spend.dayCapMicroUsd)} / {usd(state.spend.monthCapMicroUsd)}
        </p>
      ) : null}

      {refusal ? (
        <p role="status" className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {reason(refusal)}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} onRetry={() => void load()} /> : null}

      <AutoRouterTunables settings={state?.settings} busy={busy} send={(action) => void send(action)} />

      {state ? (
        <div className="rounded-2xl border border-zinc-800 p-4" data-testid="admin-auto-router-optimizer-active">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-zinc-200">
              {m.activeTitle}:{" "}
              <span className="font-medium text-zinc-300">
                {state.active.cycleId ? `${m.activePromoted} ${state.active.cycleId}` : m.activeDefault}
              </span>
            </p>
            <AdminWriteButton
              {...writeProps}
              variant="secondary"
              onClick={() => setConfirming({ kind: "roll_back" })}
              disabled={busy || !state.active.canRollBack}
              data-testid="admin-auto-router-optimizer-roll-back"
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

      {state ? (
        <label
          className="flex min-h-11 items-center gap-2 text-sm text-zinc-300"
          data-testid="admin-auto-router-rec-agent"
        >
          <input
            type="checkbox"
            checked={state.recAgent?.enabled === true}
            disabled={busy || !state.recAgent || locked}
            onChange={(event) => void send({ action: "set_rec_agent", enabled: event.target.checked })}
            data-testid="admin-auto-router-rec-agent-toggle"
            className="h-5 w-5"
          />
          <span>
            <span className="font-bold">{m.recAgentLabel}</span>
            <span className="block text-xs text-zinc-500">{m.recAgentNote}</span>
          </span>
        </label>
      ) : null}

      {state ? (
        <OpenRecommendationsInbox
          cycles={state.cycles}
          busy={busy}
          canSend={canSendToAmux}
          sendState={sendState}
          onSetStatus={setRecommendation}
          onSend={(cycleId, index) => void sendToAmux(cycleId, index)}
        />
      ) : null}

      <h3 className="text-sm font-bold text-zinc-200">{m.cyclesTitle}</h3>
      {state && state.cycles.length === 0 ? <p className="text-sm text-zinc-500">{m.noCycles}</p> : null}
      <ul className="flex flex-col gap-3">
        {state?.cycles.map((cycle) => (
          <li
            key={cycle.id}
            id={optimizerCycleAnchor(cycle.id)}
            data-testid="admin-auto-router-optimizer-cycle"
            className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 font-bold text-zinc-100">
                {formatAestDateTime(cycle.createdAt, { seconds: true }) ?? "-"}
                <AdminStatusChip tone={optimizerCycleTone(cycle.status)}>{status(cycle.status)}</AdminStatusChip>
                {cycle.promotedAt ? <AdminStatusChip tone="info">{m.promoted}</AdminStatusChip> : null}
              </span>
              {cycle.status === "passed" && !cycle.promotedAt ? (
                <AdminWriteButton
                  {...writeProps}
                  onClick={() => setConfirming({ kind: "promote", cycleId: cycle.id })}
                  disabled={busy}
                  data-testid="admin-auto-router-optimizer-promote"
                >
                  {m.promote}
                </AdminWriteButton>
              ) : null}
            </div>
            {cycle.failure ? <p className="mt-1 text-xs text-amber-300">{reason(cycle.failure)}</p> : null}
            {cycle.summary ? (
              <p className="mt-1 text-xs text-zinc-400">
                {cycle.summary.evaluated} {m.evaluated} · {cycle.summary.unchanged} {m.unchanged} ·{" "}
                {cycle.summary.candidateWins} {m.candidateWins} · {cycle.summary.incumbentWins} {m.incumbentWins} ·{" "}
                {cycle.summary.ties} {m.ties} ·{" "}
                {cycle.summary.undecided !== undefined ? `${cycle.summary.undecided} ${m.undecided} · ` : ""}
                {cycle.summary.judgeFailed ? `${cycle.summary.judgeFailed} ${m.judgeFailed} · ` : ""}
                {m.credits} {cycle.summary.incumbentCredits} → {cycle.summary.candidateCredits}
              </p>
            ) : null}
            {cycle.summary?.gate?.basis === "direct" ? (
              <p className="mt-1 text-xs text-zinc-400" data-testid="admin-auto-router-optimizer-gate-direct">
                {m.gateDirect}: {cycle.summary.gate.towardWinner} {m.towardWinner} · {cycle.summary.gate.towardLoser}{" "}
                {m.towardLoser}
              </p>
            ) : null}
            <ResponseLatencyEvidenceView evidence={cycle.summary?.responseLatency} />
            {cycle.summary?.report ? (
              <div className="mt-2 rounded-xl border border-zinc-800 p-3" data-testid="admin-auto-router-optimizer-report">
                <p className="text-xs font-bold text-zinc-300">{m.reportTitle}</p>
                {cycle.summary.report.findings.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-zinc-300">
                    {cycle.summary.report.findings.map((finding, index) => (
                      <li key={index} className="whitespace-pre-wrap">{finding}</li>
                    ))}
                  </ul>
                ) : null}
                {cycle.summary.report.recommendations.length > 0 ? (
                  <>
                    <p className="mt-2 text-xs font-bold text-zinc-300">{m.recommendationsTitle}</p>
                    <p className="mt-1 text-xs text-zinc-500">{m.recommendationHandled}</p>
                    <ul className="mt-1 space-y-1 text-xs text-zinc-300">
                      {cycle.summary.report.recommendations.map((item, index) => {
                        const actionable = actionableRecommendations(cycle.summary).find(
                          (candidate) => candidate.index === index
                        );
                        return (
                          <li key={index} className="whitespace-pre-wrap">
                            <span className="mr-1 rounded border border-zinc-600 px-1 text-[11px] text-zinc-400">
                              {recommendationKind(item.kind)}
                            </span>
                            {item.text}
                            {actionable ? (
                              <RecommendationControls
                                cycle={cycle}
                                item={actionable}
                                busy={busy}
                                canSend={canSendToAmux}
                                sendState={sendState}
                                onSetStatus={setRecommendation}
                                onSend={(cycleId, sendIndex) => void sendToAmux(cycleId, sendIndex)}
                              />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
            {cycle.summary?.comparisons && cycle.summary.comparisons.length > 0 ? (
              <details className="mt-2" data-testid="admin-auto-router-optimizer-comparisons">
                <summary className="cursor-pointer text-xs font-bold text-zinc-400">
                  {m.comparisonsTitle} ({cycle.summary.comparisons.length})
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-zinc-300">
                  {cycle.summary.comparisons.map((item, index) => (
                    <li key={index}>
                      {item.kind ? `${(m.kinds as Record<string, string>)[item.kind] ?? item.kind} · ` : ""}
                      {item.a ?? "-"} vs {item.b ?? "-"} · {comparisonVerdict(item.verdict)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {cycle.syntheticCases && cycle.syntheticCases.length > 0 ? (
              <details className="mt-2" data-testid="admin-auto-router-optimizer-synthetic">
                <summary className="cursor-pointer text-xs font-bold text-zinc-400">
                  {m.syntheticCases} ({cycle.syntheticCases.length})
                </summary>
                <ul className="mt-2 space-y-2">
                  {cycle.syntheticCases.map((item, index) => (
                    <li key={index} className="text-xs text-zinc-300">
                      <p className="whitespace-pre-wrap">{item.message}</p>
                      <p className="mt-0.5 text-zinc-500">
                        {item.kind ? `${(m.kinds as Record<string, string>)[item.kind] ?? item.kind} · ` : ""}
                        {item.incumbentPick ?? "-"} → {item.candidatePick ?? "-"} · {verdict(item.verdict)}
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

      <AdminConfirmDialog
        open={confirming !== null}
        title={confirming?.kind === "promote" ? confirmCopy.promoteTitle : confirmCopy.rollBackTitle}
        summary={confirming?.kind === "promote" ? confirmCopy.promoteSummary : confirmCopy.rollBackSummary}
        effects={[confirming?.kind === "promote" ? confirmCopy.promoteEffect : confirmCopy.rollBackEffect]}
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
