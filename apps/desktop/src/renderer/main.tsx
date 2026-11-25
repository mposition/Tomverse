import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp, ChartNoAxesColumnIncreasing, ChevronDown, CircleHelp, CircleUserRound, Ellipsis, ExternalLink, File, Folder, Globe, MessageCircle, Moon, PanelLeft, Plus, Puzzle,
  Search, ShieldCheck, SlidersHorizontal, Sparkles, Square, SquareTerminal, Sun, X,
} from "lucide-react";
import "@tomverse/ui-tokens/tokens.css";
import "@tomverse/ui-tokens/wordmark.css";
import logo from "../../../../public/tomverse-logo.png";
import { TomverseWordmark } from "../../../../components/chat/TomverseWordmark";
import { usagePercent } from "../../../../components/chat/UsagePercentGauge";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../../lib/chatRequestLimits";
import { ACCOUNT_SETTINGS_TABS, isAccountSettingsTab, type AccountSettingsTab } from "../../../../lib/accountSettingsEvents";
import { isLanguage, type Language } from "../../../../lib/language";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import { desktopCliAccountCopy } from "../../../../locales/desktopCliAccount";
import { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";
import { desktopCodeExecutionCopy } from "../../../../locales/desktopCodeExecution";
import { desktopCodeContinuationCopy } from "../../../../locales/desktopCodeQuota";
import { desktopControlsCopy } from "../../../../locales/desktopControls";
import { desktopFilesCopy } from "../../../../locales/desktopFiles";
import { desktopNativeCopy } from "../../../../locales/desktopNative";
import { desktopProviderCliCopy } from "../../../../locales/desktopProviderCli";
import { desktopReviewCopy } from "../../../../locales/desktopReview";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { desktopSettingsCopy } from "../../../../locales/desktopSettings";
import { mobileCopy } from "../../../../locales/mobile";
import { reviewHandoffCopy } from "../../../../locales/reviewHandoff";
import type { AccountPreferences, AccountTheme } from "../account-settings-contract";
import { MAX_CODE_PROMPT_CHARACTERS, MAX_CODE_REFERENCES, MAX_HANDOFF_EXCERPT_CHARACTERS, type ApprovalRequest, type CodeReference, type DesktopApi, type Snapshot,
  type CodeWorktreeChoice, type Model, type StartInput, type Task } from "../contract";
import { antigravityFixtureExecution, claudeFixtureExecution, codexFixtureExecution, cliProviders, codeRouteFor, kimiFixtureExecution, providerClis, qwenFixtureExecution, vibeFixtureExecution, deepSeekFixtureExecution, zCodeFixtureExecution, miniMaxFixtureExecution, grokFixtureExecution, type CliProvider } from "../code-execution";
import { DraftDictation } from "./DraftDictation";
import { ChatDraftLocation, useChatDraftLocation } from "./ChatDraftLocation";
import { TaskGithubPulls } from "./TaskGithubPulls";
import { CodeBrowser, codeBrowserLabel } from "./CodeBrowser";
import { AccountSettings, LocalMemoryPrivacy, LocalPreferences } from "./AccountSettings";
import { Login } from "./Login";
import { CodeExecutionSettings } from "./CodeExecutionSettings";
import { BackgroundPanel, CodeEngineBar, QueuePanel, SubagentPanel, TurnMenu, effortLabel, effortOptions, readCodeEnginePreference, writeCodeEnginePreference, type CodeEnginePreference } from "./CodeEngine";
import { AnswerBasis, AnswerMessage } from "./AnswerPanel";
import { DiffPanel } from "./DiffPanel";
import { ReviewPanel, canReview } from "./ReviewPanel";
import { REVIEW_OPEN_EVENT, parseReviewCommand } from "../review-contract";
import { EventEntry, EventLogExport } from "./EventLog";
import { BlockedPanel, CodeQuotaPanel } from "./BlockedPanel";
import { NativeUsagePanel, TransmissionPanel } from "./TransmissionPanel";
import { VerificationPanel } from "./VerificationPanel";
import { TaskList } from "./TaskList";
import { desktopPlanAnalysisCopy } from "../../../../locales/desktopTaskList";
import { desktopPrivacyCopy } from "../../../../locales/desktopPrivacy";
import { ChatConversationActions, ChatHistory, ChatWorkspace, chatTitle, sidebarCopy, useChatHistory } from "./ChatWorkspace";
import { PermissionProfileSelect } from "./PermissionProfileSelect";
import { CodePluginPicker } from "./CodePluginPicker";
import { CodeWorkspaceDetails, CodeWorkspacePicker } from "./CodeWorkspacePicker";
import { ConnectorWorkspace } from "./ConnectorWorkspace";
import { mcpConnectorCopy } from "../../../../lib/mcpConnectorCopy";
import { ReviewWorkspace, useReviewRun } from "./ReviewWorkspace";
import { ImageHistoryList, ImageWorkspace, useImageWorkspace } from "./ImageWorkspace";
import { useAttachmentDraft } from "./AttachmentDraft";
import { HandoffDraft, useHandoffSelection } from "./WorkspaceHandoff";
import { ProviderCliSettings } from "./ProviderCliSettings";
import { openDocs, useWebViewState, WebViewer } from "./WebViewer";
import { clearDesktopDrafts, readCodeDraft, writeDesktopDraft } from "./draft-store";
import "./styles.css";

declare global {
  interface Window {
    desktop: Omit<DesktopApi, "approval" | "decide">;
    approvalHost: Pick<DesktopApi, "approval" | "decide">;
  }
}

type Workspace = "chat" | "review" | "code" | "plugins";
type Surface = Workspace | "settings";
type SettingsView = AccountSettingsTab | "imports" | "execution" | "list" | "permissions" | "local-history" | CliProvider;
type Theme = AccountTheme;
type ShellCopy = (typeof desktopShellCopy)[Language];
type ShellNotice = "hostUnavailable" | "actionFailed" | "taskLocked" | "deleteUnconfirmed" | "deleteUnavailable" | "rejectedReferences";
type HandoffNotice = "excerptLimit" | "excerptFailed";
const languagePreference = "tomverse.language";
const nav = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "review", label: "Review", icon: Sparkles },
  { id: "code", label: "Code", icon: SquareTerminal },
  { id: "plugins", label: null, icon: Puzzle },
] as const;
const statusLabels = {
  starting: "starting", running: "running", approval: "approval", stopping: "stopping", completed: "completed",
  clarification: "waiting", blocked: "waiting", stopped: "stopped", unknown: "unconfirmed", failed: "failed",
} as const satisfies Record<Task["status"], keyof ShellCopy>;
function readLanguage(): Language {
  const saved = localStorage.getItem(languagePreference);
  return isLanguage(saved) ? saved : "en";
}

function applyLanguage(language: Language) {
  document.documentElement.lang = language;
  localStorage.setItem(languagePreference, language);
}
const compactHistoryQuery = "(max-width: 700px)";

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
  localStorage.setItem("tomverse.theme", theme);
}

function CodeReferenceLabel({ reference, copy }: { reference: NonNullable<Task["references"]>[number]; copy: ShellCopy }) {
  const Icon = reference.kind === "folder" ? Folder : File;
  const path = reference.path === "." ? copy.rootFolder : reference.path;
  return <><Icon size={14} aria-hidden="true" /><span title={reference.path}>{path}</span></>;
}

function CodePlanAnalysis({ analysis, language }: {
  analysis: NonNullable<NonNullable<Task["plan"]>["analysis"]>; language: Language;
}) {
  const [title, facts, assumptions, scope, verification, completion] = desktopPlanAnalysisCopy[language];
  const fields = [
    [facts, analysis.verifiedFacts.join(" · ")], [assumptions, analysis.assumptions.join(" · ")],
    [scope, analysis.scope], [verification, analysis.verification], [completion, analysis.completion],
  ];
  return <li className="entry entry--assistant">
    <section aria-label={title}>
      <div>{analysis.objective}</div>
      {fields.map(([label, value]) => value && <div key={label}><strong>{label}</strong>{" · "}{value}</div>)}
    </section>
  </li>;
}

