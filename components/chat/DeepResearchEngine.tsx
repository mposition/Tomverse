"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createResearchApi, filenameFromContentDisposition, type ResearchAction, type ResearchApi } from "@tomverse/api-client";
import {
  acceptResearchRunUpdate, formatResearchCopy, researchProgress, researchRunNeedsPolling, researchStatusKey, researchStartIds,
  type ResearchRunView,
} from "@tomverse/chat-core";
import { AnswerMarkdown } from "@tomverse/chat-ui";
import { researchEngineCopy } from "@/locales/researchEngine";
import type { Language } from "@/lib/language";
import { conversationHandoffHref } from "@/lib/continuationRoutes";
import { CHAT_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

/**
 * Deep Research (engine v2) on the web: the tools-menu entry, the brief sheet
 * and the run workspace. The workspace reads the same run API as Native and
 * uses the shared state rules in @tomverse/chat-core, so a late poll or an old
 * device's response never overwrites a newer state, and a lost action
 * response is read back instead of being sent again.
 */

const webApi = createResearchApi((path, init) => fetch(path, init));

type Offer = {
  offered: boolean; reason?: string;
  features?: { defaultEntry: boolean; privateSources: boolean; projectSources: boolean; maxApprovedCredits: number };
  estimate?: { lowCredits: number; highCredits: number; perCallCredits: number };
};

/** One offer read per account scope. Deterministic on the server; never calls a model. */
export function useDeepResearchEngineOffer(identityKey: string | null, enabled: boolean) {
  const [offer, setOffer] = useState<{ key: string; value: Offer } | null>(null);
  const key = enabled && identityKey ? identityKey : null;
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void webApi.offer("standard", controller.signal).then((value) => {
      if (!controller.signal.aborted) setOffer({ key, value: value as Offer });
    }).catch(() => { if (!controller.signal.aborted) setOffer({ key, value: { offered: false } }); });
    return () => controller.abort();
  }, [key]);
  return offer && offer.key === key ? offer.value : null;
}

const splitList = (value: string) => value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);

