"use client";

import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { SupportTriageHealth } from "@/lib/supportTriageCycle";

type TraceAnalysisMode = "off" | "analyze" | "fix";

const PAGE_PATH = "/admin/support?tab=feedback";
const ROUTE = "/api/admin/support-triage/llm-model";

type Option = { id: string; name: string; provider: string };
type Messages = (typeof adminFeedbackInboxMessages)["en"];

const runLine = (run: SupportTriageHealth["worker"], m: Messages) =>
  run ? `${new Date(run.at).toLocaleString()} (${run.outcome})` : m.triageHealthNever;

/** The last runs, today's counts and the overdue warning. Hook-free, so a render test can walk it. */
export function SupportTriageHealthLine({ health, m }: { health: SupportTriageHealth; m: Messages }) {
  return (
    <div className="mt-3 text-xs leading-5 text-zinc-400" data-testid="support-triage-health">
      <p>
        {m.triageHealthWorker}: {runLine(health.worker, m)} · {m.triageHealthRetention}: {runLine(health.retention, m)}
      </p>
      <p>
        {m.triageHealthReportsToday}: {health.reportsToday} · {m.triageHealthFailedToday}: {health.failedRunsToday}
      </p>
      {health.stale ? (
        <p role="alert" className="text-amber-300" data-testid="support-triage-health-stale">
          {m.triageHealthStale}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Which model the support-triage LLM step uses. Saving needs the owner and a
 * recent sign-in; a stale sign-in is answered with the way back. "Off" is
 * saved as a choice, so the environment variable cannot turn the step back on;
 * the variable applies only while nothing has been saved here, and an
 * inherited model can always be saved so the owner can pin Off over it.
 */
export function SupportTriageModelPanel() {
  const m = useAdminMessages(adminFeedbackInboxMessages);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enabledSource, setEnabledSource] = useState<"admin" | "environment" | null>(null);
  const [modelSource, setModelSource] = useState<"admin" | "environment" | null>(null);
  const [health, setHealth] = useState<SupportTriageHealth | null>(null);
  const [traceAnalysis, setTraceAnalysis] = useState<TraceAnalysisMode | null>(null);
  const [traceCasesEnabled, setTraceCasesEnabled] = useState(true);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await adminFetch(ROUTE);
        const payload = (await response.json()) as {
          modelId?: string | null;
          modelSource?: "admin" | "environment";
          options?: Option[];
          enabled?: boolean;
          enabledSource?: "admin" | "environment";
          health?: SupportTriageHealth;
          traceAnalysis?: TraceAnalysisMode;
          traceCasesEnabled?: boolean;
        };
        if (!live) return;
        if (!response.ok || !Array.isArray(payload.options)) {
          setNotice({ tone: "error", text: m.triageModelLoadFailed });
          return;
        }
        setOptions(payload.options);
        setSaved(payload.modelId ?? null);
        setChoice(payload.modelId ?? "");
        setModelSource(payload.modelSource ?? null);
        setEnabled(payload.enabled ?? null);
        setEnabledSource(payload.enabledSource ?? null);
        setHealth(payload.health ?? null);
        setTraceAnalysis(payload.traceAnalysis ?? null);
        setTraceCasesEnabled(payload.traceCasesEnabled !== false);
      } catch {
        if (live) setNotice({ tone: "error", text: m.triageModelLoadFailed });
      }
    })();
    return () => {
      live = false;
    };
  }, [m.triageModelLoadFailed]);

  const put = async (body: { modelId?: string | null; enabled?: boolean; traceAnalysis?: TraceAnalysisMode }) => {
    setBusy(true);
    setNotice(null);
    setReauthenticationRequired(false);
    try {
      const response = await adminFetch(ROUTE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        modelId?: string | null;
        enabled?: boolean;
        traceAnalysis?: TraceAnalysisMode;
      };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (!response.ok) {
        setNotice({ tone: "error", text: response.status === 403 ? m.triageModelOwnerOnly : m.triageModelSaveFailed });
        return;
      }
      if (body.modelId !== undefined) {
        setSaved(payload.modelId ?? null);
        setModelSource("admin");
      }
      if (typeof payload.enabled === "boolean") {
        setEnabled(payload.enabled);
        setEnabledSource("admin");
      }
      if (payload.traceAnalysis) setTraceAnalysis(payload.traceAnalysis);
      setNotice({ tone: "ok", text: m.triageModelSaved });
    } catch {
      setNotice({ tone: "error", text: m.triageModelSaveFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4"
      data-testid="support-triage-model-panel"
      aria-labelledby="support-triage-model-title"
    >
      <h2 id="support-triage-model-title" className="text-sm font-bold text-white">
        {m.triageModelTitle}
      </h2>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{m.triageModelHelp}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-200">
          {enabled === null ? m.triageSwitchUnknown : enabled ? m.triageSwitchOn : m.triageSwitchOff}
        </span>
        {enabledSource ? (
          <span className="text-xs text-zinc-500">
            {enabledSource === "admin" ? m.triageSwitchFromAdmin : m.triageSwitchFromEnvironment}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="support-triage-switch"
          onClick={() => void put({ enabled: !enabled })}
          disabled={enabled === null || busy}
          className="min-h-11 rounded-xl border border-zinc-700 px-4 text-sm font-bold text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
        >
          {enabled ? m.triageSwitchTurnOff : m.triageSwitchTurnOn}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="support-triage-model-select">
          {m.triageModelTitle}
        </label>
        <select
          id="support-triage-model-select"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          disabled={options === null || busy}
          className="min-h-11 min-w-64 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
        >
          <option value="">{m.triageModelOff}</option>
          {(options ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({option.provider})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void put({ modelId: choice === "" ? null : choice })}
          disabled={options === null || busy || (choice === (saved ?? "") && (modelSource === "admin" || saved === null))}
          className="min-h-11 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 text-sm font-bold text-blue-100 transition hover:bg-blue-500/20 disabled:opacity-50"
        >
          {m.triageModelSave}
        </button>
        {modelSource === "admin" || saved !== null ? (
          <span className="text-xs text-zinc-500" data-testid="support-triage-model-source">
            {modelSource === "admin" ? m.triageSwitchFromAdmin : m.triageSwitchFromEnvironment}
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
        <label className="text-sm text-zinc-200" htmlFor="trace-analysis-mode">
          {m.traceAnalysisModeLabel}
        </label>
        <select
          id="trace-analysis-mode"
          data-testid="trace-analysis-mode"
          value={traceAnalysis ?? "off"}
          onChange={(event) => void put({ traceAnalysis: event.target.value as TraceAnalysisMode })}
          disabled={traceAnalysis === null || busy}
          className="min-h-11 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
        >
          <option value="off">{m.traceAnalysisModes.off}</option>
          <option value="analyze">{m.traceAnalysisModes.analyze}</option>
          <option value="fix">{m.traceAnalysisModes.fix}</option>
        </select>
        <p className="w-full text-xs leading-5 text-zinc-400">{m.traceAnalysisHelp}</p>
        {traceCasesEnabled ? null : (
          <p role="alert" className="w-full text-xs leading-5 text-amber-300" data-testid="trace-analysis-no-cases">
            {m.traceAnalysisNoCases}
          </p>
        )}
      </div>
      {health ? <SupportTriageHealthLine health={health} m={m} /> : null}
      {reauthenticationRequired ? (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.triageModelReauthenticate}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.triageModelSignInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={`mt-2 text-sm ${notice.tone === "ok" ? "text-zinc-200" : "text-red-300"}`}>
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