function TaskConversation({ task, models, language, openSettings, engine, onRewound, insertReview }: { task: Task; models: Model[]; language: Language; openSettings: () => void; engine?: ReactNode; onRewound?: (text: string) => void; insertReview?: (text: string) => boolean }) {
  const copy = desktopShellCopy[language];
  const native = desktopNativeCopy[language];
  // What happened to the last rewind or fork: kept here, because the message it was started from may be gone after a rewind.
  const [turnNotice, setTurnNotice] = useState<{ key: string; text: string } | null>(null);
  const turnKey = `${task.id}:${task.status}`;
  const continuation = task.continuation;
  const reverseContinuation = task.cliContinuation;
  const continuationCopy = desktopCodeContinuationCopy[language];
  const stage = continuation?.stage ?? reverseContinuation?.stage;
  const continued = stage === "started";
  const sourceCli = continuation && providerClis[continuation.source.provider ?? "openai"];
  const destinationCli = reverseContinuation && providerClis[reverseContinuation.provider];
  const nativeSegment = task.nativeRuns?.[0] && (reverseContinuation?.segmentId ?? task.nativeRuns[0].session.threadId);
  const providerUsage = nativeSegment && task.nativeRuns && <NativeUsagePanel runs={task.nativeRuns} taskId={task.id} segmentId={nativeSegment} language={language} />;
  const apiUsage = task.apiUsage && task.transmission.length > 0 &&
    <TransmissionPanel records={task.transmission} usage={task.apiUsage} taskId={task.id} language={language} />;
  const hasDiagnostics = task.changes.length > 0 || task.checks.length > 0 || task.transmission.length > 0;
  const analysis = task.plan?.analysis;
  const analysisPosition = analysis ? Math.max(task.entries.findIndex(({ role }) => role === "plan"),
    task.entries.findLastIndex(({ role }) => role === "user") + 1) : -1;
  return <>
    <ol className={task.entries.length > 40 ? "thread long-thread" : "thread"} aria-label={copy.taskConversation}>
      {task.entries.map((entry, index) => <Fragment key={index}>
      {analysis && index === analysisPosition && <CodePlanAnalysis analysis={analysis} language={language} />}
      {(entry.role !== "plan" || !!task.plan?.items.length) && <li className={`entry entry--${entry.role}`}>
        {entry.role === "plan" ? task.plan && <TaskList plan={task.plan} run={task.status} taskId={task.id} effort={task.effort}
          models={models} language={language} pendingNativeApproval={task.pendingNativeApproval} />
          : entry.role === "event"
          ? <EventEntry text={entry.notice ? native[entry.notice] : entry.text} />
          : entry.role === "assistant" ? <div data-handoff-content="code"><AnswerMessage text={entry.text} language={language} /></div> : <div>
            <div data-handoff-content="code">{entry.text}</div>
            {entry.turn !== undefined && onRewound && <TurnMenu task={task} turn={entry.turn} language={language} onRewound={onRewound} notify={(text) => setTurnNotice(text ? { key: turnKey, text } : null)} />}
            {index === 0 && !!task.references?.length && <ul className="saved-attachments" aria-label={copy.savedReferences}>
              {task.references.map((reference) => <li key={reference.path}><CodeReferenceLabel reference={reference} copy={copy} /></li>)}
            </ul>}
          </div>}
      </li>}
      {index === 0 && stage && <li className="entry code-continuation" role="status">
        <strong>{continued ? continuationCopy.continued : destinationCli
          ? continuationCopy[stage === "checking" ? "checkingCli" : "unavailableCli"].replace("{cli}", destinationCli)
          : continuationCopy[stage === "checking" ? "checking" : "unavailable"]}</strong>
        {continued && sourceCli && <p>{continuationCopy.reason.replace("{cli}", sourceCli)}</p>}
        {continued && destinationCli && <p>{continuationCopy.cliReason.replace("{cli}", destinationCli)}</p>}
      </li>}</Fragment>)}
      {analysis && analysisPosition === task.entries.length && <CodePlanAnalysis analysis={analysis} language={language} />}
      {task.status === "running" && task.streamingAnswer && <li className="entry entry--assistant">
        <AnswerMessage text={task.streamingAnswer} language={language} />
      </li>}
      {task.pendingFollowUp && <li className="entry entry--user">
        <div>{task.pendingFollowUp}</div>
        <small className="pending-follow-up" role="status">{copy.queuedFollowUp}</small>
      </li>}
    </ol>
    {turnNotice?.key === turnKey && <p className="turn-notice" role="status">{turnNotice.text}</p>}
    {task.status === "blocked" && task.quota && <CodeQuotaPanel quota={task.quota} language={language} openSettings={openSettings} />}
    {continued && <details className="code-continuation-details">
      <summary>{continuationCopy.details}</summary>
      {continuation && <>
        <p>Tomverse API · {task.model ?? continuation.model}</p>
        <p>{continuationCopy.approvedCap.replace("{credits}", continuation.maximumKeyCreditCap.toLocaleString(language))}</p>
      </>}
      {continuation && providerUsage}
      {apiUsage}
      {reverseContinuation && providerUsage}
    </details>}
    {(hasDiagnostics || (!continued && providerUsage)) && <div className="evidence">
      {task.changes.length > 0 && <DiffPanel key={`changes-${task.id}`} changes={task.changes} language={language} />}
      <VerificationPanel key={`commands-${task.id}`} checks={task.checks} language={language} />
      {!continued && providerUsage}
      {!continued && apiUsage}
      {hasDiagnostics && task.id && ["completed", "blocked", "failed", "unknown", "stopped"].includes(task.status) && <EventLogExport language={language} />}
    </div>}
    {insertReview && canReview(task) && <ReviewPanel key={`review-${task.id}`} task={task} models={models} language={language} insert={insertReview} />}
    {engine}
    <footer className="task-status" aria-live="polite">
      <span>{copy[statusLabels[task.status]]}</span>
      {task.execution?.executionMode === "tomverse_api" && <span>Tomverse API</span>}
      {task.execution?.executionMode === "provider_cli" && <span>{desktopCodeExecutionCopy[language].cliFixture.replace("{cli}", task.execution.cli)}</span>}
      {task.savedLocally === false && <span>{copy.sessionOnly}</span>}
      {task.effort && task.effort !== "default" && <span>{copy.requestedEffort.replace("{effort}", effortLabel(language, task.effort))}</span>}
      {task.actual && <span>{copy.appliedEffort.replace("{effort}", effortLabel(language, task.actual))}</span>}
    </footer>
    <AnswerBasis task={task} language={language} />
    <BlockedPanel key={task.id ?? "new"} task={task} language={language} />
  </>;
}

