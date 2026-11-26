import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Microscope, SearchCheck } from "lucide-react";
import { ResearchApiError } from "../../../../packages/api-client/src/research";
import {
  acceptResearchRunUpdate, formatResearchCopy, researchProgress, researchRunNeedsPolling, researchStartIds, researchStatusKey, type ResearchRunView,
} from "../../../../packages/chat-core/src/research";
import type { Language } from "../../../../lib/language";
import { researchEngineCopy } from "../../../../locales/researchEngine";
import { researchPreviewCopy } from "../../../../locales/researchPreview";
import { projectWorkspaceCopy } from "../../../../locales/projectWorkspace";
import { desktopFilesCopy } from "../../../../locales/desktopFiles";
import type { ChatConversation } from "../chat-contract";
import {
  researchCreateInput, type DesktopResearchAction, type DesktopResearchInput, type DesktopResearchOutcome, type DesktopResearchRun, type ResearchEngineOffer,
  type ResearchEvidence, type ResearchPreviewOffer, type ResearchReport, type ResearchSource, type ResearchStep,
} from "../research-contract";
import { ChatMarkdown } from "./ChatTranscript";
import { SaveToProject } from "./ProjectSaveToProject";
import { openLink } from "./WebViewer";
import "./research-engine.css";

type Call = <Action extends DesktopResearchAction>(input: Extract<DesktopResearchInput, { action: Action }>) => Promise<DesktopResearchOutcome<Action>>;

/** A start that failed after its question was saved; the chat still exists and can be opened. */
export class ResearchStartError extends ResearchApiError {
  constructor(status: number, code: string, readonly conversationId?: string) { super(status, code); }
}

/** The renderer's Research API: the shared client's method names over the typed `desktop.research` bridge. */
export function createDesktopResearchClient(call: Call = (input) => window.desktop.research(input)) {
  async function run<Action extends DesktopResearchAction>(input: Extract<DesktopResearchInput, { action: Action }>) {
    let outcome: DesktopResearchOutcome<Action>;
    try { outcome = await call<Action>(input); } catch { throw new ResearchApiError(0, "RESEARCH_UNAVAILABLE"); }
    if (!outcome.ok) throw new ResearchStartError(outcome.status, outcome.code, outcome.conversationId);
    return outcome.value;
  }
  return {
    offer: (profile: "standard" | "deep" = "standard") => run<"offer">({ action: "offer", profile }),
    create: (payload: Extract<DesktopResearchInput, { action: "create" }>["payload"]) => run<"create">({ action: "create", payload }),
    runs: (conversationId: string) => run<"runs">({ action: "runs", conversationId }),
    read: (runId: string) => run<"read">({ action: "read", runId }),
    act: (runId: string, step: ResearchStep) => run<"act">({ action: "act", runId, step }),
    sources: (runId: string) => run<"sources">({ action: "sources", runId }),
    evidence: (runId: string, chunkId: string, start?: number, end?: number) => run<"evidence">({ action: "evidence", runId, chunkId, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }),
    report: (runId: string) => run<"report">({ action: "report", runId }),
    exportFile: (runId: string, format: "md" | "pdf" | "docx" | "csv" | "xlsx") => run<"export">({ action: "export", runId, format }),
    previewOffer: (input: Extract<DesktopResearchInput, { action: "previewOffer" }>["input"]) => run<"previewOffer">({ action: "previewOffer", input }),
    previewStart: (input: Extract<DesktopResearchInput, { action: "previewStart" }>["input"]) => run<"previewStart">({ action: "previewStart", input }),
    previewRead: (runId: string) => run<"previewRead">({ action: "previewRead", runId }),
    previewAct: (runId: string, step: "resume" | "cancel") => run<"previewAct">({ action: "previewAct", runId, step }),
  };
}
export type DesktopResearchClient = ReturnType<typeof createDesktopResearchClient>;
let shared: DesktopResearchClient | undefined;
const researchClient = () => (shared ??= createDesktopResearchClient());

const splitList = (value: string) => value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
const errorCode = (error: unknown) => error instanceof ResearchApiError ? error.code : "RESEARCH_UNAVAILABLE";

function Sheet({ title, onClose, children, testId, busy }: { title: string; onClose: () => void; children: ReactNode; testId: string; busy?: boolean }) {
  return <dialog className="task-github-dialog pw-dialog research-sheet" data-testid={testId} aria-label={title}
    ref={(node) => { if (node && !node.open) node.showModal(); }}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div><header><h2><Microscope size={18} aria-hidden="true" /> {title}</h2></header>{children}</div>
  </dialog>;
}