export function DeepResearchEngineSheet({ open, onClose, language, conversationId, draft, offer, api = webApi, onStarted }: {
  open: boolean; onClose: () => void; language: Language; conversationId: string | null; draft: string; offer: Offer | null;
  api?: ResearchApi; onStarted?: (conversationId: string) => void;
}) {
  const copy = researchEngineCopy[language];
  const [question, setQuestion] = useState(draft);
  const [objective, setObjective] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [languages, setLanguages] = useState("");
  const [regions, setRegions] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [urls, setUrls] = useState("");
  const [includeThisChat, setIncludeThisChat] = useState(false);
  const [profile, setProfile] = useState<"standard" | "deep">("standard");
  const [credits, setCredits] = useState(() => Math.max(50, offer?.estimate?.highCredits ?? 400));
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One identity per attempt: a lost create response is retried with the same ids and returns the same run.
  const ids = useRef(researchStartIds(() => crypto.randomUUID()));
  if (!open) return null;
  const max = offer?.features?.maxApprovedCredits ?? 2_000;
  const submit = async () => {
    setBusy(true); setError(null);
    const payload = {
      ...(conversationId ? { conversationId } : {}), ...ids.current,
      brief: { question: question.trim(), ...(objective.trim() ? { objective: objective.trim() } : {}), deliverable: "report",
        searchLanguages: splitList(languages), regions: splitList(regions).map((entry) => entry.toUpperCase()),
        ...(from || to ? { period: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
        includeDomains: splitList(include), excludeDomains: splitList(exclude), constraints: [] },
      sources: [...splitList(urls).map((url) => ({ type: "url", url })),
        ...(includeThisChat && conversationId && offer?.features?.privateSources ? [{ type: "conversation", conversationId }] : [])],
      profile, approvedCredits: Math.min(max, Math.max(1, Math.round(credits))), autoStart, locale: language,
    };
    try {
      const run = await api.create(payload) as { conversationId?: string } | undefined;
      ids.current = researchStartIds(() => crypto.randomUUID());
      onClose();
      const target = run?.conversationId ?? conversationId;
      if (target && onStarted) onStarted(target);
      else if (target) window.location.assign(conversationHandoffHref("chat", target, CHAT_WORKSPACE_PATH));
    } catch (failure) {
      setError((failure as { code?: string }).code ?? "RESEARCH_UNAVAILABLE");
    } finally { setBusy(false); }
  };
  const field = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
  return <div role="dialog" aria-modal="true" aria-labelledby="deep-research-engine-title" data-testid="deep-research-engine-sheet"
    className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
    <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl dark:bg-zinc-950 sm:rounded-2xl">
      <h2 id="deep-research-engine-title" className="mb-3 text-lg font-semibold">{copy.title}</h2>
      <label className="mb-1 block text-sm font-medium" htmlFor="dre-question">{copy.briefQuestion}</label>
      <textarea id="dre-question" data-testid="dre-question" className={`${field} min-h-28`} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={60_000} />
      <p className="mt-1 text-xs text-zinc-500">{copy.briefPublicNote}</p>
      <label className="mb-1 mt-3 block text-sm font-medium" htmlFor="dre-objective">{copy.briefObjective}</label>
      <input id="dre-objective" className={field} value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={4_000} />
      <details className="mt-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{copy.briefConditions}</summary>
        <div className="grid gap-2 sm:grid-cols-2">
          <input aria-label="from" type="date" className={field} value={from} onChange={(event) => setFrom(event.target.value)} />
          <input aria-label="to" type="date" className={field} value={to} onChange={(event) => setTo(event.target.value)} />
          <input aria-label="languages" placeholder="ko, en" className={field} value={languages} onChange={(event) => setLanguages(event.target.value)} />
          <input aria-label="regions" placeholder="KR, AU" className={field} value={regions} onChange={(event) => setRegions(event.target.value)} />
          <input aria-label="include domains" placeholder="example.gov" className={field} value={include} onChange={(event) => setInclude(event.target.value)} />
          <input aria-label="exclude domains" placeholder="example.com" className={field} value={exclude} onChange={(event) => setExclude(event.target.value)} />
        </div>
      </details>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium">{copy.briefSources}</legend>
        <textarea aria-label="urls" data-testid="dre-urls" placeholder="https://" className={`${field} mt-1 min-h-16`} value={urls} onChange={(event) => setUrls(event.target.value)} />
        {offer?.features?.privateSources && conversationId && <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={includeThisChat} onChange={(event) => setIncludeThisChat(event.target.checked)} data-testid="dre-include-chat" />
          <span>{copy.tabSources}: {copy.sourcePrivate}</span>
        </label>}
        <p className="mt-1 text-xs text-zinc-500">{copy.briefSourcesHint}</p>
      </fieldset>
      <div className="mt-3 flex gap-2" role="radiogroup">
        {(["standard", "deep"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={profile === value}
          onClick={() => setProfile(value)} className={`min-h-11 rounded-lg border px-3 text-sm ${profile === value ? "border-accent-deep-research-500 font-semibold" : "border-zinc-300 dark:border-zinc-700"}`}>
          {value === "standard" ? copy.profileStandard : copy.profileDeep}</button>)}
      </div>
      <label className="mb-1 mt-3 block text-sm font-medium" htmlFor="dre-credits">{copy.budgetLabel}</label>
      <input id="dre-credits" data-testid="dre-credits" type="number" min={1} max={max} className={field} value={credits} onChange={(event) => setCredits(Number(event.target.value))} />
      <p className="mt-1 text-xs text-zinc-500">{copy.budgetHint}</p>
      {offer?.estimate && <p className="mt-1 text-xs text-zinc-500" data-testid="dre-estimate">{formatResearchCopy(copy.estimateRange, { low: offer.estimate.lowCredits, high: offer.estimate.highCredits })}</p>}
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={!autoStart} onChange={(event) => setAutoStart(!event.target.checked)} />
        <span>{copy.planTitle}: {copy.planEdit}</span>
      </label>
      <p className="text-xs text-zinc-500">{copy.planCost}</p>
      {error && <p role="alert" className="mt-2 text-sm text-red-600" data-testid="dre-error">{copy.actionFailed} ({error})</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="min-h-11 rounded-lg px-4 text-sm" onClick={onClose} disabled={busy}>{copy.cancel}</button>
        <button type="button" data-testid="dre-submit" className="min-h-11 rounded-lg bg-accent-deep-research-500 px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy || !question.trim()} onClick={() => void submit()}>{autoStart ? copy.start : copy.makePlan}</button>
      </div>
    </div>
  </div>;
}

type Tab = "plan" | "progress" | "sources" | "report";

/** The run workspace. Polls only while the server may change the run on its own. */
export function ResearchWorkspace({ runId, conversationId, language, accountKey, api = webApi, onReportChanged }: {
  runId: string; conversationId: string; language: Language; accountKey: string; api?: ResearchApi;
  /** Called when the run settles or its report revision changes, so the chat answer can be read again. */
  onReportChanged?: () => void;
}) {
  const copy = researchEngineCopy[language];
  const scope = useMemo(() => ({ runId, conversationId, accountKey }), [runId, conversationId, accountKey]);
  const [view, setView] = useState<{ scopeKey: string; run: ResearchRunView | null }>({ scopeKey: "", run: null });
  const scopeKey = `${accountKey}:${conversationId}:${runId}`;
  const run = view.scopeKey === scopeKey ? view.run : null;
  const [tab, setTab] = useState<Tab>("progress");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sources, setSources] = useState<Array<Record<string, unknown>>>([]);
  const [report, setReport] = useState<{ markdown: string; revision: number; revisions: Array<{ revision: number; author: string }>; containsPrivate: boolean;
    claims?: Array<{ claimKey: string; text: string; verification: string; evidence: Array<{ sourceKey: string; chunkId?: string; level: string; start: number; end: number }> }> } | null>(null);
  const [evidence, setEvidence] = useState<{ key: string; text: string; sourceKey: string; highlight: { start: number; end: number }; url: string | null } | null>(null);
  const openEvidence = async (claimKey: string, span: { sourceKey: string; chunkId?: string; start: number; end: number }) => {
    if (!span.chunkId) return;
    try {
      const value = await api.evidence(runId, span.chunkId, span.start, span.end) as { text: string; sourceKey: string; highlight: { start: number; end: number }; url: string | null };
      setEvidence({ key: `${claimKey}:${span.chunkId}`, ...value });
    } catch { setNotice(copy.actionFailed); }
  };
  const [instruction, setInstruction] = useState("");
  const [scopeQuestion, setScopeQuestion] = useState("");
  const publish = useCallback((incoming: unknown) => {
    setView((previous) => ({ scopeKey, run: acceptResearchRunUpdate(previous.scopeKey === scopeKey ? previous.run : null, incoming, scope) }));
  }, [scope, scopeKey]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    let active = true;
    const controller = new AbortController();
    const read = async () => {
      clearTimeout(timer.current);
      try {
        const value = await api.read(runId, controller.signal);
        if (!active) return;
        publish(value);
        const current = acceptResearchRunUpdate(null, value, scope);
        if (current && researchRunNeedsPolling(current)) timer.current = setTimeout(() => void read(), 4_000);
      } catch { if (active) timer.current = setTimeout(() => void read(), 10_000); }
    };
    void read();
    return () => { active = false; controller.abort(); clearTimeout(timer.current); };
  }, [runId, scope, publish, api]);
  const reportChanged = useRef(onReportChanged);
  useLayoutEffect(() => { reportChanged.current = onReportChanged; }, [onReportChanged]);
  const settledKey = run ? `${run.currentReportRevision ?? 0}:${researchRunNeedsPolling(run) ? "open" : run.status}` : null;
  const seenSettledKey = useRef<string | null>(null);
  useEffect(() => {
    if (!settledKey) return;
    // The first view is what the chat already shows; later changes refresh it.
    if (seenSettledKey.current !== null && seenSettledKey.current !== settledKey) reportChanged.current?.();
    seenSettledKey.current = settledKey;
  }, [settledKey]);
  const act = async (action: ResearchAction) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    const result = await api.act(runId, action);
    publish(result.run);
    if (result.readback) setNotice(copy.actionFailed);
    setBusy(false);
  };
  useEffect(() => {
    if (tab !== "sources" || !run) return;
    let active = true;
    void api.sources(runId).then((value) => { if (active) setSources(((value as { sources?: Array<Record<string, unknown>> }).sources) ?? []); }).catch(() => undefined);
    return () => { active = false; };
  }, [tab, runId, run?.progress.sourcesSeen, run, api]);
  useEffect(() => {
    if (tab !== "report" || !run?.currentReportRevision) return;
    let active = true;
    void api.report(runId).then((value) => { if (active) setReport(value as never); }).catch(() => undefined);
    return () => { active = false; };
  }, [tab, runId, run?.currentReportRevision, api]);
  const download = async (format: "md" | "pdf" | "docx" | "csv" | "xlsx") => {
    try {
      const file = await api.exportFile(runId, format);
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filenameFromContentDisposition(file.disposition, `research.${format}`);
      anchor.click(); URL.revokeObjectURL(url);
    } catch { setNotice(copy.actionFailed); }
  };
  if (!run) return <div className="research-run-card" data-testid="research-workspace" data-run-status="loading"><p role="status">{copy.title}</p></div>;
  const progress = researchProgress(run);
  const tabs: Tab[] = ["plan", "progress", "sources", "report"];
  const tabLabel = { plan: copy.tabPlan, progress: copy.tabProgress, sources: copy.tabSources, report: copy.tabReport };
  const qualityLabel = run.qualityStatus === "complete" ? copy.qualityComplete : run.qualityStatus === "partial" ? copy.qualityPartial
    : run.qualityStatus === "insufficient_evidence" ? copy.qualityInsufficient : null;
  const button = "min-h-11 rounded-lg border border-zinc-300 px-3 text-sm disabled:opacity-50 dark:border-zinc-700";
  return <section className="research-run-card space-y-3" data-testid="research-workspace" data-run-status={run.status} data-event-sequence={run.eventSequence} aria-label={copy.title}>
    <header className="flex flex-wrap items-center gap-2">
      <strong>{copy.title}</strong>
      <span role="status" data-testid="research-workspace-status">{copy[researchStatusKey(run.status)]}</span>
      {qualityLabel && <span data-testid="research-workspace-quality" className="rounded bg-zinc-100 px-2 text-xs dark:bg-zinc-800">{qualityLabel}</span>}
    </header>
    <p className="text-xs text-zinc-500" data-testid="research-workspace-money">{formatResearchCopy(copy.moneyLine, {
      settled: run.money.settledCredits, reserved: run.money.reservedCredits, unknown: run.money.unknownCredits, approved: run.money.approvedCredits })}
      {run.money.settlement === "pending" ? ` · ${copy.settlementPending}` : run.money.settlement === "unknown" ? ` · ${copy.settlementUnknown}` : ""}</p>
    <div className="flex flex-wrap gap-2">
      {run.actions.canPause && <button type="button" className={button} disabled={busy} data-testid="research-pause" onClick={() => void act({ kind: "pause" })}>{copy.pause}</button>}
      {run.actions.canResume && <button type="button" className={button} disabled={busy} data-testid="research-resume" onClick={() => void act({ kind: "resume" })}>{copy.resume}</button>}
      {run.actions.canFinish && <button type="button" className={button} disabled={busy} data-testid="research-finish" onClick={() => void act({ kind: "finish" })}>{copy.finishNow}</button>}
      {run.actions.canCancel && <button type="button" className={button} disabled={busy} data-testid="research-cancel" onClick={() => void act({ kind: "cancel" })}>{copy.cancel}</button>}
      {run.actions.canExtendBudget && <button type="button" className={button} disabled={busy} data-testid="research-extend"
        onClick={() => { const next = run.money.approvedCredits + Math.max(50, Math.ceil(run.money.approvedCredits / 2));
          if (window.confirm(formatResearchCopy(copy.extendBudgetConfirm, { credits: next }))) void act({ kind: "budget", expectedApprovedCredits: run.money.approvedCredits, approvedCredits: next }); }}>{copy.extendBudget}</button>}
    </div>
    {run.budgetReached && <p role="status" className="text-sm font-medium" data-testid="research-budget-reached">{copy.budgetReached}</p>}
    {notice && <p role="alert" className="text-sm">{notice}</p>}
    <div role="tablist" className="flex gap-1 overflow-x-auto">
      {tabs.map((entry) => <button key={entry} type="button" role="tab" aria-selected={tab === entry} data-testid={`research-tab-${entry}`}
        onClick={() => setTab(entry)} className={`min-h-11 rounded-lg px-3 text-sm ${tab === entry ? "bg-zinc-100 font-semibold dark:bg-zinc-800" : ""}`}>{tabLabel[entry]}</button>)}
    </div>
    {tab === "plan" && <div data-testid="research-plan">
      {!run.plan ? <p>{copy.statusPlanning}</p> : <>
        <p className="font-medium">{run.plan.plan.objective}</p>
        {run.plan.plan.clarifications.length > 0 && <><h4 className="mt-2 text-sm font-semibold">{copy.planClarifications}</h4>
          <ul className="list-disc pl-5 text-sm">{run.plan.plan.clarifications.map((entry, index) => <li key={index}>{entry.question}</li>)}</ul></>}
        <h4 className="mt-2 text-sm font-semibold">{copy.planAssumptions}</h4>
        <ul className="list-disc pl-5 text-sm">{run.plan.plan.assumptions.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
        <h4 className="mt-2 text-sm font-semibold">{copy.planSubquestions}</h4>
        <ol className="list-decimal pl-5 text-sm">{run.plan.plan.subquestions.map((entry) => <li key={entry.key}>{entry.question}</li>)}</ol>
        <h4 className="mt-2 text-sm font-semibold">{copy.planOutline}</h4>
        <ol className="list-decimal pl-5 text-sm">{run.plan.plan.outline.map((entry) => <li key={entry.key}>{entry.heading}</li>)}</ol>
        <h4 className="mt-2 text-sm font-semibold">{copy.planCriteria}</h4>
        <ul className="list-disc pl-5 text-sm">{run.plan.plan.completionCriteria.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
      </>}
      {(run.status === "draft" || (run.status === "awaiting_input" && !run.approvedPlanRevision)) && <div className="mt-3 space-y-2">
        <textarea aria-label={copy.planFeedback} className="w-full rounded-lg border border-zinc-300 p-2 text-sm dark:border-zinc-700" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy} data-testid="research-plan-request"
            onClick={() => void act({ kind: "plan", expectedPlanRevision: run.planRevision, ...(instruction.trim() ? { feedback: instruction.trim() } : {}) })}>{run.plan ? copy.planFeedback : copy.makePlan}</button>
          {run.actions.canApprovePlan && run.plan && <button type="button" className={`${button} font-semibold`} disabled={busy} data-testid="research-plan-approve"
            onClick={() => void act({ kind: "approve", planRevision: run.planRevision })}>{copy.planApprove}</button>}
        </div>
        <p className="text-xs text-zinc-500">{copy.planCost}</p>
      </div>}
    </div>}
    {tab === "progress" && <div data-testid="research-progress">
      {progress.hasCounts && <p className="text-sm" data-testid="research-progress-items">{formatResearchCopy(copy.progressItems, { done: progress.done, total: progress.total })}</p>}
      <p className="text-sm">{formatResearchCopy(copy.progressSources, { seen: run.progress.sourcesSeen, read: run.progress.sourcesRead, private: run.progress.privateSources })}</p>
      <ul className="mt-2 space-y-1 text-sm">{run.progress.questions.map((question) => <li key={question.key} data-state={question.state}>
        <span className="font-medium">{question.question}</span> · {copy[question.state === "done" ? "statusCompleted" : question.state === "attention" ? "statusAttention" : question.state === "active" ? "statusRunning" : "statusQueued"]} · {formatResearchCopy(copy.progressQuestion, { findings: question.findings })}</li>)}</ul>
      {!["completed", "failed", "cancelled", "attention"].includes(run.status) && run.approvedPlanRevision && <div className="mt-3 flex flex-wrap gap-2">
        <input aria-label={copy.scopeAddQuestion} placeholder={copy.scopeAddQuestion} className="min-h-11 flex-1 rounded-lg border border-zinc-300 px-2 text-sm dark:border-zinc-700" value={scopeQuestion} onChange={(event) => setScopeQuestion(event.target.value)} />
        <button type="button" className={button} disabled={busy || !scopeQuestion.trim()} data-testid="research-scope-save"
          onClick={() => { void act({ kind: "scope", expectedInputRevision: run.inputRevision, addQuestions: [scopeQuestion.trim()] }); setScopeQuestion(""); }}>{copy.scopeSave}</button>
      </div>}
    </div>}
    {tab === "sources" && <ul data-testid="research-sources" className="space-y-2 text-sm">
      {!sources.length && <li>{copy.sourcesEmpty}</li>}
      {sources.map((source) => {
        const versions = (source.versions as Array<{ readStatus: string }> | undefined) ?? [];
        const read = versions.some((version) => version.readStatus === "read");
        const unavailable = versions.length > 0 && versions.every((version) => version.readStatus === "unavailable");
        return <li key={String(source.id)} data-source-key={String(source.sourceKey)}>
          <span className="font-mono text-xs">{String(source.sourceKey)}</span>{" "}
          {source.url ? <a href={String(source.url)} target="_blank" rel="noreferrer noopener" className="underline">{String(source.title ?? source.url)}</a> : <span>{String(source.title ?? "")}</span>}
          {" · "}{source.visibility === "private" ? copy.sourcePrivate : read ? copy.sourceRead : unavailable ? copy.sourceUnavailable : copy.sourceSnippet}
          {source.duplicateOf ? ` · ${copy.sourceRepublished} (${String(source.duplicateOf)})` : ""}
        </li>;
      })}
    </ul>}
    {tab === "report" && <div data-testid="research-report">
      {!run.currentReportRevision ? <p>{copy.reportNotReady}</p> : <>
        <p className="text-xs text-zinc-500">{formatResearchCopy(copy.reportRevision, { revision: report?.revision ?? run.currentReportRevision })}</p>
        {report?.containsPrivate && <p className="text-sm" data-testid="research-report-private">{copy.shareContainsPrivate}</p>}
        <div className="flex flex-wrap gap-2">{(["md", "pdf", "docx", "csv", "xlsx"] as const).map((format) =>
          <button key={format} type="button" className={button} data-testid={`research-export-${format}`} onClick={() => void download(format)}>{copy.exportLabel} {format.toUpperCase()}</button>)}</div>
        {report?.markdown && <div className="mt-3 min-w-0 space-y-2 text-sm leading-6 [&_a]:underline [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_table]:block [&_table]:overflow-x-auto" data-testid="research-report-body">
          <AnswerMarkdown>{report.markdown}</AnswerMarkdown>
        </div>}
        {report?.claims && report.claims.length > 0 && <ol className="mt-3 space-y-2 text-sm" data-testid="research-claims">
          {report.claims.map((claim) => <li key={claim.claimKey} data-verification={claim.verification}>
            <span className="font-mono text-xs">{claim.claimKey}</span> {claim.text} <span className="text-xs text-zinc-500">· {copy.report.verification[claim.verification as keyof typeof copy.report.verification] ?? claim.verification}</span>
            {claim.evidence.filter((span) => span.chunkId).map((span) => <button key={`${claim.claimKey}-${span.chunkId}`} type="button" className="ml-2 min-h-11 text-xs underline"
              data-testid="research-evidence-open" onClick={() => void openEvidence(claim.claimKey, span)}>{copy.evidenceOpen} ({span.sourceKey})</button>)}
            {claim.evidence.some((span) => span.level === "snippet") && <span className="ml-2 text-xs">{copy.sourceSnippet}</span>}
            {evidence?.key.startsWith(`${claim.claimKey}:`) && <blockquote className="mt-1 whitespace-pre-wrap border-l-2 pl-2 text-xs" data-testid="research-evidence-text">
              {evidence.text.slice(0, evidence.highlight.start)}<mark>{evidence.text.slice(evidence.highlight.start, evidence.highlight.end)}</mark>{evidence.text.slice(evidence.highlight.end)}
              {evidence.url && <a href={evidence.url} target="_blank" rel="noreferrer noopener" className="ml-2 underline">{evidence.sourceKey}</a>}
            </blockquote>}
          </li>)}
        </ol>}
        {run.actions.canRevise && <div className="mt-3 space-y-2">
          <textarea aria-label={copy.reviseInstruction} placeholder={copy.reviseInstruction} className="w-full rounded-lg border border-zinc-300 p-2 text-sm dark:border-zinc-700" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
          <div className="flex flex-wrap gap-2">
            {([["format", copy.reviseFormat], ["conditions", copy.reviseConditions], ["refresh", copy.reviseRefresh], ["redact_public", copy.revisePublic]] as const).map(([kind, label]) =>
              <button key={kind} type="button" className={button} disabled={busy} data-testid={`research-revise-${kind}`}
                onClick={() => void act({ kind: "revisions", expectedReportRevision: run.currentReportRevision, revisionKind: kind, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) })}>{label}</button>)}
          </div>
        </div>}
      </>}
    </div>}
  </section>;
}

export function DeepResearchEngineRow({ language, onOpen, disabled }: { language: Language; onOpen: () => void; disabled?: boolean }) {
  const copy = researchEngineCopy[language];
  return <button type="button" data-testid="tools-deep-research-engine-row" disabled={disabled} onClick={onOpen}
    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-zinc-800">
    <span className="flex min-w-0 flex-col">
      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{copy.title}</span>
      <span className="text-xs text-zinc-500">{copy.briefSourcesHint}</span>
    </span>
  </button>;
}