function Desktop() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>("code");
  const [openBrowserScope, setOpenBrowserScope] = useState<string | null>(null);
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const webView = useWebViewState();
  const [settingsView, setSettingsView] = useState<SettingsView | null>(null);
  const surface: Surface = settingsView ? "settings" : workspace;
  const canShowBrowser = surface === "code" && snapshot?.codeBrowserAvailable === true;
  const browserScope = JSON.stringify([snapshot?.draftNamespace, snapshot?.task?.id]);
  const browserOpen = canShowBrowser && openBrowserScope === browserScope;
  const accountSettingsTab = isAccountSettingsTab(settingsView) ? settingsView : null;
  const importsOpen = settingsView === "imports";
  const accountPanel = importsOpen ? "imports" : accountSettingsTab;
  const cliSettingsProvider = cliProviders.find((provider) => provider === settingsView);
  const cliSettingsOpen = settingsView === "list" || Boolean(cliSettingsProvider);
  const cliSettingsEnabled = snapshot?.codeExecutionPreference === "provider_cli";
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("tomverse.theme");
    return saved === "light" || saved === "system" ? saved : "dark";
  });
  const settingsAccount = snapshot?.account.stage === "connected" ? snapshot.account.draftNamespace : undefined;
  const [appliedAccountSettings, setAppliedAccountSettings] = useState<{ scope: string; preferences: AccountPreferences }>();
  const applyAccountPreferences = useCallback((preferences: AccountPreferences) => {
    if (!settingsAccount) return;
    setAppliedAccountSettings({ scope: settingsAccount, preferences });
    setTheme(preferences.theme);
    void window.desktop.setLanguage(preferences.language).catch(() => {});
  }, [settingsAccount]);
  useEffect(() => {
    if (!settingsAccount) return;
    let current = true;
    void window.desktop.accountSettings<"preferences">({ action: "preferences" }).then(
      preferences => { if (current) applyAccountPreferences(preferences); }, () => {},
    );
    return () => { current = false; };
  }, [settingsAccount, applyAccountPreferences]);
  const accountModels = appliedAccountSettings?.scope === settingsAccount
    ? appliedAccountSettings?.preferences.newConversationModelIds : undefined;
  const [legacyLanguage] = useState(readLanguage);
  const language = snapshot?.language ?? legacyLanguage;
  const copy = desktopShellCopy[language];
  const controls = desktopControlsCopy[language];
  const executionCopy = desktopCodeExecutionCopy[language];
  const cliCopy = desktopProviderCliCopy[language];
  const settingsCopy = desktopSettingsCopy(language);
  const common = mobileCopy[language];
  const privacyCopy = desktopPrivacyCopy(language);
  const codeSettings = [
    { id: "execution", name: executionCopy.heading },
    { id: "list", name: cliCopy.heading },
    { id: "permissions", name: settingsCopy.permissions },
    { id: "local-history", name: privacyCopy.localHistory },
  ] as const;
  const chatCopy = desktopChatCopy[language];
  const settingsTitle = importsOpen ? chatCopy.continueImported : accountSettingsTab ? settingsCopy[accountSettingsTab] : cliSettingsProvider ? cliCopy.connection
    : codeSettings.find(({ id }) => id === settingsView)?.name;
  const native = desktopNativeCopy[language];
  const filesCopy = desktopFilesCopy[language];
  const reviewCopy = desktopReviewCopy[language];
  const reviewHandoff = reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language];
  const names: Record<Surface, string> = {
    chat: "Chat", review: "Review", code: "Tomverse Code", plugins: copy.plugins, settings: common.settings,
  };
  const [historyOpen, setHistoryOpen] = useState(() => !matchMedia(compactHistoryQuery).matches);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [reviewReference, setReviewReference] = useState("");
  const [defaultHistoryWidth, setDefaultHistoryWidth] = useState(252);
  const [chatHistoryWidth, setChatHistoryWidth] = useState(318);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saveHistory, setSaveHistory] = useState(true);
  const [codePlugin, setCodePlugin] = useState<{ id: string; namespace: string }>();
  const [workspaceSelection, setWorkspaceSelection] = useState<{ key: string; choice: CodeWorktreeChoice }>();
  const [saveNativeHistory, setSaveNativeHistory] = useState(false);
  const [codeReferences, setCodeReferences] = useState<CodeReference[]>([]);
  const [mode, setMode] = useState<StartInput["mode"]>("agent");
  const [effort, setEffort] = useState<StartInput["effort"]>("default");
  const [engine, setEngine] = useState<CodeEnginePreference>(readCodeEnginePreference);
  function changeEngine(value: CodeEnginePreference) {
    setEngine(value);
    writeCodeEnginePreference(value);
  }
  const [modelId, setModelId] = useState("");
  const [notice, setNotice] = useState<ShellNotice | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<HandoffNotice | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [historyDraft, setHistoryDraft] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollViewport = useRef<{ width: number; height: number } | null>(null);
  const nearBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const historySearchToggle = useRef<HTMLButtonElement>(null);
  const connectionHeading = useRef<"desktop-account" | "desktop-code-key" | null>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const previousNamespace = useRef<string | null>(null);
  const previousAccount = useRef<string | undefined>(undefined);
  const previousCodeKey = useRef<string | undefined>(undefined);
  const accountDraft = snapshot?.account.stage === "connected" ? snapshot.account.draftNamespace : undefined;
  const codeDraft = accountDraft ?? (snapshot?.localFixture ? "local-fixture" : undefined);

  useEffect(() => {
    let alive = true;
    let gotEvent = false;
    function accept(state: Snapshot) {
      const nextAccount = state.account.stage === "connected" ? state.account.draftNamespace : undefined;
      if (previousAccount.current && previousAccount.current !== nextAccount &&
          (state.account.stage === "idle" || state.account.stage === "expired" || nextAccount)) {
        clearDesktopDrafts(previousAccount.current);
        previousAccount.current = undefined;
      }
      previousAccount.current = nextAccount ?? previousAccount.current;
      if (state.codeKey.stage === "connected" && previousCodeKey.current !== state.codeKey.prefix) {
        previousCodeKey.current = state.codeKey.prefix;
        setCodeReferences([]);
      }
      setSnapshot(state);
      if (state.account.stage !== "connected") {
        setReviewReference("");
        setHandoffNotice(null);
      }
    }
    const unsubscribe = window.desktop.subscribe((state) => {
      gotEvent = true;
      accept(state);
    });
    void window.desktop.state().then((state) => { if (alive && !gotEvent) accept(state); })
      .catch(() => { if (alive) setNotice("hostUnavailable"); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(theme);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  useLayoutEffect(() => applyLanguage(language), [language]);
  useLayoutEffect(() => {
    if (historyOpen && matchMedia(compactHistoryQuery).matches) historyHeading.current?.focus();
  }, [historyOpen]);
  useLayoutEffect(() => {
    if (!settingsView) {
      const target = settingsReturnFocus.current;
      if (target) (target.isConnected ? target : settingsTrigger.current)?.focus();
      settingsReturnFocus.current = null;
      return;
    }
    if (connectionHeading.current) {
      document.getElementById(connectionHeading.current)?.focus();
      connectionHeading.current = null;
    }
  }, [settingsView]);
  const savedLanguage = snapshot?.language;
  useEffect(() => {
    if (savedLanguage === null && legacyLanguage !== "en") {
      void window.desktop.setLanguage(legacyLanguage).catch(() => {});
    }
  }, [savedLanguage, legacyLanguage]);
  useEffect(() => {
    const compact = matchMedia(compactHistoryQuery);
    function resize(event: MediaQueryListEvent) {
      if (event.matches) {
        if (document.getElementById("desktop-history")?.contains(document.activeElement)) historyToggle.current?.focus();
        setHistoryOpen(false);
      }
    }
    compact.addEventListener("change", resize);
    return () => compact.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const update = (event: Event) => setOnline(event.type === "online");
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useLayoutEffect(() => {
    if (composer.current) {
      composer.current.style.height = "auto";
      composer.current.style.height = `${Math.min(148, Math.max(42, composer.current.scrollHeight))}px`;
    }
  }, [prompt, surface]);
  useLayoutEffect(() => {
    if (scroll.current && nearBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot?.task, surface]);
  useLayoutEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    const keepReadingPosition = () => {
      scrollViewport.current = { width: pane.clientWidth, height: pane.clientHeight };
      if (nearBottom.current) pane.scrollTop = pane.scrollHeight;
    };
    keepReadingPosition();
    const resize = new ResizeObserver(keepReadingPosition);
    resize.observe(pane);
    return () => { resize.disconnect(); scrollViewport.current = null; };
  }, [surface]);
  useEffect(() => {
    const namespace = snapshot?.draftNamespace ?? null;
    if (namespace !== previousNamespace.current) {
      previousNamespace.current = namespace;
      setPrompt(namespace ? readCodeDraft(codeDraft, namespace) : "");
      setSaveHistory(true);
      setCodeReferences([]);
      setHistoryDraft(false);
    }
  }, [codeDraft, snapshot?.draftNamespace]);

  function select(next: Workspace) {
    if (next !== workspace) setOpenBrowserScope(null);
    if (next === workspace) {
      if (next === "chat") chat.reload();
      if (next === "review") review.reload();
    }
    settingsReturnFocus.current = null;
    setWorkspace(next);
    setSettingsView(null);
    setImagesOpen(false);
    setNotice(null);
    setHandoffNotice(null);
  }

  function openSettings(view: SettingsView = "account") {
    if ((view === "list" || cliProviders.some((provider) => provider === view)) && !cliSettingsEnabled) return;
    setOpenBrowserScope(null);
    if (!settingsView) {
      if (document.activeElement instanceof HTMLElement) settingsReturnFocus.current = document.activeElement;
    }
    setSettingsView(view);
    setNotice(null);
  }

  function closeSettings() {
    setSettingsView(null);
    setNotice(null);
  }
  const task = snapshot?.task;
  const busy = snapshot?.busy || requesting;
  const cliFixture = snapshot?.antigravityFixtureModel ? antigravityFixtureExecution : snapshot?.grokFixtureModel ? grokFixtureExecution : snapshot?.miniMaxFixtureModel ? miniMaxFixtureExecution : snapshot?.zCodeFixtureModel ? zCodeFixtureExecution : snapshot?.deepSeekFixtureModel ? deepSeekFixtureExecution : snapshot?.vibeFixtureModel ? vibeFixtureExecution : snapshot?.kimiFixtureModel ? kimiFixtureExecution : snapshot?.qwenFixtureModel ? qwenFixtureExecution :
    snapshot?.claudeFixtureModel ? claudeFixtureExecution : codexFixtureExecution;
  const cliFixtureModel = snapshot?.codeExecutionPreference === "provider_cli"
    ? snapshot.antigravityFixtureModel ?? snapshot.grokFixtureModel ?? snapshot.miniMaxFixtureModel ?? snapshot.zCodeFixtureModel ?? snapshot.deepSeekFixtureModel ?? snapshot.vibeFixtureModel ?? snapshot.kimiFixtureModel ?? snapshot.qwenFixtureModel ?? snapshot.claudeFixtureModel ?? snapshot.codexFixtureModel : undefined;
  const models: Model[] = cliFixtureModel ? [{ id: cliFixtureModel, name: cliFixtureModel, provider: cliFixture.provider, efforts: [] }] : snapshot?.models ?? [];
  const selectedModel = models.find((item) => item.id === modelId) ?? models.find((item) => item.id === "smart-adaptive") ?? models[0];
  const codeRoute = codeRouteFor(snapshot?.codeExecutionPreference ?? "tomverse_api", selectedModel);
  const waitingForAnswer = task?.status === "clarification";
  const codeMode = waitingForAnswer ? task.plan?.proposalOnly ? "plan" : "agent"
    : cliFixtureModel && mode === "agent" && !snapshot?.nativeFixtureEdits ? "ask" : mode;
  const pluginNamespace = codeMode === "ask" && codeRoute.executionMode === "tomverse_api" && snapshot?.capabilities?.codeMcp &&
    snapshot?.account.stage === "connected" ? snapshot.draftNamespace : null;
  const pluginConnectionId = pluginNamespace && codePlugin?.namespace === pluginNamespace ? codePlugin.id : undefined;
  const update = snapshot?.update;
  const account = snapshot?.account;
  const accountShortcut = account?.stage === "connected" ? controls.account : controls.signIn;
  const openImportedConversations = snapshot?.capabilities?.chatImport
    ? () => openSettings("imports") : undefined;
  const chatActive = workspace === "chat" && account?.stage === "connected";
  const nativeChat = !settingsView && chatActive;
  const chat = useChatHistory(chatActive, "chat", accountDraft, language, snapshot?.capabilities?.deepResearch);
  const reviewActive = workspace === "review" && account?.stage === "connected";
  const nativeReview = !settingsView && reviewActive;
  const codeAskLocation = useChatDraftLocation(JSON.stringify([codeDraft, snapshot?.draftNamespace, task?.id]));
  const review = useChatHistory(reviewActive, "review", accountDraft, language);
  async function openImportedConversation(id: string, product: "chat" | "review" = "chat") {
    const history = product === "chat" ? chat : review;
    const row = (await window.desktop.chatHistory(product)).find(conversation => conversation.id === id);
    if (!row) throw new Error("Tomverse could not open the new continuation.");
    setSettingsView(null);
    setNotice(null);
    setWorkspace(product);
    setImagesOpen(false);
    await history.open(row);
    history.reload();
  }
  const reviewRun = useReviewRun(review);
  const comparisonKeys = useRef(new Map<string, string>());
  async function compareFromChat(prompt: string, continuationId?: string) {
    if (reviewRun.running || !snapshot?.capabilities?.review) throw new Error("Review is unavailable.");
    if (continuationId) {
      const scope = JSON.stringify([accountDraft, continuationId]);
      const key = comparisonKeys.current.get(scope) ?? crypto.randomUUID();
      comparisonKeys.current.set(scope, key);
      const result = await window.desktop.accountSettings<"reviewContinuation">({ action: "reviewContinuation", id: continuationId, key });
      await openImportedConversation(result.conversationId, "review");
      return;
    }
    const existing = review.newDraft().trimEnd();
    const draft = existing ? existing + "\n\n" + prompt : prompt;
    if (draft.length > CHAT_MAX_MESSAGE_CHARACTERS) throw new Error("The Review draft is too long.");
    await review.open(null);
    review.setDraft(draft);
    setWorkspace("review");
    setImagesOpen(false);
  }
  const chatAttachments = useAttachmentDraft(chat.selected?.id ?? "new",
    snapshot?.capabilities?.attachments === true && snapshot.capabilities.chatWrite, language, snapshot?.capabilities?.googleDrive);
  const reviewAttachments = useAttachmentDraft(review.selected?.id ?? "new",
    snapshot?.capabilities?.attachments === true && Boolean(snapshot.capabilities.review), language, snapshot?.capabilities?.googleDrive);
  const imageCapability = snapshot?.capabilities?.images ?? null;
  const imagesActive = imagesOpen && !!imageCapability && (chatActive || reviewActive);
  const nativeImages = !settingsView && imagesActive;
  const images = useImageWorkspace(imagesActive, language);
  const chatRail = nativeChat && !nativeImages;
  const textHistory = (nativeChat || nativeReview) && !nativeImages;
  const historyWidth = textHistory ? chatHistoryWidth : defaultHistoryWidth;
  const setHistoryWidth = textHistory ? setChatHistoryWidth : setDefaultHistoryWidth;
  useEffect(() => {
    function dismissMenus(event: globalThis.PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.chat-conversation-actions[open], details.model-menu[open]")) {
        if (!menu.contains(target)) menu.open = false;
      }
    }
    document.addEventListener("pointerdown", dismissMenus, true);
    return () => document.removeEventListener("pointerdown", dismissMenus, true);
  }, []);
  const [usage, setUsage] = useState<{ account: string; value: number | null; plan?: "Free" | "Pro" | "Max" }>();
  const usageLabel = sidebarCopy[language].currentUsage;
  const usageValue = usage?.account === accountDraft ? usage?.value : null;
  useEffect(() => {
    if (!accountDraft || settingsView || chat.sending || reviewRun.running || images.sending) return;
    let current = true;
    const refresh = () => void window.desktop.accountSettings<"usage">({ action: "usage" }).then(({ usage, limits, plan }) => {
      if (current) setUsage({ account: accountDraft, value: usage && limits ? usagePercent(usage.creditsMonth, limits.creditsMonth) : null,
        plan: plan === "Free" || plan === "Pro" || plan === "Max" ? plan : undefined });
    }, () => { if (current) setUsage((last) => ({ account: accountDraft, value: null, plan: last?.account === accountDraft ? last.plan : undefined })); });
    refresh();
    window.addEventListener("focus", refresh);
    return () => { current = false; window.removeEventListener("focus", refresh); };
  }, [accountDraft, settingsView, chat.sending, reviewRun.running, images.sending]);
  function openImageStarter(prompt: string) {
    setImagesOpen(true);
    if (!images.prompt && !images.sending) void images.open().then(() => images.setPrompt(prompt));
  }
  function openImageModel(modelId: string, prompt: string) {
    setImagesOpen(true);
    images.offerImages({ prompt, models: [modelId], quality: "medium", unavailable: [] });
  }
  const handoff = snapshot?.handoff;
  const codeHandoff = handoff?.target === "code" ? handoff : undefined;
  const nativeTask = task?.nativeSession;
  const pausedByQuota = task?.status === "blocked" && !!task.quota;
  const pausedForInput = pausedByQuota || waitingForAnswer;
  const taskSelectionLocked = !!task && (snapshot?.busy || pausedForInput);
  const composerModelId = (taskSelectionLocked && task.model) || selectedModel?.id || "";
  const composerModelName = models.find(({ id }) => id === composerModelId)?.name || composerModelId || copy.modelsUnavailable;
  const composerEffort = taskSelectionLocked ? task.effort ?? "default" : cliFixtureModel ? "default" : effort;
  const followUpTarget = !pausedByQuota && nativeTask ? { threadId: nativeTask.threadId, turnId: nativeTask.turnId } : task?.id;
  const canFollowUp = followUpTarget && (snapshot?.busy ? task?.status === "running" :
    pausedByQuota ? task.canResumeAfterQuota : waitingForAnswer && task.canAnswerClarification) &&
    !task?.pendingFollowUp && !codeHandoff && !codeReferences.length;
  const queueTarget = task?.id && snapshot?.busy && (task.status === "running" || task.status === "approval") &&
    task.execution?.executionMode === "tomverse_api" && !codeHandoff && !codeReferences.length ? task.id : undefined;
  const canQueue = !!queueTarget && online && !requesting && !!prompt.trim();
  const codeGit = codeMode === "agent" && codeRoute.executionMode === "tomverse_api" ? snapshot?.codeGitWorkspace : undefined;
  const workspaceKey = JSON.stringify([snapshot?.draftNamespace, codeGit?.kind === "git" ? codeGit.id : codeGit?.kind]);
  const workspaceChoice: CodeWorktreeChoice | undefined = !codeGit ? undefined
    : workspaceSelection?.key === workspaceKey ? workspaceSelection.choice
    : codeGit.kind === "git" ? { kind: "worktree", id: codeGit.id, base: codeGit.bases[0]! } : undefined;
  const canStartCode = cliFixtureModel ? (prompt.trim() || codeHandoff) &&
    (codeMode !== "agent" || (snapshot?.nativeFixtureEdits && saveNativeHistory))
    : (prompt.trim() || codeHandoff) && codeRoute.executionMode === "tomverse_api" &&
      (codeGit?.kind !== "unavailable" || workspaceChoice?.kind === "local");
  const canSendCode = online && snapshot?.root && !requesting && (snapshot.busy || pausedForInput ? canFollowUp && prompt.trim() : canStartCode);
  const handoffSource = account?.stage === "connected" && !nativeImages && (snapshot?.localFixture || snapshot?.codeKey.stage === "connected")
    ? nativeChat && chat.conversation ? "chat" : surface === "code" && snapshot?.capabilities?.chatWrite && task?.id ? "code" : null : null;
  const selectedExcerpt = useHandoffSelection(handoffSource, handoffSource === "chat" ? chat.conversation?.id : task?.id);
  function openReviewReference(reference: string) {
    select("chat");
    if (chat.draft.trim() || chat.newDraft().trim() || chatAttachments.files.length) setReviewReference(reference);
    else void chat.open(null).then(() => chat.setDraft(reference));
  }
  const codeKey = snapshot?.codeKey;
  const codeCatalog = snapshot?.codeCatalog;
  const historyFilter = search.trim().toLowerCase();
  const visibleCodeHistory = surface === "code" ? snapshot?.history
    .map((entry) => ({ ...entry, title: entry.unreadable ? native.unreadableTask : entry.title || copy.codeTask }))
    .filter(({ title }) => title.toLowerCase().includes(historyFilter)) ?? [] : [];
  const catalogUnavailable = codeCatalog === "failed" || (codeCatalog === "ready" && !selectedModel);
  const canReloadCatalog = !busy && online && !cliFixtureModel && catalogUnavailable &&
    (snapshot?.localFixture || codeKey?.stage === "connected");
  const needsCodeConnection = snapshot && !snapshot.localFixture && codeKey?.stage === "missing" && !selectedModel;
  const needsCodeProject = !busy && online && selectedModel && !snapshot?.root;
  const canChooseApi = !busy && online && !pausedForInput && !cliFixtureModel && snapshot?.root &&
    selectedModel && codeRoute.executionMode !== "tomverse_api";
  let codeStatus = "";
  if (!busy && snapshot && online) {
    if (pausedByQuota && task.execution) {
      codeStatus = task.execution.executionMode === "provider_cli"
        ? executionCopy.cliFixture.replace("{cli}", task.execution.cli) : "Tomverse API";
    } else if (selectedModel) {
      if (cliFixtureModel) codeStatus = executionCopy.cliFixture.replace("{cli}", cliFixture.cli);
      else if (codeRoute.executionMode === "tomverse_api") codeStatus = "Tomverse API";
      else if (codeRoute.executionMode !== "provider_cli") codeStatus = executionCopy.apiRequired;
      else if (!snapshot.supportedCliPaths.includes(codeRoute.provider)) codeStatus = `${codeRoute.cli} · ${cliCopy.unsupportedPlatform}`;
      else if (codeRoute.provider === "openai") codeStatus = `${codeRoute.cli} · ${desktopCliAccountCopy[language].codexApproval}`;
      else codeStatus = `${codeRoute.cli} · ${cliCopy.localExecutionUnavailable}`;
    } else if (needsCodeConnection) {
      codeStatus = account?.stage === "unavailable" ? copy.codeLinkUnavailable
        : account?.stage === "connected" ? (codeKey.detail ? native[codeKey.detail] : copy.codeKeyRequired)
        : account?.stage === "restoring" ? controls.restoring
        : account?.stage === "waiting" ? controls.continueSignin : copy.signInForCode;
    } else if (codeKey?.stage === "checking") codeStatus = controls.checkingKey;
    else if (codeCatalog === "loading") codeStatus = copy.loadingCodeModels;
    else if (codeCatalog === "failed") codeStatus = native.codeCatalogFailure;
    else if (codeCatalog === "ready") codeStatus = copy.noConnectedModels;
  }

  function closeCodeHistorySearch() {
    setSearchOpen(false);
    setSearch("");
    historySearchToggle.current?.focus();
  }

  async function act(action: () => Promise<unknown>) {
    setNotice(null);
    try { await action(); } catch { setNotice("actionFailed"); }
  }

  async function handoffSelection() {
    if (!selectedExcerpt || !handoffSource || busy || chat.sending || chat.writing) return;
    if (selectedExcerpt.length > MAX_HANDOFF_EXCERPT_CHARACTERS) {
      setHandoffNotice("excerptLimit");
      return;
    }
    setRequesting(true);
    setHandoffNotice(null);
    try {
      const result = handoffSource === "chat"
        ? await window.desktop.confirmHandoff({ target: "code", excerpt: selectedExcerpt })
        : task?.id ? await window.desktop.confirmHandoff({ target: "chat", excerpt: selectedExcerpt, sourceTaskId: task.id }) : null;
      if (!result) return;
      if (result.target === "chat") await chat.open(null);
      else {
        await window.desktop.newTask();
        setHistoryDraft(false);
      }
      select(result.target);
    } catch {
      setHandoffNotice("excerptFailed");
    } finally { setRequesting(false); }
  }

  function changeDraft(value: string) {
    setPrompt(value);
    if (saveHistory && !cliFixtureModel && snapshot?.draftNamespace && !(snapshot.busy && task?.savedLocally === false)) {
      writeDesktopDraft(codeDraft, `code:${snapshot.draftNamespace}`, value);
    }
  }

  function changeSaveHistory(value: boolean) {
    setSaveHistory(value);
    if (snapshot?.draftNamespace) writeDesktopDraft(codeDraft, `code:${snapshot.draftNamespace}`, value ? prompt : "");
  }

  async function deleteLocalTask(id: string, menu: HTMLDetailsElement | null) {
    setRequesting(true);
    await act(async () => {
      const result = await window.desktop.deleteHistory(id);
      if (result === "deleted") setHistoryDraft(false);
      if (result === "locked") setNotice("taskLocked");
      if (result === "unconfirmed") setNotice("deleteUnconfirmed");
      if (result === "unavailable") setNotice("deleteUnavailable");
    });
    setRequesting(false);
    if (menu?.isConnected) menu.querySelector("summary")?.focus();
  }

  async function openCodeProject(trigger: HTMLButtonElement) {
    await act(async () => {
      if (await window.desktop.chooseRoot()) setCodeReferences([]);
    });
    if (trigger.isConnected) trigger.focus();
  }

  async function attachCodeReferences(kind: CodeReference["kind"], button: HTMLButtonElement) {
    const menu = button.closest("details");
    menu?.removeAttribute("open");
    const namespace = previousNamespace.current;
    setRequesting(true);
    await act(async () => {
      const result = await window.desktop.chooseCodeReferences(kind);
      if (previousNamespace.current !== namespace) return;
      setCodeReferences(result.references);
      if (result.rejected) setNotice("rejectedReferences");
    });
    setRequesting(false);
    menu?.querySelector("summary")?.focus();
  }

  async function queueDraft() {
    if (!queueTarget || !canQueue) return;
    const submitted = prompt;
    const namespace = previousNamespace.current;
    setRequesting(true);
    nearBottom.current = true;
    await act(async () => {
      if (!await window.desktop.queueMessage(queueTarget, { kind: "add", text: submitted })) throw new Error("The message was not queued.");
      if (previousNamespace.current === namespace && composer.current?.value === submitted) changeDraft("");
    });
    setRequesting(false);
  }

  /** Adds text (review comments, a finding to fix) after what is already typed in the instruction box. */
  function insertIntoDraft(text: string) {
    const next = prompt.trimEnd() ? `${prompt.trimEnd()}

${text}` : text;
    if (next.length > MAX_CODE_PROMPT_CHARACTERS) return false;
    changeDraft(next);
    return true;
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    // /review opens the review panel; it is a command for the app, not an instruction for the agent.
    const reviewCommand = parseReviewCommand(prompt);
    if (reviewCommand && task && canReview(task)) {
      window.dispatchEvent(new CustomEvent(REVIEW_OPEN_EVENT, { detail: reviewCommand }));
      changeDraft("");
      return;
    }
    // One instruction can wait to be sent into the running turn; a second one waits in the queue.
    if (canQueue && task?.pendingFollowUp) {
      await queueDraft();
      return;
    }
    if (!canSendCode) return;
    if (canFollowUp && followUpTarget) {
      const submitted = prompt;
      const namespace = previousNamespace.current;
      setRequesting(true);
      nearBottom.current = true;
      await act(async () => {
        if (!await window.desktop.followUp(followUpTarget, submitted)) throw new Error("The instruction was not confirmed.");
        if (previousNamespace.current === namespace && composer.current?.value === submitted) changeDraft("");
      });
      setRequesting(false);
      return;
    }
    const { executionMode } = codeRoute;
    if (!selectedModel || (executionMode !== "tomverse_api" && !(cliFixtureModel && executionMode === "provider_cli"))) return;
    setRequesting(true);
    nearBottom.current = true;
    await act(async () => {
      await window.desktop.start({ prompt, model: selectedModel.id, mode: codeMode, effort: cliFixtureModel ? "default" : effort,
        saveHistory: pluginConnectionId ? false : cliFixtureModel ? !!snapshot?.cliFixtureHistory && saveNativeHistory : saveHistory,
        handoffId: codeHandoff?.id, executionMode, pluginConnectionId, workspace: workspaceChoice,
        referenceIds: codeReferences.map(({ id }) => id),
        ...(!cliFixtureModel && engine.limits !== "standard" ? { limits: engine.limits } : {}),
        ...(!cliFixtureModel && engine.goal && codeMode === "agent" ? { goal: true } : {}),
        permissionProfile: codeMode === "agent" && executionMode === "tomverse_api" ? snapshot?.projectPermissionProfile : undefined });
      changeDraft("");
      setSaveHistory(true);
      setCodePlugin(undefined);
      setWorkspaceSelection(undefined);
      setCodeReferences([]);
      setHistoryDraft(false);
    });
    setRequesting(false);
  }

  function resizeHistory(event: PointerEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const initial = historyWidth;
    const move = (pointer: globalThis.PointerEvent) => setHistoryWidth(Math.max(168, Math.min(360, initial + pointer.clientX - start)));
    const clear = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("lostpointercapture", clear);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", clear);
  }

  const codeHistoryControl = <label className="code-retention">
    <input type="checkbox" checked={!pluginConnectionId && (cliFixtureModel ? !!snapshot?.cliFixtureHistory && saveNativeHistory : saveHistory)}
      disabled={!!pluginConnectionId || busy || pausedForInput || (!!cliFixtureModel && !snapshot?.cliFixtureHistory)}
      onChange={(event) => (cliFixtureModel ? setSaveNativeHistory : changeSaveHistory)(event.currentTarget.checked)} />
    {copy.saveHistory}
  </label>;
  const openCodeHistory = () => { select("code"); setHistoryOpen(true); };
  const alertText = notice ? copy[notice].replace("{limit}", MAX_CODE_REFERENCES.toLocaleString(language)) : "";
  return <div className="desktop" style={{ "--history-width": `${historyWidth}px` } as React.CSSProperties}
    onKeyDown={(event) => {
      if (!settingsView || event.defaultPrevented || event.key !== "Escape" || event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      closeSettings();
    }}>
    <nav className="rail" aria-label={copy.workspaces}>
      <img className="logo" src={logo} width="36" height="36" alt="Tomverse" />
      <div className="rail-tools">
        {nav.map(({ id, label, icon: Icon }) => <button key={id} className="rail-tool" type="button" aria-pressed={surface === id} title={names[id]}
          onClick={() => select(id)}><Icon size={21} aria-hidden="true" /><span>{label ?? names[id]}</span></button>)}
      </div>
      <div className="rail-footer">
        <button className="rail-tool rail-help" type="button" aria-label={controls.help} title={controls.help}
          onClick={() => void act(() => openDocs("help"))}><CircleHelp size={19} aria-hidden="true" /><span>{controls.help}</span></button>
        <button ref={settingsTrigger} type="button" className="rail-tool rail-settings" aria-pressed={surface === "settings"} title={common.settings}
          onClick={() => settingsView ? closeSettings() : openSettings()}>
          <SlidersHorizontal size={19} aria-hidden="true" /><span>{common.settings}</span>
        </button>
        {account && account.stage !== "unavailable" &&
          <button className="rail-tool rail-account" type="button" aria-label={accountShortcut} title={accountShortcut} onClick={() => openSettings("account")}>
            {account.stage === "connected"
              ? <span className="rail-avatar" aria-hidden="true">{Array.from(account.label.trim())[0]?.toLocaleUpperCase(language) || "T"}</span>
              : <><CircleUserRound size={19} aria-hidden="true" /><span>{controls.signIn}</span></>}
          </button>}
      </div>
    </nav>
    {historyOpen && <aside id="desktop-history" className={textHistory ? "history history--chat" : "history"} aria-label={copy.history}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next && next !== historyToggle.current && !event.currentTarget.contains(next) && matchMedia(compactHistoryQuery).matches) {
          setHistoryOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== "Escape" || event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 || !matchMedia(compactHistoryQuery).matches) return;
        event.preventDefault();
        setHistoryOpen(false);
        historyToggle.current?.focus();
      }}>
      <div className="history-header">
        <h1 ref={historyHeading} className={surface === "code" ? "tomverse-wordmark" : undefined} tabIndex={-1}>
          {chatRail ? <><img src={logo} alt="" /><TomverseWordmark /></> : names[surface]}
        </h1>
        {surface === "code" && <button ref={historySearchToggle} className="icon" type="button" aria-label={copy.searchHistory} aria-expanded={searchOpen}
          aria-controls={searchOpen ? "code-history-filter" : undefined}
          onClick={() => searchOpen ? closeCodeHistorySearch() : setSearchOpen(true)}><Search size={18} /></button>}
        {textHistory && <button className="icon" type="button" aria-label={controls.help} title={controls.help}
          onClick={() => void act(() => openDocs("help"))}><CircleHelp size={17} aria-hidden="true" /></button>}
      </div>
      {nativeImages && <ImageHistoryList workspace={images} onClose={() => setImagesOpen(false)} />}
      {chatRail && <ChatHistory key={`chat:${accountDraft}`} chat={chat} busy={chatAttachments.uploading} canModify={snapshot?.capabilities?.chatWrite === true}
        onImages={imageCapability ? () => setImagesOpen(true) : undefined} onImport={openImportedConversations} />}
      {nativeReview && !nativeImages && <ChatHistory key={`review:${accountDraft}`} chat={review} product="review" busy={reviewRun.running || reviewAttachments.uploading} />}
      {settingsView && <div className="settings-navigation">
        <nav aria-label="Tomverse">
          <span aria-hidden="true">Tomverse</span>
          {ACCOUNT_SETTINGS_TABS.map((tab) => <button key={tab} type="button" data-testid={`desktop-settings-${tab}`}
            aria-current={tab === settingsView || (importsOpen && tab === "data") ? "page" : undefined}
            onClick={() => openSettings(tab)}>{settingsCopy[tab]}</button>)}
        </nav>
        <nav aria-label="Tomverse Code">
          <span aria-hidden="true">Tomverse Code</span>
          {codeSettings.map(({ id, name }) => <button key={id} type="button"
            aria-current={id === settingsView || (id === "list" && cliSettingsProvider) ? "page" : undefined}
            disabled={id === "list" && !cliSettingsEnabled} onClick={() => openSettings(id)}>{name}</button>)}
        </nav>
      </div>}
      {surface === "code" && <>
        <button className="soft new-task" type="button" disabled={busy} onClick={() => {
          setOpenBrowserScope(null);
          setHistoryDraft(false);
          setRequesting(true);
          void act(() => window.desktop.newTask()).finally(() => {
            setRequesting(false);
            composer.current?.focus();
          });
        }}><Plus size={14} /> {copy.newTask}</button>
        {searchOpen && <input id="code-history-filter" className="history-search" aria-label={copy.filterHistory} autoFocus value={search}
          onChange={(event) => setSearch(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            closeCodeHistorySearch();
          }} />}
        <div className="projects">
          {snapshot?.project && <details open>
            <summary><Folder size={16} /> <span>{snapshot.project}</span></summary>
            {visibleCodeHistory.length === 0 && <p className="notice" role="status">
              {historyFilter ? copy.noHistoryMatches : copy.emptyCodeHistory}
            </p>}
            <ul>
              {visibleCodeHistory.map((entry) => <li key={entry.id}>
                <button type="button" disabled={busy} aria-current={task?.id === entry.id ? "page" : undefined} title={entry.title}
                  onClick={() => { setOpenBrowserScope(null); setHistoryDraft(true); nearBottom.current = true; void act(() => window.desktop.openHistory(entry.id)); }}>
                  <span>{entry.title}</span>
                </button>
              </li>)}
            </ul>
            {snapshot.moreHistory && <button className="soft" type="button" onClick={() => void act(() => window.desktop.moreHistory())}>{copy.moreTasks}</button>}
          </details>}
        </div>
        <button type="button" className="soft open-folder" disabled={busy} onClick={(event) => void openCodeProject(event.currentTarget)}>{copy.openLocalFolder}</button>
      </>}
      <div className="resize" role="separator" tabIndex={0} aria-label={copy.resizeHistory} aria-orientation="vertical"
        onPointerDown={resizeHistory} onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            setHistoryWidth((width) => Math.min(360, Math.max(168, width + (event.key === "ArrowRight" ? 12 : -12))));
          }
        }} />
    </aside>}
    <main className="work" onDragOver={(event) => {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    }} onDrop={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      if (nativeImages) return;
      if (nativeChat && !chat.sending) chatAttachments.onDrop(event);
      if (nativeReview && !reviewRun.running) reviewAttachments.onDrop(event);
    }}>
      <header className="header">
        <strong>{nativeImages ? (images.rows.find((row) => row.id === images.selected)?.title ?? chatCopy.imageWorkspace)
          : nativeChat ? (chat.selected ? chatTitle(chat.selected, language) : common.newChat)
          : nativeReview ? (review.selected ? chatTitle(review.selected, language) : chatCopy.newReview)
            : surface === "code" ? (task?.unreadable ? native.unreadableTask : task?.title || copy.newCodeTask)
              : settingsTitle ?? names[surface]}</strong>
        <div className="header-tools">
          {selectedExcerpt && handoffSource && <button className="soft" type="button" disabled={busy || chat.sending || chat.writing}
            onMouseDown={(event) => event.preventDefault()} onClick={() => void handoffSelection()}>
            {handoffSource === "chat" ? filesCopy.useInCode : filesCopy.useInChat}
          </button>}
          {surface === "code" && snapshot?.project && <span className="project-label" title={snapshot.root ?? undefined}><Folder size={16} />{snapshot.project}</span>}
          {surface === "code" && task?.worktree && <CodeWorkspaceDetails language={language} worktree={task.worktree} />}
          {surface === "code" && task?.id && task.savedLocally && snapshot?.history.some((row) => row.id === task.id) &&
            <details className="chat-conversation-actions">
              <summary className="icon" aria-label={copy.codeActions}><Ellipsis size={18} /></summary>
              <div className="chat-action-menu">
                <button type="button" disabled={busy} onClick={(event) => {
                  const menu = event.currentTarget.closest("details");
                  menu?.removeAttribute("open");
                  if (task.id) void deleteLocalTask(task.id, menu);
                }}>{native.deleteHistoryAccept}</button>
              </div>
            </details>}
          {surface === "code" && task?.id && task.savedLocally && !task.unreadable && !busy &&
            snapshot?.history.some((row) => row.id === task.id) &&
            <TaskGithubPulls key={snapshot.draftNamespace + task.id} language={language} onVisibilityChange={setGithubDialogOpen} />}
          {canShowBrowser && <button className="icon" type="button" aria-label={codeBrowserLabel(language)}
            aria-expanded={browserOpen} aria-controls={browserOpen ? "code-browser-panel" : undefined}
            onClick={() => setOpenBrowserScope(browserOpen ? null : browserScope)}><Globe size={18} /></button>}
          {(nativeChat || nativeReview) && <button className="soft chat-header-usage" type="button" title={usageLabel}
            onClick={() => openSettings("plan")}><ChartNoAxesColumnIncreasing size={15} aria-hidden="true" /> {usageLabel} {usageValue == null ? "—" : `${usageValue}%`}</button>}
          <button className="icon" aria-label={theme === "dark" ? copy.useLight : copy.useDark} type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}</button>
          <button ref={historyToggle} className="icon" type="button" aria-label={historyOpen ? copy.hideHistory : copy.showHistory}
            aria-expanded={historyOpen} aria-controls={historyOpen ? "desktop-history" : undefined}
            onClick={() => setHistoryOpen(!historyOpen)}><PanelLeft size={18} /></button>
          {settingsView ? <button className="icon" type="button" aria-label={common.close} onClick={closeSettings}><X size={18} /></button>
            : nativeChat && !nativeImages && chat.selected
              ? <ChatConversationActions key={chat.selected.id} chat={chat} canModify={snapshot?.capabilities?.chatWrite === true} />
              : nativeReview && review.selected
                ? <ChatConversationActions key={review.selected.id} chat={review} canModify={false} />
              : <button className="icon" type="button" aria-label={copy.desktopSettings} onClick={() => openSettings()}><Ellipsis size={18} /></button>}
        </div>
      </header>
      {webView && <WebViewer state={webView} language={language} />}
      {handoffNotice && <p className="offline-notice" role="alert">
        {filesCopy[handoffNotice].replace("{limit}", MAX_HANDOFF_EXCERPT_CHARACTERS.toLocaleString(language))}
      </p>}
      {!online && (surface === "code" || nativeChat || nativeReview) && <p id="desktop-offline" className="offline-notice" role="status">
        {copy.offline}
      </p>}
      {surface === "code" ? <div className="code-with-browser"><div className="code-column">
        <div className="scroll" ref={scroll} onScroll={(event) => {
          const pane = event.currentTarget;
          const viewport = scrollViewport.current;
          // Reflow can dispatch a scroll event before the resize observer restores the tail.
          if (!viewport || viewport.width !== pane.clientWidth || viewport.height !== pane.clientHeight) return;
          nearBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 48;
        }}>
          <div className="content">
            {task ? <TaskConversation task={task} models={task.continuation?.stage === "started" ? snapshot?.models ?? [] : models}
              language={language} openSettings={() => openSettings("execution")} onRewound={surface === "code" ? changeDraft : undefined} insertReview={surface === "code" ? insertIntoDraft : undefined}
              engine={surface === "code" ? <CodeEngineBar task={task} language={language} idle={!busy && online} /> : null} /> : <section className="welcome">
              <h2>{copy.build}</h2>
              <div className="project-picker"><button type="button" className="soft" title={snapshot?.root ?? undefined} disabled={busy}
                onClick={(event) => void openCodeProject(event.currentTarget)}>
                <Folder size={19} /> {snapshot?.project ?? copy.openFolder} <ChevronDown size={14} /></button>
                {snapshot?.project && <span>{copy.localProject}</span>}
              </div>
            </section>}
          </div>
        </div>
        <div className="composer-slot">
          {alertText && <p className="notice" role="alert">{alertText}</p>}
          {task && surface === "code" && <BackgroundPanel task={task} language={language} live={!!snapshot?.busy && task.execution?.executionMode === "tomverse_api"} />}
          {task && surface === "code" && <SubagentPanel task={task} language={language} />}
          {task && surface === "code" && <QueuePanel task={task} language={language} live={!!queueTarget} />}
          {historyDraft && !busy && !waitingForAnswer && <p className="notice">{copy.newHistoryRequest}</p>}
          <div className="code-readiness">
            <span id="code-readiness" role="status">{needsCodeProject ? copy.chooseProjectToSend : codeStatus}</span>
            {needsCodeProject && <span>{codeStatus}</span>}
            {canReloadCatalog && <button className="soft" type="button" onClick={() => {
              composer.current?.focus();
              void act(() => window.desktop.retryCodeCatalog());
            }}>{copy.reloadCodeModels}</button>}
            {canChooseApi && <button className="soft" type="button" onClick={() => {
              composer.current?.focus();
              void act(() => window.desktop.setCodeExecutionPreference("tomverse_api"));
            }}>{executionCopy.useApi}</button>}
            {!busy && online && needsCodeConnection && account?.stage !== "unavailable" &&
              <button className="soft" type="button" onClick={() => {
                const connected = account?.stage === "connected";
                connectionHeading.current = connected ? "desktop-code-key" : "desktop-account";
                openSettings(connected ? "developer" : "account");
              }}>
                {account?.stage === "connected" ? copy.connectCodeKey : controls.account}
              </button>}
          </div>
          <form className="composer" onSubmit={send} aria-label={copy.codeComposer}>
            <div className="code-composer-body">
              {codeHandoff && <HandoffDraft handoff={codeHandoff} busy={Boolean(busy)} language={language} />}
              <textarea ref={composer} aria-label={copy.codeRequest} aria-describedby={online ? "code-readiness" : "desktop-offline"}
                placeholder={task ? copy.followUp : copy.firstRequest} value={prompt}
                onChange={(event) => changeDraft(event.currentTarget.value)} maxLength={MAX_CODE_PROMPT_CHARACTERS}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                    event.preventDefault(); event.currentTarget.form?.requestSubmit();
                  }
                }} />
              {!!codeReferences.length && <ul className="attachment-draft" aria-label={copy.projectReferences}>
                {codeReferences.map((reference) => <li key={reference.id}>
                  <CodeReferenceLabel reference={reference} copy={copy} />
                  <button className="icon" type="button" disabled={busy} aria-label={copy.removeReference.replace("{path}", () => reference.path)}
                    onClick={() => void act(async () => {
                      await window.desktop.removeCodeReference(reference.id);
                      setCodeReferences((current) => current.filter(({ id }) => id !== reference.id));
                    })}><X size={13} /></button>
                </li>)}
              </ul>}
            </div>
            <div className="composer-actions">
              {snapshot?.draftNamespace && <details className="model-menu code-attach-menu">
                <summary className="icon" aria-label={copy.attachReferences}><Plus size={18} /></summary>
                <div className="model-popover">
                  <button className="soft" type="button" disabled={busy || pausedForInput || codeReferences.length >= MAX_CODE_REFERENCES}
                    onClick={(event) => void attachCodeReferences("file", event.currentTarget)}><File size={15} /> {copy.attachFiles}</button>
                  <button className="soft" type="button" disabled={busy || pausedForInput || codeReferences.length >= MAX_CODE_REFERENCES}
                    onClick={(event) => void attachCodeReferences("folder", event.currentTarget)}><Folder size={15} /> {copy.attachFolders}</button>
                </div>
              </details>}
              <select aria-label={copy.codeMode} value={codeMode} disabled={busy || pausedForInput}
                onChange={(event) => setMode(event.currentTarget.value as StartInput["mode"])}>
                <option value="agent" disabled={!!cliFixtureModel && !snapshot?.nativeFixtureEdits}>{copy.agent}</option>
                <option value="ask">{copy.ask}</option><option value="plan">{copy.plan}</option>
              </select>
              {codeGit && snapshot?.root && !pausedForInput && <CodeWorkspacePicker key={snapshot.root} git={codeGit} root={snapshot.root}
                choice={workspaceChoice} language={language} disabled={Boolean(busy)}
                select={(choice) => setWorkspaceSelection({ key: workspaceKey, choice })} />}
              {snapshot?.projectPermissionProfile && codeMode === "agent" && codeRoute.executionMode === "tomverse_api"
                ? <PermissionProfileSelect profile={snapshot.projectPermissionProfile} language={language} disabled={busy || pausedForInput} act={act} />
                : <span className="permission"><ShieldCheck size={15} /> {copy.manual}</span>}
              {codeHistoryControl}
              {pluginNamespace && <CodePluginPicker key={pluginNamespace} language={language} value={pluginConnectionId ?? ""}
                disabled={Boolean(busy || pausedForInput || canFollowUp)} select={(id) => setCodePlugin(id ? { id, namespace: pluginNamespace } : undefined)} />}
              <div className="spacer" />
              {(composerModelId || !catalogUnavailable) && <details className="model-menu">
                <summary aria-label={copy.modelEffort}><Sparkles size={15} />
                  <span>{composerModelName}
                    {composerEffort !== "default" && ` · ${effortLabel(language, composerEffort)}`}</span><ChevronDown size={14} />
                </summary>
                <div className="model-popover">
                  <label>{copy.model}<select aria-label={copy.model} value={composerModelId} disabled={busy || pausedForInput || !models.length}
                    onChange={(event) => setModelId(event.currentTarget.value)}>
                    {!models.length && !composerModelId && <option value="">{copy.noConnectedModels}</option>}
                    {composerModelId && !models.some(({ id }) => id === composerModelId) && <option value={composerModelId}>{composerModelName}</option>}
                    {models.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                  </select></label>
                  <label>{copy.reasoningEffort}<select aria-label={copy.reasoningEffort} value={composerEffort} disabled={busy || pausedForInput || !!cliFixtureModel}
                    onChange={(event) => setEffort(event.currentTarget.value as StartInput["effort"])}>
                    {effortOptions(selectedModel?.efforts, composerEffort).map((value) => <option value={value} key={value}>{effortLabel(language, value)}</option>)}
                  </select></label>
                  {!taskSelectionLocked && !cliFixtureModel && effort !== "default" && selectedModel && selectedModel.id !== "smart-adaptive" && !selectedModel.efforts.includes(effort) &&
                    <small>{copy.effortFallback}</small>}
                </div>
              </details>}
              {snapshot?.deviceFixtureAvailable && snapshot.draftNamespace && <DraftDictation language={language} disabled={busy}
                maxLength={MAX_CODE_PROMPT_CHARACTERS} scope={snapshot.draftNamespace + ":" + (task?.id ?? "new")} draft={prompt} setDraft={changeDraft} />}
              {codeMode === "ask" && snapshot?.draftNamespace && <ChatDraftLocation location={codeAskLocation} language={language}
                draft={prompt} setDraft={changeDraft} maxLength={MAX_CODE_PROMPT_CHARACTERS} disabled={Boolean(busy || pausedForInput)} deviceLocation={false} />}
              {queueTarget && <button className="soft" type="button" disabled={!canQueue} onClick={() => void queueDraft()}>
                {desktopCodeEngineCopy[language].queueAdd}</button>}
              <button className="send" type="submit" aria-label={snapshot?.busy || pausedForInput ? copy.sendFollowUp : copy.sendCode}
                title={queueTarget ? desktopCodeEngineCopy[language].sendNow : undefined}
                disabled={!canSendCode && !(canQueue && !!task?.pendingFollowUp)}><ArrowUp size={19} /></button>
              {snapshot?.busy && <button className="icon stop" type="button" aria-label={copy.stopCode} onClick={() => void act(() => window.desktop.stop())}><Square size={15} /></button>}
            </div>
          </form>
        </div>
      </div>{canShowBrowser && browserOpen && <CodeBrowser language={language}
        canShare={snapshot?.codeBrowserInspection === true && task?.status === "running"}
        hidden={historyOpen && matchMedia(compactHistoryQuery).matches} occluded={githubDialogOpen || webView !== null} onClose={() => setOpenBrowserScope(null)} />}
      </div> : nativeImages ? <ImageWorkspace key={images.seedVersion} workspace={images} capability={imageCapability} />
        : nativeChat ? <>{reviewReference && <div className="review-reference" role="status">
          <p>{reviewCopy.referencePrompt}</p>
          <button className="primary" type="button" onClick={() => {
            const previous = chat.newDraft().trimEnd() || chat.draft.trimEnd();
            const combined = previous ? `${previous}\n\n${reviewReference}` : reviewReference;
            setReviewReference("");
            void chat.open(null).then(() => chat.setDraft(combined));
          }}>{reviewCopy.addToDraft}</button>
          <button className="soft" type="button" onClick={() => setReviewReference("")}>{reviewHandoff.cancel}</button>
        </div>}<ChatWorkspace chat={chat} chatWrite={snapshot?.capabilities?.chatWrite === true}
        autoOffered={snapshot?.capabilities?.autoSelection === true} preferredModelId={accountModels?.[0]}
        plan={(usage?.account === accountDraft ? usage?.plan : undefined) ?? snapshot?.capabilities?.review?.plan ?? "Free"}
        imageCapability={imageCapability} onModelImage={openImageModel}
        deepResearch={snapshot?.capabilities?.deepResearch} composerTools={snapshot?.capabilities?.composerTools} searchReadiness={snapshot?.capabilities?.searchReadiness}
        connectors={snapshot?.capabilities?.plugins === true} onManageConnectors={() => select("plugins")}
        onImport={openImportedConversations}
        onCompare={snapshot?.capabilities?.review ? (prompt, id) => void act(() => compareFromChat(prompt, id)) : undefined}
        starters={snapshot?.capabilities?.chatStarters} attachments={chatAttachments} online={online}
        deviceFixture={snapshot?.deviceFixtureAvailable === true}
        handoff={handoff?.target === "chat" ? handoff : undefined} /></> : nativeReview ? <ReviewWorkspace history={review}
          capability={snapshot?.capabilities?.review ?? null} run={reviewRun} preferredModelIds={accountModels}
          analysisEnabled={snapshot?.capabilities?.reviewAnalysis} searchReadiness={snapshot?.capabilities?.searchReadiness}
          imageCapability={imageCapability} onModelImage={openImageModel}
          onFollowUp={snapshot?.capabilities?.chatWrite ? openReviewReference : undefined}
          attachments={reviewAttachments} online={online} dictation={snapshot?.deviceFixtureAvailable === true}
          onImageStarter={imageCapability ? openImageStarter : undefined}
          onImages={(offer) => { images.offerImages(offer); setImagesOpen(true); }} />
        : <div className="scroll"><div className="content">
        {settingsView ? cliSettingsOpen && cliSettingsEnabled && snapshot
          ? <ProviderCliSettings language={language} paths={snapshot.cliPaths} supportedPaths={snapshot.supportedCliPaths}
            provider={cliSettingsProvider}
            goTo={setSettingsView} authFixture={snapshot.cliAuthFixture} protocolCheckAvailable={snapshot.cliProtocolCheckAvailable} />
          : settingsView === "execution" ? <CodeExecutionSettings key={snapshot?.codeFallback?.scope ?? "disconnected"}
            snapshot={snapshot} language={language} actionFailed={notice === "actionFailed"} act={act}
            engine={engine} changeEngine={changeEngine} />
          : <section className="execution-settings settings">
          <h2 id={settingsView === "account" ? "desktop-account" : undefined} tabIndex={-1}>{settingsTitle}</h2>
          {settingsView === "permissions" && <div className="desktop-setting-section">
            {snapshot?.projectPermissionProfile
              ? <PermissionProfileSelect profile={snapshot.projectPermissionProfile} language={language} disabled={busy} act={act} />
              : <span className="permission"><ShieldCheck size={15} aria-hidden="true" /> {copy.manual}</span>}
          </div>}
          {settingsView === "local-history" && <div className="execution-setting-row">
            <div>{codeHistoryControl}<small>{privacyCopy.historyDetail}</small></div>
            <button className="soft" type="button" onClick={openCodeHistory}>{privacyCopy.manageHistory}</button>
          </div>}
          {settingsView === "account" && <section className="desktop-setting-section">
          <h3>{controls.account}</h3>
          {account?.detail && <p role="status">{native[account.detail]}</p>}
          {account?.stage === "connected" ? <>
            <p role="status">{controls.connectedAs.replace("{account}", () => account.label)}</p>
            {account.storage === "session" && <p>{controls.sessionStorage}</p>}
            <button className="soft" type="button" onClick={() => void act(() => window.desktop.signOut())}>{controls.signOut}</button>
          </> : account?.stage === "restoring" ? <p role="status">{controls.restoring}</p>
            : account?.stage === "signing-out" ? <p role="status">{controls.signingOut}</p>
            : account?.stage === "waiting" ? <>
              <p role="status">{controls.continueSignin}</p>
              <button className="soft" type="button" onClick={() => void act(() => window.desktop.cancelSignIn())}>{controls.cancelSignin}</button>
            </> : <>
              {account?.stage === "failed" && <p role="alert">{controls.signinFailed}</p>}
              {account?.stage === "expired" && <p role="status">{controls.sessionExpired}</p>}
              {account?.stage === "unavailable" ? <p>{controls.signinUnavailable}</p>
                : <button className="soft" type="button" disabled={!account} onClick={() => void act(() => window.desktop.signIn())}>
                  <ExternalLink size={16} /> {controls.signInBrowser}
                </button>}
            </>}
          </section>}
          {accountPanel && account?.stage === "connected" && <AccountSettings key={settingsAccount}
            tab={accountPanel} language={language} onApply={applyAccountPreferences} onContinue={openImportedConversation}
            onOpenImports={() => openSettings("imports")} onBackToData={() => openSettings("data")} />}
          {account?.stage !== "connected" && settingsView === "preferences" &&
            <LocalPreferences language={language} theme={theme} setLanguage={next => void act(() => window.desktop.setLanguage(next))} setTheme={setTheme} />}
          {account?.stage !== "connected" && settingsView === "ai" && <LocalMemoryPrivacy language={language} openHistory={openCodeHistory} />}
          {settingsView === "preferences" && <section className="desktop-setting-section">
          {snapshot?.codeNotifications.available && <label className="code-retention">
            <input type="checkbox" checked={snapshot.codeNotifications.enabled} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void act(() => window.desktop.setCodeNotifications(enabled));
            }} />
            {controls.notifyCode}
          </label>}
          <h3>{controls.updates}</h3><p>Tomverse Desktop {snapshot?.version}</p>
          <p role="status">{update?.detail ? native[update.detail]
            : update?.stage === "ready" ? controls.updateReady : update?.stage === "downloading" ? controls.updateDownloading
              : update?.stage === "checking" ? controls.updateChecking : ""}</p>
          {update?.stage === "ready"
            ? <button className="soft" disabled={busy} onClick={() => void act(() => window.desktop.installUpdate())}>{controls.restartUpdate}</button>
            : <button className="soft" disabled={update?.stage !== "idle" && update?.stage !== "failed"} onClick={() => void act(() => window.desktop.checkUpdate())}>{controls.checkUpdates}</button>}
          {busy && update?.stage === "ready" && <p>{controls.restartWait}</p>}
          </section>}
          {settingsView === "developer" && account?.stage === "connected" && <section className="desktop-setting-section">
            <h3 id="desktop-code-key" tabIndex={-1}>{controls.codeKey}</h3>
            {codeKey?.stage === "connected" && <p>{(codeKey.storage === "session" ? controls.sessionKey : controls.connectedAs)
              .replace("{account}", () => codeKey.prefix)}</p>}
            {codeKey?.detail && <p role="status">{native[codeKey.detail]}</p>}
            {codeCatalog === "failed" && <p role="status">{native.codeCatalogFailure}</p>}
            <button className="soft" type="button" disabled={busy || codeKey?.stage === "checking"}
              onClick={() => void act(() => window.desktop.connectCopiedCodeKey())}>
              {codeKey?.stage === "checking" ? controls.checkingKey : controls.connectCopiedKey}
            </button>
          </section>}
        </section> : surface === "plugins" && account?.stage === "connected" && snapshot?.capabilities?.plugins
          ? <ConnectorWorkspace key={account.label} language={language} /> : <section className="welcome" data-testid="desktop-surface-unavailable">
          <h2>{names[surface]}</h2>{surface === "plugins" ? account?.stage === "connected" && <p>{mcpConnectorCopy[language].disabled}</p>
            : surface !== "chat" && <p>{copy.unavailable}</p>}
          {surface === "chat" && snapshot?.capabilities?.autoSelection && <p>{copy.autoOffered}</p>}
          {(surface === "chat" || surface === "settings" || account?.stage !== "connected") &&
            <button className="soft" type="button" onClick={() => openSettings("account")}>{controls.signIn}</button>}
        </section>}
        {alertText && <p className="notice" role="alert">{alertText}</p>}
      </div></div>}
    </main>
  </div>;
}