/** Deep Research (engine) brief and estimate. Starting is paid work, so the maximum credits are confirmed here. */
export function DeepResearchSheet({ language, conversationId, projectId, draft, offer, onClose, onStarted }: {
  language: Language; conversationId?: string; projectId?: string | null; draft: string; offer: ResearchEngineOffer;
  onClose: () => void; onStarted: (conversationId: string) => void;
}) {
  const copy = researchEngineCopy[language];
  const projectCopy = projectWorkspaceCopy[language];
  const client = researchClient();
  const [question, setQuestion] = useState(draft);
  const [objective, setObjective] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [languages, setLanguages] = useState("");
  const [regions, setRegions] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [urls, setUrls] = useState("");
  const [includeChat, setIncludeChat] = useState(false);
  const [includeProject, setIncludeProject] = useState(false);
  const [profile, setProfile] = useState<"standard" | "deep">("standard");
  const max = offer.features?.maxApprovedCredits ?? 2_000;
  const [credits, setCredits] = useState(() => Math.min(max, Math.max(50, offer.estimate?.highCredits ?? 400)));
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One identity per attempt: a lost create response is read back by the same ids, never repeated.
  const ids = useRef(researchStartIds(() => crypto.randomUUID()));

  async function submit() {
    setBusy(true); setError(null);
    const parsed = researchCreateInput.safeParse({
      ...(conversationId ? { conversationId } : {}), userMessageId: ids.current.userMessageId, assistantMessageId: ids.current.assistantMessageId,
      brief: { question: question.trim(), ...(objective.trim() ? { objective: objective.trim() } : {}), deliverable: "report",
        searchLanguages: splitList(languages), regions: splitList(regions),
        ...(from || to ? { period: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
        includeDomains: splitList(include), excludeDomains: splitList(exclude), constraints: [] },
      sources: [...splitList(urls).map((url) => ({ type: "url", url })),
        ...(includeChat && conversationId && offer.features?.privateSources ? [{ type: "conversation", conversationId }] : []),
        ...(includeProject && projectId && offer.features?.projectSources ? [{ type: "project", projectId }] : [])],
      profile, approvedCredits: Math.min(max, Math.max(1, Math.round(credits))), autoStart, locale: language,
    });
    if (!parsed.success) { setError("INVALID_RESEARCH_REQUEST"); setBusy(false); return; }
    try {
      const run = await client.create(parsed.data);
      ids.current = researchStartIds(() => crypto.randomUUID());
      onStarted(run.conversationId ?? conversationId ?? "");
      onClose();
    } catch (failure) {
      setError(errorCode(failure));
    } finally {
      setBusy(false);
    }
  }
  return <Sheet title={copy.title} onClose={onClose} testId="deep-research-engine-sheet" busy={busy}>
    <div className="pw-dialog-body research-form">
      <label className="pw-label" htmlFor="dre-question">{copy.briefQuestion}</label>
      <textarea id="dre-question" data-testid="dre-question" className="pw-textarea" rows={5} value={question} maxLength={60_000} onChange={(event) => setQuestion(event.currentTarget.value)} />
      <p className="pw-muted">{copy.briefPublicNote}</p>
      <label className="pw-label" htmlFor="dre-objective">{copy.briefObjective}</label>
      <input id="dre-objective" className="history-search" value={objective} maxLength={4_000} onChange={(event) => setObjective(event.currentTarget.value)} />
      <details>
        <summary>{copy.briefConditions}</summary>
        <div className="research-grid">
          <input aria-label="from" type="date" className="history-search" value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
          <input aria-label="to" type="date" className="history-search" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
          <input aria-label="languages" placeholder="ko, en" className="history-search" value={languages} onChange={(event) => setLanguages(event.currentTarget.value)} />
          <input aria-label="regions" placeholder="KR, AU" className="history-search" value={regions} onChange={(event) => setRegions(event.currentTarget.value)} />
          <input aria-label="include domains" placeholder="example.gov" className="history-search" value={include} onChange={(event) => setInclude(event.currentTarget.value)} />
          <input aria-label="exclude domains" placeholder="example.com" className="history-search" value={exclude} onChange={(event) => setExclude(event.currentTarget.value)} />
        </div>
      </details>
      <fieldset className="pw-stack">
        <legend className="pw-label">{copy.briefSources}</legend>
        <textarea aria-label="urls" data-testid="dre-urls" className="pw-textarea" rows={2} placeholder="https://" value={urls} onChange={(event) => setUrls(event.currentTarget.value)} />
        {offer.features?.privateSources && conversationId && <label className="pw-check"><input type="checkbox" data-testid="dre-include-chat" checked={includeChat} onChange={(event) => setIncludeChat(event.currentTarget.checked)} />
          <span>{copy.tabSources}: {copy.sourcePrivate}</span></label>}
        {offer.features?.projectSources && projectId && <label className="pw-check"><input type="checkbox" data-testid="dre-include-project" checked={includeProject} onChange={(event) => setIncludeProject(event.currentTarget.checked)} />
          <span>{copy.tabSources}: {projectCopy.tabs.materials}</span></label>}
        <p className="pw-muted">{copy.briefSourcesHint}</p>
      </fieldset>
      <div className="pw-actions" role="radiogroup">
        {(["standard", "deep"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={profile === value} className={profile === value ? "primary" : "soft"}
          onClick={() => setProfile(value)}>{value === "standard" ? copy.profileStandard : copy.profileDeep}</button>)}
      </div>
      <label className="pw-label" htmlFor="dre-credits">{copy.budgetLabel}</label>
      <input id="dre-credits" data-testid="dre-credits" type="number" min={1} max={max} className="history-search" value={credits} onChange={(event) => setCredits(Number(event.currentTarget.value))} />
      <p className="pw-muted">{copy.budgetHint}</p>
      {offer.estimate && <p className="pw-muted" data-testid="dre-estimate">{formatResearchCopy(copy.estimateRange, { low: offer.estimate.lowCredits, high: offer.estimate.highCredits })}</p>}
      <label className="pw-check"><input type="checkbox" checked={!autoStart} onChange={(event) => setAutoStart(!event.currentTarget.checked)} />
        <span>{copy.planTitle}: {copy.planEdit}</span></label>
      <p className="pw-muted">{copy.planCost}</p>
      {error && <p role="alert" className="pw-error" data-testid="dre-error">{copy.actionFailed} ({error})</p>}
    </div>
    <footer className="pw-actions">
      <button type="button" className="soft" disabled={busy} onClick={onClose}>{copy.cancel}</button>
      <button type="button" className="primary" data-testid="dre-submit" disabled={busy || !question.trim()} onClick={() => void submit()}>{autoStart ? copy.start : copy.makePlan}</button>
    </footer>
  </Sheet>;
}

/** Research Preview confirmation: scope, limits and the estimated maximum, before the question is saved and run. */
export function ResearchPreviewSheet({ language, conversationId, modelId, question, offer, onClose, onSaved, onStarted }: {
  language: Language; conversationId?: string; modelId: string; question: string; offer: ResearchPreviewOffer;
  onClose: () => void; onSaved: () => void; onStarted: (conversationId: string) => void;
}) {
  const copy = researchPreviewCopy[language];
  const client = researchClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  async function start() {
    setBusy(true); setFailed(false);
    try {
      const started = await client.previewStart({ ...(conversationId ? { conversationId } : {}), requestId: requestId.current, modelId, question, locale: language });
      onSaved();
      onStarted(started.conversationId);
      onClose();
    } catch (error) {
      setFailed(true);
      // The question was saved before the run failed: the chat holds it, so show it and clear the draft.
      if (error instanceof ResearchStartError && error.conversationId) { onSaved(); onStarted(error.conversationId); }
    } finally {
      setBusy(false);
    }
  }
  return <Sheet title={copy.researchPreviewTitle} onClose={onClose} testId="research-preview-sheet" busy={busy}>
    <div className="pw-dialog-body">
      <p>{copy.researchPreviewDescription}</p>
      <p className="pw-muted">{offer.features?.pageReading ? copy.researchPreviewScopeWithPages : copy.researchPreviewScope}</p>
      {offer.features?.pageReading && <p className="pw-muted">{copy.researchPreviewPageLimits}</p>}
      <p className="pw-muted">{copy.researchPreviewRunLimits}</p>
      <blockquote className="research-question">{question}</blockquote>
      {offer.estimatedCredits !== undefined && <p className="pw-strong" data-testid="research-preview-estimate">{formatResearchCopy(copy.researchPreviewEstimate, { credits: offer.estimatedCredits })}</p>}
      <p className="pw-muted">{copy.researchPreviewDurableHint}</p>
      {failed && <p role="alert" className="pw-error">{copy.researchRunReadError}</p>}
    </div>
    <footer className="pw-actions">
      <button type="button" className="soft" disabled={busy} onClick={onClose}>{copy.researchPreviewClear}</button>
      <button type="button" className="primary" data-testid="research-preview-start" disabled={busy} onClick={() => void start()}>{copy.researchPreviewTitle}</button>
    </footer>
  </Sheet>;
}

type Tab = "plan" | "progress" | "sources" | "report";

/** The engine run workspace. It polls only while the server may change the run without the person acting. */
export function ResearchWorkspace({ runId, conversationId, language, accountKey, client = researchClient(), onReportChanged, savedAction }: {
  runId: string; conversationId: string; language: Language; accountKey: string; client?: DesktopResearchClient;
  /** Called when the run settles or its report revision changes, so the chat answer can be read again. */
  onReportChanged?: () => void; savedAction?: ReactNode;
}) {
  const copy = researchEngineCopy[language];
  const files = desktopFilesCopy[language];
  const scope = useMemo(() => ({ runId, conversationId, accountKey }), [runId, conversationId, accountKey]);
  const scopeKey = `${accountKey}:${conversationId}:${runId}`;
  const [view, setView] = useState<{ scopeKey: string; run: ResearchRunView | null }>({ scopeKey: "", run: null });
  const run = view.scopeKey === scopeKey ? view.run : null;
  const [tab, setTab] = useState<Tab>("progress");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [evidence, setEvidence] = useState<(ResearchEvidence & { key: string }) | null>(null);
  const [instruction, setInstruction] = useState("");
  const [scopeQuestion, setScopeQuestion] = useState("");
  const [extend, setExtend] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const poll = useRef<(() => void) | null>(null);
  const publish = useCallback((incoming: unknown) => {
    setView((previous) => ({ scopeKey, run: acceptResearchRunUpdate(previous.scopeKey === scopeKey ? previous.run : null, incoming, scope) }));
  }, [scope, scopeKey]);

  useLayoutEffect(() => {
    let active = true;
    let latest = 0;
    const read = async () => {
      clearTimeout(timer.current);
      // Only the newest read schedules the next one, so a restart never forks the loop.
      const mine = ++latest;
      try {
        const value = await client.read(runId);
        if (!active) return;
        publish(value);
        const current = acceptResearchRunUpdate(null, value, scope);
        if (mine === latest && current && researchRunNeedsPolling(current)) timer.current = setTimeout(() => void read(), 4_000);
      } catch { if (active && mine === latest) timer.current = setTimeout(() => void read(), 10_000); }
    };
    poll.current = () => void read();
    void read();
    return () => { active = false; poll.current = null; clearTimeout(timer.current); };
  }, [runId, scope, publish, client]);

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

  async function act(step: ResearchStep) {
    if (busy) return;
    setBusy(true); setNotice(null);
    try {
      const result = await client.act(runId, step);
      publish(result.run);
      if (result.readback) setNotice(copy.actionFailed);
      const current = acceptResearchRunUpdate(null, result.run, scope);
      if (result.readback || (current && researchRunNeedsPolling(current))) poll.current?.();
    } catch {
      setNotice(copy.actionFailed);
      poll.current?.();
    } finally {
      setBusy(false);
    }
  }
  const sourcesSeen = run?.progress.sourcesSeen;
  useEffect(() => {
    if (tab !== "sources" || sourcesSeen === undefined) return;
    let active = true;
    void client.sources(runId).then((value) => { if (active) setSources(value.sources ?? []); }, () => undefined);
    return () => { active = false; };
  }, [tab, runId, sourcesSeen, client]);
  const reportRevision = run?.currentReportRevision;
  useEffect(() => {
    if (tab !== "report" || !reportRevision) return;
    let active = true;
    void client.report(runId).then((value) => { if (active) setReport(value); }, () => undefined);
    return () => { active = false; };
  }, [tab, runId, reportRevision, client]);

  async function download(format: "md" | "pdf" | "docx" | "csv" | "xlsx") {
    setNotice(null);
    try { if (await client.exportFile(runId, format)) setNotice(files.fileSaved); }
    catch { setNotice(copy.actionFailed); }
  }
  async function openEvidence(claimKey: string, span: { sourceKey: string; chunkId?: string; start: number; end: number }) {
    if (!span.chunkId) return;
    try { setEvidence({ key: `${claimKey}:${span.chunkId}`, ...await client.evidence(runId, span.chunkId, span.start, span.end) }); }
    catch { setNotice(copy.actionFailed); }
  }

  if (!run) return <div className="research-run-card" data-testid="research-workspace" data-run-status="loading"><p role="status">{copy.title}</p></div>;
  const progress = researchProgress(run);
  const tabs: Tab[] = ["plan", "progress", "sources", "report"];
  const tabLabel = { plan: copy.tabPlan, progress: copy.tabProgress, sources: copy.tabSources, report: copy.tabReport };
  const quality = run.qualityStatus === "complete" ? copy.qualityComplete : run.qualityStatus === "partial" ? copy.qualityPartial
    : run.qualityStatus === "insufficient_evidence" ? copy.qualityInsufficient : null;
  const terminal = ["completed", "failed", "cancelled", "attention"].includes(run.status);
  return <section className="research-run-card pw-stack" data-testid="research-workspace" data-run-status={run.status} data-event-sequence={run.eventSequence} aria-label={copy.title}>
    <header className="pw-inline">
      <strong>{copy.title}</strong>
      <span role="status" className="pw-chip" data-testid="research-workspace-status">{copy[researchStatusKey(run.status)]}</span>
      {quality && <span className="pw-chip" data-testid="research-workspace-quality">{quality}</span>}
    </header>
    <p className="pw-muted" data-testid="research-workspace-money">{formatResearchCopy(copy.moneyLine, {
      settled: run.money.settledCredits, reserved: run.money.reservedCredits, unknown: run.money.unknownCredits, approved: run.money.approvedCredits })}
      {run.money.settlement === "pending" ? ` · ${copy.settlementPending}` : run.money.settlement === "unknown" ? ` · ${copy.settlementUnknown}` : ""}</p>
    <div className="pw-actions">
      {run.actions.canPause && <button type="button" className="soft" disabled={busy} data-testid="research-pause" onClick={() => void act({ kind: "pause" })}>{copy.pause}</button>}
      {run.actions.canResume && <button type="button" className="soft" disabled={busy} data-testid="research-resume" onClick={() => void act({ kind: "resume" })}>{copy.resume}</button>}
      {run.actions.canFinish && <button type="button" className="soft" disabled={busy} data-testid="research-finish" onClick={() => void act({ kind: "finish" })}>{copy.finishNow}</button>}
      {run.actions.canCancel && <button type="button" className="pw-danger" disabled={busy} data-testid="research-cancel" onClick={() => void act({ kind: "cancel" })}>{copy.cancel}</button>}
      {run.actions.canExtendBudget && <button type="button" className="soft" disabled={busy} data-testid="research-extend"
        onClick={() => setExtend(run.money.approvedCredits + Math.max(50, Math.ceil(run.money.approvedCredits / 2)))}>{copy.extendBudget}</button>}
    </div>
    {extend !== null && <div className="pw-banner pw-stack" role="alertdialog" aria-label={copy.extendBudget} data-testid="research-extend-confirm">
      <p>{formatResearchCopy(copy.extendBudgetConfirm, { credits: extend })}</p>
      <div className="pw-actions">
        <button type="button" className="primary" disabled={busy} data-testid="research-extend-yes"
          onClick={() => { const next = extend; setExtend(null); void act({ kind: "budget", expectedApprovedCredits: run.money.approvedCredits, approvedCredits: next }); }}>{copy.extendBudget}</button>
        <button type="button" className="soft" onClick={() => setExtend(null)}>{copy.cancel}</button>
      </div>
    </div>}
    {run.budgetReached && <p role="status" className="pw-banner pw-banner-warn" data-testid="research-budget-reached">{copy.budgetReached}</p>}
    {notice && <p role="status" className="pw-muted">{notice}</p>}
    <div role="tablist" className="pw-tabs">
      {tabs.map((entry) => <button key={entry} type="button" role="tab" aria-selected={tab === entry} data-testid={`research-tab-${entry}`} onClick={() => setTab(entry)}>{tabLabel[entry]}</button>)}
    </div>
    {tab === "plan" && <div className="pw-stack" data-testid="research-plan">
      {!run.plan ? <p>{copy.statusPlanning}</p> : <>
        <p className="pw-strong">{run.plan.plan.objective}</p>
        {run.plan.plan.clarifications.length > 0 && <><h4>{copy.planClarifications}</h4><ul className="pw-list">{run.plan.plan.clarifications.map((entry, index) => <li key={index}>{entry.question}</li>)}</ul></>}
        <h4>{copy.planAssumptions}</h4><ul className="pw-list">{run.plan.plan.assumptions.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
        <h4>{copy.planSubquestions}</h4><ol className="pw-list">{run.plan.plan.subquestions.map((entry) => <li key={entry.key}>{entry.question}</li>)}</ol>
        <h4>{copy.planOutline}</h4><ol className="pw-list">{run.plan.plan.outline.map((entry) => <li key={entry.key}>{entry.heading}</li>)}</ol>
        <h4>{copy.planCriteria}</h4><ul className="pw-list">{run.plan.plan.completionCriteria.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
      </>}
      {(run.status === "draft" || (run.status === "awaiting_input" && !run.approvedPlanRevision)) && <div className="pw-stack">
        <textarea aria-label={copy.planFeedback} className="pw-textarea" rows={2} value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} />
        <div className="pw-actions">
          <button type="button" className="soft" disabled={busy} data-testid="research-plan-request"
            onClick={() => void act({ kind: "plan", expectedPlanRevision: run.planRevision, ...(instruction.trim() ? { feedback: instruction.trim() } : {}) })}>{run.plan ? copy.planFeedback : copy.makePlan}</button>
          {run.actions.canApprovePlan && run.plan && <button type="button" className="primary" disabled={busy} data-testid="research-plan-approve"
            onClick={() => void act({ kind: "approve", planRevision: run.planRevision })}>{copy.planApprove}</button>}
        </div>
        <p className="pw-muted">{copy.planCost}</p>
      </div>}
    </div>}
    {tab === "progress" && <div className="pw-stack" data-testid="research-progress">
      {progress.hasCounts && <p data-testid="research-progress-items">{formatResearchCopy(copy.progressItems, { done: progress.done, total: progress.total })}</p>}
      <p>{formatResearchCopy(copy.progressSources, { seen: run.progress.sourcesSeen, read: run.progress.sourcesRead, private: run.progress.privateSources })}</p>
      <ul className="pw-list">{run.progress.questions.map((question) => <li key={question.key} data-state={question.state}>
        <span className="pw-strong">{question.question}</span> · {copy[question.state === "done" ? "statusCompleted" : question.state === "attention" ? "statusAttention" : question.state === "active" ? "statusRunning" : "statusQueued"]} · {formatResearchCopy(copy.progressQuestion, { findings: question.findings })}</li>)}</ul>
      {!terminal && run.approvedPlanRevision && <div className="pw-inline">
        <input aria-label={copy.scopeAddQuestion} placeholder={copy.scopeAddQuestion} className="history-search pw-grow" value={scopeQuestion} onChange={(event) => setScopeQuestion(event.currentTarget.value)} />
        <button type="button" className="soft" disabled={busy || !scopeQuestion.trim()} data-testid="research-scope-save"
          onClick={() => { void act({ kind: "scope", expectedInputRevision: run.inputRevision, addQuestions: [scopeQuestion.trim()] }); setScopeQuestion(""); }}>{copy.scopeSave}</button>
      </div>}
    </div>}
    {tab === "sources" && <ul className="pw-rows" data-testid="research-sources">
      {!sources.length && <li>{copy.sourcesEmpty}</li>}
      {sources.map((source) => {
        const versions = source.versions ?? [];
        const read = versions.some((version) => version.readStatus === "read");
        const unavailable = versions.length > 0 && versions.every((version) => version.readStatus === "unavailable");
        return <li key={source.id} data-source-key={source.sourceKey}>
          <code>{source.sourceKey}</code>
          {source.url ? <button type="button" className="pw-link" data-testid="research-source-link" onClick={() => void openLink(String(source.url)).catch(() => undefined)}>{source.title ?? source.url}</button> : <span>{source.title ?? ""}</span>}
          <span className="pw-muted">{source.visibility === "private" ? copy.sourcePrivate : read ? copy.sourceRead : unavailable ? copy.sourceUnavailable : copy.sourceSnippet}
            {source.duplicateOf ? ` · ${copy.sourceRepublished} (${source.duplicateOf})` : ""}</span>
        </li>;
      })}
    </ul>}
    {tab === "report" && <div className="pw-stack" data-testid="research-report">
      {!run.currentReportRevision ? <p>{copy.reportNotReady}</p> : <>
        <p className="pw-muted">{formatResearchCopy(copy.reportRevision, { revision: report?.revision ?? run.currentReportRevision })}</p>
        {report?.containsPrivate && <p className="pw-banner pw-banner-warn" data-testid="research-report-private">{copy.shareContainsPrivate}</p>}
        <div className="pw-actions">
          {(["md", "pdf", "docx", "csv", "xlsx"] as const).map((format) => <button key={format} type="button" className="soft" data-testid={`research-export-${format}`} onClick={() => void download(format)}>{copy.exportLabel} {format.toUpperCase()}</button>)}
          {run.status === "completed" && savedAction}
        </div>
        {report?.markdown && <div data-testid="research-report-body"><ChatMarkdown content={report.markdown} language={language} /></div>}
        {report?.claims && report.claims.length > 0 && <ol className="pw-stack" data-testid="research-claims">
          {report.claims.map((claim) => <li key={claim.claimKey} data-verification={claim.verification}>
            <code>{claim.claimKey}</code> {claim.text} <span className="pw-muted">· {copy.report.verification[claim.verification as keyof typeof copy.report.verification] ?? claim.verification}</span>
            {claim.evidence.filter((span) => span.chunkId).map((span) => <button key={`${claim.claimKey}-${span.chunkId}`} type="button" className="pw-link" data-testid="research-evidence-open"
              onClick={() => void openEvidence(claim.claimKey, span)}> {copy.evidenceOpen} ({span.sourceKey})</button>)}
            {claim.evidence.some((span) => span.level === "snippet") && <span className="pw-muted"> {copy.sourceSnippet}</span>}
            {evidence?.key.startsWith(`${claim.claimKey}:`) && <blockquote className="research-question" data-testid="research-evidence-text">
              {evidence.text.slice(0, evidence.highlight.start)}<mark>{evidence.text.slice(evidence.highlight.start, evidence.highlight.end)}</mark>{evidence.text.slice(evidence.highlight.end)}
              {evidence.url && <button type="button" className="pw-link" onClick={() => void openLink(evidence.url!).catch(() => undefined)}> {evidence.sourceKey}</button>}
            </blockquote>}
          </li>)}
        </ol>}
        {run.actions.canRevise && <div className="pw-stack">
          <textarea aria-label={copy.reviseInstruction} placeholder={copy.reviseInstruction} className="pw-textarea" rows={2} value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} />
          <div className="pw-actions">
            {([["format", copy.reviseFormat], ["conditions", copy.reviseConditions], ["refresh", copy.reviseRefresh], ["redact_public", copy.revisePublic]] as const).map(([kind, label]) =>
              <button key={kind} type="button" className="soft" disabled={busy} data-testid={`research-revise-${kind}`}
                onClick={() => void act({ kind: "revisions", expectedReportRevision: run.currentReportRevision, revisionKind: kind, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) })}>{label}</button>)}
          </div>
        </div>}
      </>}
    </div>}
  </section>;
}

const previewPolls = new Set(["queued", "running"]);

/** A Research Preview (v1) run: status, counts, and the resume or stop the run allows. Reading never starts paid work. */
export function ResearchPreviewRunCard({ runId, language, client = researchClient(), onChanged, savedAction }: {
  runId: string; language: Language; client?: DesktopResearchClient; onChanged?: () => void; savedAction?: ReactNode;
}) {
  const copy = researchPreviewCopy[language];
  const [run, setRun] = useState<DesktopResearchRun | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changed = useRef(onChanged);
  useLayoutEffect(() => { changed.current = onChanged; }, [onChanged]);
  const read = useRef<(() => Promise<void>) | null>(null);
  useLayoutEffect(() => {
    let active = true;
    let previous: string | null = null;
    const load = async () => {
      clearTimeout(timer.current);
      try {
        const value = await client.previewRead(runId);
        if (!active) return;
        setRun(value); setError(false);
        if (previous !== null && previous !== value.status) changed.current?.();
        previous = value.status;
        if (previewPolls.has(value.status)) timer.current = setTimeout(() => void load(), 5_000);
      } catch { if (active) setError(true); }
    };
    read.current = load;
    void load();
    return () => { active = false; read.current = null; clearTimeout(timer.current); };
  }, [runId, client]);
  async function action(kind: "resume" | "cancel") {
    if (busy) return;
    setBusy(true);
    clearTimeout(timer.current);
    try { setRun(await client.previewAct(runId, kind)); setError(false); }
    // A lost response can follow a committed action: read the run back, never send it again.
    catch { await read.current?.(); }
    finally { setBusy(false); }
    changed.current?.();
    if (read.current) void read.current();
  }
  const label = run ? (({ queued: copy.researchRunQueued, running: copy.researchRunRunning, checkpointed: copy.researchRunCheckpointed,
    completed: copy.researchRunCompleted, failed: copy.researchPreviewOutcomeFailed, cancelled: copy.researchPreviewOutcomeCancelled,
    attention: copy.researchRunAttention } as Record<string, string>)[run.status] ?? copy.researchRunRunning) : copy.researchRunLoading;
  return <div className="research-run-card pw-stack" data-testid="research-run-card" data-run-status={run?.status ?? "loading"}>
    <p role="status"><strong>{copy.researchPreviewTitle}</strong> · {label}</p>
    {run && <p className="pw-muted" data-testid="research-run-counts">{copy.researchRunCounts.replace("{steps}", String(run.stepCount)).replace("{searches}", String(run.searchCount)).replace("{pages}", String(run.readCount))}</p>}
    {run?.status === "queued" && <p className="pw-muted">{copy.researchRunQueueHint}</p>}
    <div className="pw-actions">
      {run?.status === "checkpointed" && run.canResume && <button type="button" className="soft" disabled={busy || error} data-testid="research-run-resume" onClick={() => void action("resume")}>{copy.researchRunResume}</button>}
      {run && ["queued", "running", "checkpointed"].includes(run.status) && <button type="button" className="pw-danger" disabled={busy || error} data-testid="research-run-cancel" onClick={() => void action("cancel")}>{copy.researchRunCancel}</button>}
      {run?.status === "completed" && savedAction}
    </div>
    {error && <p role="alert" className="pw-error">{copy.researchRunReadError} <button type="button" className="soft" disabled={busy} onClick={() => void read.current?.()}>{copy.researchRunRefresh}</button></p>}
  </div>;
}

/** Runs of one conversation by the assistant message they answer; any read failure shows nothing. */
export function useConversationResearch(conversationId: string | undefined, account: string | undefined, enabled: boolean, version: number) {
  const [state, setState] = useState<{ key: string; runs: Map<string, DesktopResearchRun> }>({ key: "", runs: new Map() });
  const key = enabled && account && conversationId ? `${account}:${conversationId}:${version}` : "";
  useEffect(() => {
    if (!key || !conversationId) return;
    let active = true;
    void researchClient().runs(conversationId).then((runs) => {
      if (active) setState({ key, runs: new Map(runs.map((run) => [run.assistantMessageId, run])) });
    }, () => { if (active) setState({ key, runs: new Map() }); });
    return () => { active = false; };
  }, [key, conversationId]);
  return state.key === key ? state.runs : new Map<string, DesktopResearchRun>();
}

/**
 * Research in a Desktop Chat: the composer tool rows, the two confirmation sheets and the run card.
 * Offers are read from the server; a switch that is off, or a read that fails, shows nothing.
 */
export function useChatResearch({ account, language, ready, busy, conversationId, projectId, modelId, draft, plain, onStarted, onSaved, onSettled }: {
  account: string | undefined; language: Language; ready: boolean; busy: boolean; conversationId: string | undefined; projectId: string | null | undefined;
  modelId: string | undefined; draft: string;
  /** False while the draft carries attachments or a handoff excerpt: those never go to web research. */
  plain: boolean;
  onStarted: (conversationId: string) => void; onSaved: () => void; onSettled: (conversationId: string) => void;
}) {
  const engineCopy = researchEngineCopy[language];
  const previewCopy = researchPreviewCopy[language];
  const [engine, setEngine] = useState<{ account: string; offer: ResearchEngineOffer } | null>(null);
  const [previewOffer, setPreviewOffer] = useState<{ key: string; offer: ResearchPreviewOffer } | null>(null);
  const [sheet, setSheet] = useState<"engine" | "preview" | null>(null);
  const [version, setVersion] = useState(0);
  const question = draft.trim();
  useEffect(() => {
    if (!ready || !account) return;
    let active = true;
    void researchClient().offer("standard").then((offer) => { if (active) setEngine({ account, offer }); }, () => { if (active) setEngine(null); });
    return () => { active = false; };
  }, [account, ready]);
  const previewKey = ready && account && plain && modelId && question && question.length <= 4_000 ? JSON.stringify([account, conversationId, modelId, question]) : null;
  useEffect(() => {
    if (!previewKey || !modelId) return;
    let active = true;
    const timer = setTimeout(() => {
      void researchClient().previewOffer({ ...(conversationId ? { conversationId } : {}), modelId, question }).then(
        (offer) => { if (active) setPreviewOffer({ key: previewKey, offer }); },
        () => { if (active) setPreviewOffer({ key: previewKey, offer: { offered: false } }); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [previewKey, conversationId, modelId, question]);
  const engineOffer = engine && engine.account === account && engine.offer.offered ? engine.offer : null;
  const preview = previewOffer?.key === previewKey && previewOffer.offer.offered && previewOffer.offer.features?.durableRuns ? previewOffer.offer : null;
  const runs = useConversationResearch(conversationId, account, ready, version);
  const started = (id: string) => { setVersion((value) => value + 1); onStarted(id); };
  function open(event: React.MouseEvent<HTMLButtonElement>, next: "engine" | "preview") {
    const menu = event.currentTarget.closest("details");
    if (menu) menu.open = false;
    setSheet(next);
  }
  const tools = <>
    {engineOffer && <div className="composer-tool-secondary"><button type="button" className="composer-tool-row" data-testid="tools-deep-research-engine-row" disabled={busy || !ready}
      onClick={(event) => open(event, "engine")}>
      <span className="composer-tool-icon research-icon"><Microscope size={18} /></span>
      <span><strong>{engineCopy.title}</strong><small>{engineCopy.briefSourcesHint}</small></span>
    </button></div>}
    {preview && <div className="composer-tool-secondary"><button type="button" className="composer-tool-row" data-testid="tools-research-preview-row" disabled={busy || !ready}
      onClick={(event) => open(event, "preview")}>
      <span className="composer-tool-icon research-icon"><SearchCheck size={18} /></span>
      <span><strong>{previewCopy.researchPreviewTitle}</strong><small>{previewCopy.researchPreviewDescription}</small></span>
    </button></div>}
  </>;
  const dialogs = <>
    {sheet === "engine" && engineOffer && <DeepResearchSheet language={language} conversationId={conversationId} projectId={projectId} draft={draft} offer={engineOffer}
      onClose={() => setSheet(null)} onStarted={(id) => { onSaved(); started(id); }} />}
    {sheet === "preview" && preview && modelId && <ResearchPreviewSheet language={language} conversationId={conversationId} modelId={modelId} question={question} offer={preview}
      onClose={() => setSheet(null)} onSaved={onSaved} onStarted={started} />}
  </>;
  /** The card for an assistant message a run answers, or null. */
  function card(messageId: string, saveable: boolean): ReactNode {
    const run = runs.get(messageId);
    if (!run || !conversationId || !account) return null;
    const saved = saveable ? <SaveToProject language={language} testId="research-save-to-project" defaultProjectId={projectId} source={{ sourceKind: "research_report", runId: run.id }} /> : undefined;
    return run.engineVersion === 2
      ? <ResearchWorkspace key={run.id} runId={run.id} conversationId={conversationId} language={language} accountKey={account} savedAction={saved} onReportChanged={() => onSettled(conversationId)} />
      : <ResearchPreviewRunCard key={run.id} runId={run.id} language={language} savedAction={saved} onChanged={() => onSettled(conversationId)} />;
  }
  return { tools, dialogs, card, hasRun: (messageId: string) => runs.has(messageId) };
}

export type ConversationMessage = ChatConversation["messages"][number];