function Approval() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [answering, setAnswering] = useState(false);
  const language = request?.language ?? readLanguage();
  const copy = desktopControlsCopy[language];
  const engineCopy = desktopCodeEngineCopy[language];
  useEffect(() => {
    applyTheme(localStorage.getItem("tomverse.theme") === "light" ? "light" : "dark");
    void window.approvalHost.approval().then(setRequest, () => setRequest(null));
  }, []);
  useLayoutEffect(() => { document.documentElement.lang = language; }, [language]);
  if (!request) return <main className="approval"><h1>{copy.reviewAction}</h1><p>{copy.waitingForApproval}</p></main>;
  const current = request;
  async function decide(action: "once" | "run" | "deny") {
    setAnswering(true);
    try {
      if (!await window.approvalHost.decide({ id: current.id, action })) setAnswering(false);
    } catch { setAnswering(false); }
  }
  return <main className="approval">
    <header><ShieldCheck size={24} /><h1>{copy.reviewAction}</h1></header>
    <div className="approval-content">
      <p><strong>{request.tool}</strong></p><p><code>{request.root}</code></p>
      {request.explanation && <p>{request.explanation}</p>}
      {request.web && <section aria-label={engineCopy.approvalWebHeading}>
        <h2>{engineCopy.approvalWebHeading}</h2>
        <dl>
          <dt>{engineCopy.approvalWebHost}</dt><dd><code>{request.web.host}</code></dd>
          <dt>{engineCopy.approvalWebAddress}</dt><dd><code>{request.web.url}</code></dd>
        </dl>
        <p role="note">{engineCopy.approvalWebNote}</p>
      </section>}
      {request.command && <section aria-label={copy.commandDetails}>
        <h2>{copy.exactCommand}</h2>
        <pre>{request.command.display}</pre>
        <dl>
          <dt>{copy.executable}</dt><dd><code>{request.command.file}</code></dd>
          <dt>{copy.arguments}</dt><dd><pre>{JSON.stringify(request.command.args, null, 2)}</pre></dd>
          <dt>{copy.workingDirectory}</dt><dd><code>{request.command.cwd}</code></dd>
          <dt>{copy.environment}</dt><dd><code>{request.command.env.join(", ") || copy.none}</code></dd>
          <dt>{copy.timeout}</dt><dd>{request.command.background ? engineCopy.approvalNoTimeout : `${request.command.timeoutMs} ms`}</dd>
        </dl>
        {request.command.background && <p role="note"><strong>{engineCopy.approvalBackground}</strong></p>}
      </section>}
      {request.files?.map((file) => <section key={file.path} className="diff" aria-label={file.path}>
        <h2>{file.path} · {file.action === "create" || file.action === "update" || file.action === "delete" ? copy[file.action] : file.action}</h2>
        <p>{file.eol} · {file.bom ? copy.bomPresent : copy.bomAbsent}</p>
        <div className="diff-columns">
          <div><h3>{copy.before}</h3><pre>{file.before ?? copy.missingFile}</pre></div>
          <div><h3>{copy.after}</h3><pre>{file.after ?? copy.removedFile}</pre></div>
        </div>
      </section>)}
    </div>
    <footer>
      <button className="soft" autoFocus disabled={answering} onClick={() => void decide("deny")}>{copy.deny}</button>
      {request.canRemember && <button className="soft" disabled={answering} onClick={() => void decide("run")}>{copy.allowRun}</button>}
      <button className="primary" disabled={answering} onClick={() => void decide("once")}>{copy.allowOnce}</button>
    </footer>
  </main>;
}

const isLoginWindow = location.pathname === "/login";
if (isLoginWindow) document.documentElement.classList.add("dark", "login-window");
createRoot(document.getElementById("root")!).render(
  location.pathname === "/approval" ? <Approval /> : isLoginWindow ? <Login /> : <Desktop />,
);
