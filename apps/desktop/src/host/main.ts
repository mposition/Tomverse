import { selectDriveFiles } from "./drive-picker";
import { desktopResearchAnswerId } from "../../../../lib/desktopResearchAnswerId";
import { DEEP_RESEARCH_MODEL_ID } from "../../../../lib/deepResearchModel";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, utilityProcess } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { readGithubPull } from "./github-pr-read";
import { githubPullUrl, pullEvidence, taskPullCommand } from "../github-pr-contract";
import { dictationClip } from "../dictation-contract";
import { createCodeBrowserView } from "./code-browser-view";
import { createWebViewHost } from "./web-view-host";
import { browserCommand, loopbackBrowserUrl, MAX_CODE_BROWSER_TABS } from "../browser-contract";
import { createAccountSettingsApi } from "./account-settings-api";
import { sanitizeFileName } from "../../../../lib/exportConversation";
import { desktopAccountSettingsInput } from "../account-settings-contract";
import { solveEmailLoginChallenge } from "./login-challenge";
import { desktopIdentityProvider, desktopLoginEmail, type DesktopEmailResult, type DesktopLoginEmail } from "../login-contract";
import { link, open, readFile, realpath, unlink } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Journal, deleteSession, listSessions, Workspace, writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";
import { pathIdentity } from "../../../tomverse-cli/src/patch.js";
import { codePermissionProfile, codeReferenceKind, codeReferencePath, decisions, MAX_CODE_PROMPT_CHARACTERS, MAX_CODE_REFERENCES,
  MAX_HANDOFF_EXCERPT_CHARACTERS, followUpInput, sessionId, startInput, webDestination, workspaceHandoffInput,
  type ApprovalRequest, type CodeReference, type DeleteHistoryResult,
  type Decision, type RecoveryResult, type Snapshot, type Task, type UndoChangeResult, type WorkspaceHandoff, type WorkspaceHandoffInput } from "../contract";
import { antigravityFixtureExecution, claudeFixtureExecution, cliFilePath, cliPathInput, cliProvider, cliProviders, cliUsesInstallationFolder, cliUsesReleaseArchive, codexFixtureExecution, codeExecutionMode, codeRouteFor, isCliProtocolProvider, kimiFixtureExecution, qwenFixtureExecution, vibeFixtureExecution, deepSeekFixtureExecution, zCodeFixtureExecution, miniMaxFixtureExecution, grokFixtureExecution, supportsIsolatedCliAccount, tomverseApiExecution, unknownCliAccount,
  type NativeFixtureProvider,
  type CliPaths, type CliProtocolCheck, type CliProvider, type CodeExecutionMode, type SavedCliPath } from "../code-execution";
import { codeFallbackModelAvailable, codeCliContinuation, codeContinuation, codeFallbackSettings, codeFallbackUpdate, defaultCodeFallbackSettings, updateCodeFallbackSettings,
  type CodeCliContinuation, type CodeFallbackSettings, type CodeFallbackUpdate } from "../code-fallback";
import { desktopProviderCliCopy } from "../../../../locales/desktopProviderCli";
import { cliPathStillMatches, inspectCliPath, releaseArchiveName, supportsCliPath, watchVerifiedCliPath } from "./provider-cli-path";
import { probeIsolatedClaudeAccount } from "./claude-account";
import { probeIsolatedAcpAccount, probeIsolatedCliProtocol, probeIsolatedCodexAccount } from "./cli-protocol";
import {
  chatId, chatHistorySearchInput, chatPageInput, chatRenameInput, chatSourceInput, chatTurnInput, desktopTextProduct, reviewAnalysisRequest, reviewTurnInput, saveArtifactInput,
  type ChatTurnInput, type ChatTurnProgress, type ChatTurnResult, type DesktopTextProduct,
  type ReviewTurnInput, type ReviewTurnProgress, type ReviewTurnResult, type SaveArtifactInput,
} from "../chat-contract";
import { canAnswerClarification, canResumeJournal, canResumeQuotaJournal, cleanText, hasCredential, journalApiUsage, journalChanges, journalChecks, journalEntries, journalPendingFollowUp, journalPlan, journalQuota, journalReferences, journalStatus } from "./journal-view";
import { codeDiagnostics } from "./code-diagnostics";
import { cliFixtureInput, qwenFixtureInput, zCodeFixtureInput } from "./cli-fixture-input";
import { apiCliDirectory, nativeHistoryHome, nativeSessionDirectory, listNativeHistory, matchesNativeContinuation, readNativeCheckpoint, readNativeHistory,
  restoredNativeTask, saveApiCliHistory, saveNativeHistory, stagedNativeDirectory } from "./native-history";
import { codeHistoryScope, matchesHistory, type HistoryScope } from "./history-scope";
import type { Connection, WorkerCommand, WorkerEvent } from "./messages";
import { assertProjectRoot, bindProjectRoot, claimCodeProject, type ProjectRoot } from "./project-root";
import { createManagedWorktree, readGitProject, readManagedWorktree, worktreeBranch, worktreePath,
  type GitProject, type ManagedWorktree } from "./git-worktree";
import { configureUpdates } from "./updates";
import { appendTaskPage, nextTaskPage } from "./taskPaging";
import {
  DesktopSessionRefused, readBrowserAccount, refreshBrowserSession, revokeBrowserSession, signInByDesktopEmail,
  signInThroughBrowser, type BrowserAccount, type BrowserSession,
} from "./browser-login";
import { createCodeKeyVault, createSessionVault, type StorageMode, type StoredDesktopSession } from "./session-vault";
import { readDesktopCapabilities } from "./desktop-capabilities";
import { CodeKeyRefused, readCopiedCodeKey, verifyCodeKey } from "./code-key";
import { DESKTOP_LIVE_ORIGIN, type DesktopIdentityProvider } from "../../../../lib/desktopAuthContract";
import { DESKTOP_APP_ORIGIN } from "../../../../lib/desktopReadApiContract";
import { DesktopChatContextChanged, desktopChatApi } from "./chat-api";
import { desktopCodeNotice } from "./desktop-notice";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../../lib/chatRequestLimits";
import { imageRequest } from "../images-contract";
import { imageDownloadExtension, imageDownloadFilename } from "../../../../lib/imageAssetDownload";
import { IMAGE_QUALITY_BY_PRESET } from "../../../../lib/imageGenerationPricing";
import { attachmentBytesInput, driveImportInput, type AttachmentBytesInput, type AttachmentUpload, type DriveImportInput } from "../attachment-contract";
import { CHAT_MAX_TOTAL_ATTACHMENT_BYTES } from "../../../../lib/chatAttachmentLimits";
import { requireArtifactFormat, sanitizeArtifactFilename } from "../../../../lib/generatedArtifactCore";
import { isLanguage, SUPPORTED_LANGUAGES, type Language } from "../../../../lib/language";
import { desktopNativeCopy } from "../../../../locales/desktopNative";

const origin = DESKTOP_APP_ORIGIN;
const desktopName = DESKTOP_PACKAGED_TASK_QA ? "Tomverse Desktop Task QA"
  : DESKTOP_LOCAL_DEV_PACKAGE ? "Tomverse Desktop Local Dev" : "Tomverse Desktop";
const webOrigin = DESKTOP_LOCAL_DEV_PACKAGE ? "https://dev.tomverse.app" : DESKTOP_LIVE_ORIGIN;
const packagedTaskQa = DESKTOP_PACKAGED_TASK_QA && app.isPackaged;
const windowsTaskbarId = process.platform === "win32" && !process.windowsStore
  ? packagedTaskQa ? "app.tomverse.desktop.task-qa" : app.isPackaged ? "app.tomverse.desktop" : "app.tomverse.desktop.dev"
  : null;
const windowIconPath = process.platform === "win32"
  ? join(app.isPackaged ? process.resourcesPath : __dirname, "tomverse-icon.ico")
  : join(__dirname, "tomverse-icon.png");
const shellUrl = origin + "/";
const loginUrl = origin + "/login";
const approvalUrl = origin + "/approval";
const contentPolicy = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob:", "font-src 'self'",
  "base-uri 'none'", "form-action 'none'", "worker-src 'self'", "frame-src 'none'", "frame-ancestors 'none'",
].join("; ");
const unsafeSwitches = [
  "inspect", "inspect-brk", "inspect-port", "remote-debugging-port", "remote-debugging-pipe",
  "remote-debugging-address",
  "no-sandbox", "disable-setuid-sandbox", "disable-web-security", "allow-running-insecure-content", "ignore-certificate-errors",
];
const webPaths = { review: "/review", plugins: "/plugins", image: "/studio" } as const;
declare const DESKTOP_FIXTURE_ALLOWED: boolean;
declare const DESKTOP_PACKAGED_TASK_QA: boolean;
declare const DESKTOP_LOCAL_DEV_PACKAGE: boolean;
declare const DESKTOP_AUTH_ALLOWED: boolean;
declare const DESKTOP_LOGIN_WINDOW_REQUIRED: boolean;
declare const DESKTOP_ACCOUNT_DEVICE_FIXTURE_ALLOWED: boolean;
declare const DESKTOP_AUTH_FIXTURE_ORIGIN: string;
declare const DESKTOP_CLI_AUTH_FIXTURE_ALLOWED: boolean;
declare const DESKTOP_CLI_PROTOCOL_CHECK_ALLOWED: boolean;
const assetTypes: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const fixtureSchema = z.object({
  root: z.string().min(1), profile: z.string().min(1),
  endpoint: z.url().regex(/^http:\/\/127\.0\.0\.1:[0-9]+\/api\/code\/v1$/),
  key: z.literal("tvk_abcdefgh_" + "A".repeat(43)),
  browserInspection: z.boolean().optional(),
  codex: cliFixtureInput.optional(),
  claude: cliFixtureInput.optional(),
  qwen: qwenFixtureInput.optional(),
  kimi: cliFixtureInput.optional(),
  vibe: cliFixtureInput.optional(),
  deepseek: cliFixtureInput.optional(),
  zcode: zCodeFixtureInput.optional(),
  minimax: cliFixtureInput.optional(),
  grok: cliFixtureInput.optional(),
  antigravity: cliFixtureInput.optional(),
}).strict().refine(({ codex, claude, qwen, kimi, vibe, deepseek, zcode, minimax, grok, antigravity }) =>
  [codex, claude, qwen, kimi, vibe, deepseek, zcode, minimax, grok, antigravity].filter(Boolean).length <= 1);

protocol.registerSchemesAsPrivileged([{ scheme: "tomverse", privileges: { standard: true, secure: true } }]);
if (!app.isPackaged) app.setName(desktopName);
if (windowsTaskbarId) app.setAppUserModelId(windowsTaskbarId);

const fixture = DESKTOP_FIXTURE_ALLOWED && (!app.isPackaged || packagedTaskQa) ? readFixture() : null;
const codexRunFixture = fixture?.codex;
const claudeRunFixture = fixture?.claude;
const qwenRunFixture = fixture?.qwen;
const kimiRunFixture = fixture?.kimi;
const vibeRunFixture = fixture?.vibe;
const deepSeekRunFixture = fixture?.deepseek;
const zCodeRunFixture = fixture?.zcode;
const miniMaxRunFixture = fixture?.minimax;
const grokRunFixture = fixture?.grok;
const antigravityRunFixture = fixture?.antigravity;
const quotaRunFixture = codexRunFixture ?? claudeRunFixture;
const cliRunFixture = quotaRunFixture ?? qwenRunFixture ?? kimiRunFixture ?? vibeRunFixture ?? deepSeekRunFixture ?? zCodeRunFixture ?? miniMaxRunFixture ?? grokRunFixture ?? antigravityRunFixture;
const nativeFixtureExecution = antigravityRunFixture ? antigravityFixtureExecution : grokRunFixture ? grokFixtureExecution : miniMaxRunFixture ? miniMaxFixtureExecution : zCodeRunFixture ? zCodeFixtureExecution : deepSeekRunFixture ? deepSeekFixtureExecution : vibeRunFixture ? vibeFixtureExecution : kimiRunFixture ? kimiFixtureExecution : qwenRunFixture ? qwenFixtureExecution :
  claudeRunFixture ? claudeFixtureExecution : codexFixtureExecution;

function readFixture() {
  const index = process.argv.indexOf("--desktop-fixture");
  if (index < 0) return null;
  const descriptor = fixtureSchema.parse(JSON.parse(readFileSync(process.argv[index + 1] ?? "", "utf8")));
  const temporaryRoot = realpathSync(tmpdir());
  function temporaryDirectory(path: string) {
    const canonical = realpathSync(path);
    const child = relative(temporaryRoot, canonical);
    if (!child || child === ".." || child.startsWith(`..${sep}`) ||
        isAbsolute(child) || !statSync(canonical).isDirectory()) throw new Error("Desktop fixtures require temporary folders.");
    return canonical;
  }
  return { ...descriptor, root: temporaryDirectory(descriptor.root), profile: temporaryDirectory(descriptor.profile) };
}
if (fixture) app.setPath("userData", fixture.profile);

let mainWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let accountWindowsReady = false;
let approvalWindow: BrowserWindow | null = null;
let worker: Electron.UtilityProcess | null = null;
let runId: string | null = null;
let discardedRunId: string | null = null;
let pendingFollowUp: { requestId: string; resolve: (queued: boolean) => void } | null = null;
type InspectionEvent = Extract<WorkerEvent, { type: "change-diff" | "command-detail" | "recovery-detail" }>;
type InspectionRequest = { type: "read-change" | "read-command"; recordId: string } | { type: "check-recovery" };
type InspectionCommand = Extract<WorkerCommand, { type: InspectionRequest["type"] | "check-native-recovery" | "read-native-change" }>;
type MutationEvent = Extract<WorkerEvent, { type: "change-undone" | "history-deleted" }>;
type MutationRequest = Extract<WorkerCommand, { type: "undo-change" | "delete-history" }>;
let pendingInspection: { id: string; type: InspectionCommand["type"]; settle: (event: InspectionEvent | null) => void } | null = null;
let pendingMutation: { id: string; settle: (event: MutationEvent | null) => void } | null = null;
let confirmingMutation = false;
let confirmingHandoff = false;
let workspaceHandoff: {
  draft: WorkspaceHandoff; accountId: string; session: AbortSignal;
  project: ProjectRoot; keyIdentity: string; endpointBase: string; codeExecution?: CodeExecutionMode;
} | null = null;
let pending: ApprovalRequest | null = null;
let closing = false;
let suspended = false;
let quitTimer: ReturnType<typeof setTimeout> | undefined;
let canRestartWorker = true;
let choosing = false;
let configuringCli = false;
let cliInspection: { provider: CliProvider; kind: "account" | "protocol"; controller: AbortController } | undefined;
const cliPathWatches = new Map<CliProvider, () => void>();
let projectRoot: ProjectRoot | null = null;
let codeGitProject: GitProject | "unavailable" | null = null;
let codeWorktreeDraft: { home: string; id: string } | undefined;
const codeReferences = new Map<string, CodeReference>();
let historyCursor: string | null = null;
const historyStorage = new Map<string, string>();
const historyWorktreePaths = new Map<string, string>();
let pendingNativeHistory: {
  home: string; mode: "ask" | "plan" | "agent"; previousTurn?: string; checkpointedTurn?: string; checkpointedPlan?: string;
  approval?: NonNullable<Snapshot["codeFallback"]>; apiSource?: CodeCliContinuation;
} | undefined;
let activeContinuation: Task | undefined;
let pendingCliContinuation: { mode: "ask" | "plan" | "agent"; project: ProjectRoot; approval: NonNullable<Snapshot["codeFallback"]> } | undefined;
let activeCliContinuation: Task | undefined;
let loginAttempt: AbortController | null = null;
let browserSession: StoredDesktopSession | null = null;
let sessionExpiry: ReturnType<typeof setTimeout> | undefined;
let renewal: { controller: AbortController; done: Promise<void> } | null = null;
let signingOut = false;
let invalidatingSession = false;
let chatSession = new AbortController();
let chatWriting = false;
let savingGenerated = false;
let chatTurn: AbortController | null = null;
let attachmentTransfer: { requestId: string; controller: AbortController } | null = null;
const attachmentReceipts = new Map<string, AttachmentUpload>();
let linkedCode: { accountId: string; connection: Connection } | null = null;
let linkAttempt: AbortController | null = null;
let catalogRequest: string | null = null;
const state: Snapshot = {
  root: null, project: null, draftNamespace: null, handoff: null, models: [], task: null, history: [], moreHistory: false, busy: false,
  localFixture: fixture !== null, version: app.getVersion(), language: null, update: { stage: "unavailable" },
  codeNotifications: { available: false, enabled: false },
  codeExecutionPreference: "tomverse_api",
  codeFallback: null,
  codeFallbackCliModels: DESKTOP_FIXTURE_ALLOWED && quotaRunFixture ? {
    [nativeFixtureExecution.provider]: { version: quotaRunFixture.version, models: [{ id: quotaRunFixture.model, name: quotaRunFixture.model }] },
  } : {},
  cliPaths: {},
  supportedCliPaths: cliProviders.filter(supportsCliPath),
  cliAuthFixture: !app.isPackaged && DESKTOP_CLI_AUTH_FIXTURE_ALLOWED,
  cliProtocolCheckAvailable: DESKTOP_CLI_PROTOCOL_CHECK_ALLOWED,
  codexFixtureModel: codexRunFixture?.model,
  nativeFixtureEdits: cliRunFixture?.allowFileEdits,
  cliFixtureHistory: cliRunFixture?.allowSavedHistory,
  claudeFixtureModel: claudeRunFixture?.model,
  qwenFixtureModel: qwenRunFixture?.model,
  vibeFixtureModel: vibeRunFixture?.model,
  deepSeekFixtureModel: deepSeekRunFixture?.model,
  zCodeFixtureModel: zCodeRunFixture?.model,
  miniMaxFixtureModel: miniMaxRunFixture?.model,
  grokFixtureModel: grokRunFixture?.model,
  antigravityFixtureModel: antigravityRunFixture?.model,
  kimiFixtureModel: kimiRunFixture?.model,
  account: { stage: DESKTOP_AUTH_ALLOWED ? "idle" : "unavailable" },
  capabilities: null,
  codeKey: { stage: "missing" },
  codeCatalog: "unavailable",
};
const updates = () => configureUpdates(
  () => state.busy || !!pendingMutation || confirmingMutation || recoveryCheckPending() ||
    chatWriting || !!attachmentTransfer || savingGenerated || signingOut || suspended || closing,
  (update) => { state.update = update; broadcast(); },
);
const codeNotificationsPath = () => join(app.getPath("userData"), "code-notifications.txt");
const codeExecutionPreferencePath = () => join(app.getPath("userData"), "code-execution-preference.txt");
const codeFallbackFile = (scope: string) => join(app.getPath("userData"), `code-fallback-${scope}.json`);
const cliPathsFile = () => join(app.getPath("userData"), "provider-cli-paths.json");
const storedCliPaths = z.partialRecord(cliProvider, cliFilePath);
const languagePath = () => join(app.getPath("userData"), "language.txt");
const nativeCopy = () => desktopNativeCopy[state.language ?? "en"];
const windowBoundsPath = () => join(app.getPath("userData"), "window-bounds.json");
const windowBounds = z.object({
  x: z.int().min(-1_000_000).max(1_000_000), y: z.int().min(-1_000_000).max(1_000_000),
  width: z.int().positive().max(100_000), height: z.int().positive().max(100_000),
});
const accountOrigin = DESKTOP_LOCAL_DEV_PACKAGE ? webOrigin
  : !app.isPackaged && DESKTOP_AUTH_FIXTURE_ORIGIN ? DESKTOP_AUTH_FIXTURE_ORIGIN : undefined;
const sessionVault = () => createSessionVault(join(app.getPath("userData"), "desktop-session.dat"), safeStorage, process.platform);
const codeKeyVault = (accountId: string) => createCodeKeyVault(join(app.getPath("userData"),
  "code-key-" + createHash("sha256").update(accountId).digest("hex") + ".dat"), safeStorage, process.platform, accountId);

function codeConnection() {
  if (linkedCode && linkedCode.accountId === browserSession?.accountId) return linkedCode.connection;
  return fixture;
}

function codeFallbackScope() {
  const connection = codeConnection();
  if (!connection || signingOut || invalidatingSession) return null;
  const owner = linkedCode?.connection === connection ? linkedCode.accountId : "fixture";
  return createHash("sha256").update(JSON.stringify([owner, connection.endpoint, connection.key])).digest("hex");
}

function refreshCodeFallbackSettings() {
  const scope = codeFallbackScope();
  if (!scope) {
    state.codeFallback = null;
    return;
  }
  if (state.codeFallback?.scope === scope) return;
  let settings = defaultCodeFallbackSettings;
  try {
    settings = codeFallbackSettings.parse(JSON.parse(readFileSync(codeFallbackFile(scope), "utf8")));
  } catch { /* New or invalid settings start with automatic fallback off. */ }
  state.codeFallback = { scope, settings };
}

function writeCodeFallbackSettings(scope: string, settings: CodeFallbackSettings) {
  writeFileAtomic(codeFallbackFile(scope), JSON.stringify(codeFallbackSettings.parse(settings)));
  state.codeFallback = { scope, settings };
}

function saveCodeFallback(change: CodeFallbackUpdate) {
  refreshCodeFallbackSettings();
  const current = state.codeFallback;
  if (!current || current.scope !== change.scope || closing || suspended) throw new Error("The Code settings account changed.");
  const next = updateCodeFallbackSettings(current.settings, change, state.codeExecutionPreference, state.models, state.codeFallbackCliModels);
  if (next !== current.settings) {
    writeCodeFallbackSettings(current.scope, next);
    if (activeContinuation || activeCliContinuation) stop();
  }
  broadcast();
}

function workspaceNamespace() {
  const connection = codeConnection();
  if (!state.root || !connection) return null;
  const scope = [browserSession?.accountId ?? "fixture", state.root, connection.endpoint];
  if (connection === fixture) scope.push(connection.key);
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function currentHistoryScope() {
  const connection = codeConnection();
  if (!projectRoot || !connection) return null;
  const owner = linkedCode?.connection === connection ? linkedCode.accountId : null;
  return codeHistoryScope(app.getPath("userData"), owner, projectRoot, connection);
}

function managedWorktreeHome(scope: HistoryScope) {
  const base = DESKTOP_FIXTURE_ALLOWED && fixture ? dirname(app.getPath("userData")) : app.getPath("appData");
  let canonical = base;
  try { canonical = realpathSync.native(base); }
  catch { /* Git creation validates the resulting directory if the base is still missing. */ }
  return join(canonical, "Tomverse Worktrees", basename(scope.home).slice(0, 24));
}

function managedScope(scope: HistoryScope, project: ProjectRoot): HistoryScope {
  return { ...scope, root: project.path };
}

function refreshWorktreeDraft() {
  const scope = currentHistoryScope();
  if (!scope || !codeGitProject || codeGitProject === "unavailable") {
    codeWorktreeDraft = undefined;
    state.codeGitWorkspace = codeGitProject === "unavailable" ? { kind: "unavailable" } : undefined;
    return;
  }
  const home = managedWorktreeHome(scope);
  if (codeWorktreeDraft?.home !== home) codeWorktreeDraft = { home, id: randomUUID() };
  const { id } = codeWorktreeDraft;
  state.codeGitWorkspace = { kind: "git", id, path: worktreePath(home, id, codeGitProject.subdirectory),
    branch: worktreeBranch(id), bases: codeGitProject.bases };
}

function projectPermissionPath() {
  const scope = currentHistoryScope();
  return DESKTOP_FIXTURE_ALLOWED && fixture && codeConnection() === fixture && scope
    ? join(scope.home, "permission-profile.txt") : undefined;
}

function readProjectPermissionProfile() {
  const path = projectPermissionPath();
  if (!path) return undefined;
  try { return codePermissionProfile.parse(readFileSync(path, "utf8")); }
  catch { return "manual" as const; }
}

function currentNativeHistoryHome(scope = currentHistoryScope()) {
  return DESKTOP_FIXTURE_ALLOWED && cliRunFixture?.allowSavedHistory && scope
    ? nativeHistoryHome(scope.home, cliRunFixture, nativeFixtureExecution.provider) : null;
}

const codeProjectLocks = () => join(app.getPath("appData"), "Tomverse Desktop Workspace Locks");

function refreshHistory(more = false) {
  if (more && historyCursor === null) return;
  const scope = currentHistoryScope();
  const key = codeConnection()?.key;
  historyStorage.clear();
  historyWorktreePaths.clear();
  const rows: Snapshot["history"] = [];
  if (scope) for (const storage of [scope.home, scope.legacyHome]) {
    for (const { id, root, firstTask, status, readable } of listSessions(storage, (saved) => {
      if (matchesHistory(saved, scope, storage)) return true;
      if (storage !== scope.home || !saved.workspace?.root || !sessionId.safeParse(saved.id).success) return false;
      const worktree = readManagedWorktree(managedWorktreeHome(scope), saved.workspace.root);
      return !!worktree && matchesHistory(saved, managedScope(scope, worktree.project), storage);
    })) {
      if (!sessionId.safeParse(id).success || historyStorage.has(id) || (!readable && storage !== scope.home)) continue;
      historyStorage.set(id, storage);
      if (readable && root !== scope.root) historyWorktreePaths.set(id, root);
      const cli = DESKTOP_FIXTURE_ALLOWED && readable && status === "error" && storage === scope.home && codexRunFixture?.allowSavedHistory
        ? readNativeCheckpoint(apiCliDirectory(storage, id), id, scope.root, "openai") : null;
      rows.push(readable ? { id, title: cleanText(firstTask, key),
        status: cli?.apiSource && (cli.nativeSession || cli.status === "unknown") ? cli.status : status }
        : { id, title: desktopNativeCopy.en.unreadableTask, status, unreadable: true });
    }
  }
  const nativeHome = DESKTOP_FIXTURE_ALLOWED ? currentNativeHistoryHome(scope) : null;
  if (nativeHome && scope) for (const saved of listNativeHistory(nativeHome, scope.root, nativeFixtureExecution.provider)) {
    if (historyStorage.has(saved.id)) continue;
    historyStorage.set(saved.id, nativeHome);
    rows.push({ ...saved, title: cleanText(saved.title, key) });
  }
  const sorted = rows.sort((a, b) => a.id === b.id ? 0 : a.id < b.id ? 1 : -1);
  const page = nextTaskPage(sorted, more ? historyCursor : null);
  state.history = more ? appendTaskPage(state.history, page.items) : page.items;
  historyCursor = page.cursor;
  state.moreHistory = page.cursor !== null;
}

function broadcast() {
  refreshWorktreeDraft();
  if (codePluginScope && !currentCodePlugin(codePluginScope)) revokeCodePlugin();
  const scope = currentCodeBrowserScope();
  if (codeBrowser && codeBrowser.scope !== scope) closeCodeBrowser();
  state.codeBrowserAvailable = scope !== null;
  state.codeBrowserInspection = scope !== null && fixture?.browserInspection === true;
  state.deviceFixtureAvailable = accountPermissionsFixture();
  if (!state.deviceFixtureAvailable) stopDictation(true);
  refreshCodeFallbackSettings();
  state.draftNamespace = workspaceNamespace();
  state.handoff = currentHandoff();
  state.projectPermissionProfile = readProjectPermissionProfile();
  if (accountWindowsReady && DESKTOP_LOGIN_WINDOW_REQUIRED) syncAccountWindow();
  if (loginWindow && !loginWindow.isDestroyed() && !loginWindow.webContents.isDestroyed()) {
    loginWindow.webContents.send("login:changed", { account: state.account, language: state.language });
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("desktop:changed", state);
  }
}

let deviceLanguage: Language | null = null;

function loadLanguage() {
  try {
    const saved = readFileSync(languagePath(), "utf8");
    if (isLanguage(saved)) state.language = deviceLanguage = saved;
  } catch { /* The renderer can migrate a saved language from earlier builds. */ }
}

function setLanguage(language: Language) {
  if (deviceLanguage === language) return;
  writeFileAtomic(languagePath(), language);
  state.language = deviceLanguage = language;
  broadcast();
}

function loadCodeExecutionPreference() {
  try {
    const result = codeExecutionMode.safeParse(readFileSync(codeExecutionPreferencePath(), "utf8"));
    if (result.success) state.codeExecutionPreference = result.data;
  } catch { /* A new profile uses the existing Tomverse API route. */ }
}

function setCodeExecutionPreference(mode: CodeExecutionMode) {
  if (state.codeExecutionPreference === mode) return;
  refreshCodeFallbackSettings();
  const current = state.codeFallback;
  if (current?.settings.automaticFrom) writeCodeFallbackSettings(current.scope, { ...current.settings, automaticFrom: null });
  writeFileAtomic(codeExecutionPreferencePath(), mode);
  state.codeExecutionPreference = mode;
  if (activeContinuation || activeCliContinuation) stop();
  broadcast();
}

function loadCliPaths() {
  try {
    const paths = storedCliPaths.parse(JSON.parse(readFileSync(cliPathsFile(), "utf8")));
    for (const provider of cliProviders) {
      const path = paths[provider];
      if (path) state.cliPaths[provider] = { path, status: "checkRequired" };
    }
  } catch { /* A missing or invalid settings file leaves the provider paths unset. */ }
}

function writeCliPaths(paths: CliPaths) {
  const stored: Partial<Record<CliProvider, string>> = {};
  for (const provider of cliProviders) {
    const path = paths[provider]?.path;
    if (path) stored[provider] = path;
  }
  writeFileAtomic(cliPathsFile(), JSON.stringify(stored));
  for (const [provider, close] of cliPathWatches) {
    if (paths[provider] !== state.cliPaths[provider]) {
      close();
      cliPathWatches.delete(provider);
    }
  }
  state.cliPaths = paths;
  broadcast();
}

function invalidateCliPath(provider: CliProvider, saved: SavedCliPath) {
  if (state.cliPaths[provider] !== saved) return;
  cliPathWatches.get(provider)?.();
  cliPathWatches.delete(provider);
  delete state.codeFallbackCliModels[provider];
  state.cliPaths = { ...state.cliPaths, [provider]: { path: saved.path, status: "checkRequired" } };
  if (cliInspection?.provider === provider) cliInspection.controller.abort();
  broadcast();
}

async function chooseCliPath(provider?: CliProvider) {
  const window = mainWindow;
  if (!window || window.isDestroyed() || closing || configuringCli || (provider && !supportsCliPath(provider))) return null;
  configuringCli = true;
  try {
    const copy = desktopProviderCliCopy[state.language ?? "en"];
    const archive = provider !== undefined && cliUsesReleaseArchive(provider);
    const installation = cliUsesInstallationFolder(provider);
    const archiveFile = provider ? releaseArchiveName(provider) : undefined;
    const result = await dialog.showOpenDialog(window, {
      title: installation ? copy.installationFolder : archive ? copy.releaseArchive : copy.path,
      properties: [installation ? "openDirectory" : "openFile", "showHiddenFiles", "dontAddToRecent",
        ...(process.platform === "darwin" && provider === "zhipu" ? ["treatPackageAsDirectory" as const] : [])],
      ...(archiveFile ? { filters: [{ name: copy.releaseArchive, extensions: [extname(archiveFile).slice(1)] }] } : {}),
    });
    return result.canceled || closing ? null : result.filePaths[0] ?? null;
  } finally {
    configuringCli = false;
  }
}

async function saveCliPath({ provider, path }: z.infer<typeof cliPathInput>) {
  if (configuringCli || closing) throw new Error("The CLI settings are busy.");
  configuringCli = true;
  let watching: (() => void) | undefined;
  let saved: SavedCliPath | undefined;
  let changed = false;
  try {
    let inspection = await inspectCliPath(provider, path);
    if (inspection.status === "pathVerified") {
      watching = watchVerifiedCliPath(provider, path, inspection.file, () => {
        changed = true;
        if (saved) invalidateCliPath(provider, saved);
      });
      if (!await cliPathStillMatches(provider, path, inspection) || changed) inspection = { status: "checkFailed" };
    }
    const result = inspection.status === "pathVerified" ? { status: inspection.status, version: inspection.version } : inspection;
    if (closing) return { status: "checkFailed" } as const;
    if (result.status === "pathVerified" || result.status === "versionUnverified") {
      saved = result.status === "pathVerified" ? { path, ...result } : { path, status: "versionUnverified" };
      delete state.codeFallbackCliModels[provider];
      writeCliPaths({ ...state.cliPaths, [provider]: saved });
      if (watching) {
        cliPathWatches.set(provider, watching);
        watching = undefined;
      }
    } else {
      const previous = state.cliPaths[provider];
      if (previous?.path === path) invalidateCliPath(provider, previous);
    }
    return result;
  } finally {
    watching?.();
    configuringCli = false;
  }
}

function removeCliPath(provider: CliProvider) {
  if (configuringCli || closing) throw new Error("The CLI settings are busy.");
  if (!state.cliPaths[provider]) return;
  const paths = { ...state.cliPaths };
  delete paths[provider];
  delete state.codeFallbackCliModels[provider];
  writeCliPaths(paths);
}

async function checkVerifiedCli<T>(provider: CliProvider, kind: "account" | "protocol", blocked: (status: "unavailable" | "cancelled") => T,
    run: (executable: string, signal: AbortSignal, executableVersion: string) => Promise<T>): Promise<T> {
  if (configuringCli || closing) return blocked("unavailable");
  const saved = state.cliPaths[provider];
  if (!saved || saved.status !== "pathVerified") return blocked("unavailable");
  const controller = new AbortController();
  cliInspection = { provider, kind, controller };
  configuringCli = true;
  try {
    const inspection = await inspectCliPath(provider, saved.path, controller.signal);
    if (state.cliPaths[provider] !== saved) return blocked("unavailable");
    if (controller.signal.aborted || closing) return blocked("cancelled");
    if (inspection.status !== "pathVerified" || inspection.version !== saved.version) {
      invalidateCliPath(provider, saved);
      return blocked("unavailable");
    }
    const result = await run(inspection.file, controller.signal, inspection.version);
    if (controller.signal.aborted || closing) return blocked("cancelled");
    const current = await cliPathStillMatches(provider, saved.path, inspection, controller.signal);
    if (state.cliPaths[provider] !== saved) return blocked("unavailable");
    if (controller.signal.aborted || closing) return blocked("cancelled");
    if (!current) {
      invalidateCliPath(provider, saved);
      return blocked("unavailable");
    }
    return result;
  } finally {
    configuringCli = false;
    cliInspection = undefined;
  }
}

async function checkCliAccount(provider: CliProvider) {
  if (app.isPackaged || !supportsIsolatedCliAccount(provider)) return unknownCliAccount;
  return checkVerifiedCli(provider, "account", () => unknownCliAccount, (file, signal, version) => {
    const versions = { client: app.getVersion(), executable: version };
    if (provider === "openai") return probeIsolatedCodexAccount(file, versions, signal);
    if (provider === "anthropic") return probeIsolatedClaudeAccount(file, signal, version);
    return probeIsolatedAcpAccount(provider, file, versions, signal);
  });
}

async function checkCliProtocol(provider: CliProvider): Promise<CliProtocolCheck> {
  if (!isCliProtocolProvider(provider)) return { status: "unavailable" };
  return checkVerifiedCli(provider, "protocol", (status): CliProtocolCheck => ({ status }), (executable, signal, executableVersion) =>
    probeIsolatedCliProtocol(provider, executable, { client: app.getVersion(), executable: executableVersion }, signal));
}

const cliAuthGuides = {
  openai: "https://developers.openai.com/codex/auth",
  anthropic: "https://code.claude.com/docs/en/authentication",
  google: "https://antigravity.google/docs/ide/extensions/acp#authentication",
  xai: "https://docs.x.ai/build/overview#run-grok",
  qwen: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
  moonshot: "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/getting-started.md",
  mistral: "https://docs.mistral.ai/vibe/code/cli/install-setup",
  minimax: "https://code.minimax.io/docs/cli/quick-start",
  deepseek: "https://github.com/deepseek-ai/deepseek-harness",
  zhipu: "https://zcode.z.ai/en/docs/install",
} satisfies Record<CliProvider, string>;

const webViewHost = createWebViewHost({
  owner: () => mainWindow,
  origin: new URL(webOrigin).origin,
  guideUrls: Object.values(cliAuthGuides),
  language: () => state.language ?? "en",
  publish: (next) => {
    const owner = mainWindow;
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send("desktop:web-view-state", next);
  },
});

function loadCodeNotifications() {
  let enabled = false;
  try { enabled = readFileSync(codeNotificationsPath(), "utf8") === "enabled"; }
  catch { /* Notifications are off by default. */ }
  // On Windows, probing Electron's notification backend can rewrite the Start menu shortcut.
  const available = (process.platform === "win32" && !enabled) || Notification.isSupported();
  state.codeNotifications = { available, enabled: enabled && available };
}

function setCodeNotifications(enabled: boolean) {
  if (closing) return;
  if (enabled && !Notification.isSupported()) {
    state.codeNotifications = { available: false, enabled: false };
    broadcast();
    return;
  }
  writeFileAtomic(codeNotificationsPath(), enabled ? "enabled" : "disabled");
  state.codeNotifications = { available: true, enabled };
  broadcast();
}

function notifyCodeResult(status: Task["status"]) {
  const window = mainWindow;
  if (!state.codeNotifications.enabled || !Notification.isSupported() || !window || window.isDestroyed() || window.isFocused() || closing || suspended) return;
  const copy = nativeCopy();
  const body = status === "completed" ? copy.taskFinished : status === "stopped" ? copy.taskStopped : copy.taskAttention;
  try { new Notification({ title: "Tomverse Desktop", body }).show(); }
  catch { /* Desktop notifications may be unavailable in this OS session. */ }
}

function handoffCodeExecution(): CodeExecutionMode {
  return DESKTOP_FIXTURE_ALLOWED && cliRunFixture && state.codeExecutionPreference === "provider_cli" ? "provider_cli" : "tomverse_api";
}

function currentHandoff(): WorkspaceHandoff | null {
  const pending = workspaceHandoff;
  if (!pending) return null;
  const scope = currentHistoryScope();
  if (pending.session.aborted || browserSession?.accountId !== pending.accountId || !scope ||
      projectRoot?.path !== pending.project.path || projectRoot.identity !== pending.project.identity ||
      scope.keyIdentity !== pending.keyIdentity || scope.base !== pending.endpointBase ||
      (pending.codeExecution && pending.codeExecution !== handoffCodeExecution())) {
    workspaceHandoff = null;
    return null;
  }
  return pending.draft;
}

async function confirmWorkspaceHandoff(input: WorkspaceHandoffInput): Promise<WorkspaceHandoff | null> {
  const account = browserSession;
  const owner = mainWindow;
  const connection = codeConnection();
  const session = chatSession.signal;
  const task = state.task;
  if (!account || state.account.stage !== "connected" || !connection || !owner || owner.isDestroyed() ||
      signingOut || closing || suspended || state.busy || pendingMutation || chatWriting || confirmingHandoff) return null;
  if (input.target === "chat" && (!state.capabilities?.chatWrite || task?.id !== input.sourceTaskId ||
      !task.entries.some((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.replaceAll("\r\n", "\n").includes(input.excerpt.replaceAll("\r\n", "\n"))))) return null;

  const text = input.excerpt.replaceAll("\r\n", "\n");
  if (hasCredential(text, connection.key) || text.includes(account.accessToken) || (account.refreshToken && text.includes(account.refreshToken))) {
    throw new Error("The excerpt contains a Tomverse credential.");
  }
  const excerpt = cleanText(text);
  if (excerpt.length > MAX_HANDOFF_EXCERPT_CHARACTERS) throw new Error("Choose a shorter excerpt.");

  confirmingHandoff = true;
  try {
    if (!projectRoot && input.target === "code") await chooseRoot();
    const project = projectRoot;
    const scope = currentHistoryScope();
    if (!project || !scope || session.aborted || connection !== codeConnection() || owner !== mainWindow || owner.isDestroyed()) return null;
    assertProjectRoot(project);
    const target = input.target === "code" ? "Code" : "Chat";
    const codeExecution = input.target === "code" ? handoffCodeExecution() : undefined;
    const copy = nativeCopy();
    const detail = [
      `${input.target === "code" ? copy.targetFolder : copy.sourceFolder} ${project.path}`,
      codeExecution === "tomverse_api" ? "Tomverse API" : "",
      excerpt,
      codeExecution === "provider_cli" ? copy.draftCliDetail.replace("{cli}", nativeFixtureExecution.cli)
        : copy.draftDetail.replace("{target}", target),
      currentHandoff() ? copy.draftReplace : "",
    ].filter(Boolean).join("\n\n");
    const { response } = await dialog.showMessageBox(owner, {
      type: "question", title: copy.draftTitle.replace("{target}", target), message: copy.draftPrompt.replace("{target}", target), detail,
      buttons: [copy.cancel, copy.addDraft], cancelId: 0, defaultId: 0, noLink: true,
    });
    if (response !== 1 || session.aborted || browserSession?.accountId !== account.accountId || owner !== mainWindow || owner.isDestroyed() ||
        signingOut || closing || suspended || state.busy || pendingMutation || chatWriting ||
        projectRoot !== project || codeConnection() !== connection || currentHistoryScope()?.home !== scope.home ||
        (codeExecution && codeExecution !== handoffCodeExecution()) ||
        (input.target === "chat" && (state.task !== task || !state.capabilities?.chatWrite))) return null;
    assertProjectRoot(project);
    const draft = { id: randomUUID(), target: input.target, excerpt, project: project.path };
    workspaceHandoff = { draft, accountId: account.accountId, session, project, keyIdentity: scope.keyIdentity, endpointBase: scope.base, codeExecution };
    broadcast();
    return draft;
  } finally { confirmingHandoff = false; }
}

function removeWorkspaceHandoff(id: string) {
  if (workspaceHandoff?.draft.id !== id) return;
  workspaceHandoff = null;
  broadcast();
}

function withHandoffExcerpt(target: WorkspaceHandoff["target"], prompt: string, id?: string) {
  if (!id) return prompt;
  const handoff = currentHandoff();
  if (handoff?.id !== id || handoff.target !== target || !projectRoot) throw new Error("Choose the excerpt again for this workspace.");
  assertProjectRoot(projectRoot);
  const source = target === "code" ? "Chat" : "Code";
  const composed = [prompt, `Excerpt from ${source}\n${handoff.excerpt}`].filter(Boolean).join("\n\n");
  if (composed.length > (target === "code" ? MAX_CODE_PROMPT_CHARACTERS : CHAT_MAX_MESSAGE_CHARACTERS)) {
    throw new Error("Shorten the draft before including the excerpt.");
  }
  return composed;
}

function trusted(event: Electron.IpcMainInvokeEvent, window: BrowserWindow | null, url: string) {
  const frame = event.senderFrame;
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
    !frame || frame.parent || frame.url !== url || frame.origin !== origin) {
    throw new Error("Untrusted desktop request.");
  }
}

function harden(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function newWindow(options: Electron.BrowserWindowConstructorOptions) {
  const window = new BrowserWindow({
    show: false,
    title: desktopName,
    icon: windowIconPath,
    autoHideMenuBar: true,
    backgroundColor: "#111725",
    ...options,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false, devTools: fixture !== null,
    },
  });
  window.on("page-title-updated", (event) => event.preventDefault());
  if (windowsTaskbarId && !options.parent) {
    const executable = `"${process.execPath}"`;
    window.setAppDetails({
      appId: windowsTaskbarId,
      appIconPath: windowIconPath,
      relaunchCommand: app.isPackaged ? executable : `${executable} "${app.getAppPath()}"`,
      relaunchDisplayName: desktopName,
    });
  }
  harden(window);
  window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
  return window;
}

function send(command: WorkerCommand) {
  if (!worker) throw new Error("The Code runtime is unavailable.");
  worker.postMessage(command);
}

function dismissApproval() {
  const window = approvalWindow;
  approvalWindow = null;
  if (window && !window.isDestroyed()) window.close();
}

function answer(decision: Decision) {
  if (!pending || !runId || pending.id !== decision.id || (decision.action === "run" && !pending.canRemember)) return false;
  send({ type: "answer", runId, decision });
  pending = null;
  const window = approvalWindow;
  approvalWindow = null;
  setImmediate(() => { if (window && !window.isDestroyed()) window.close(); });
  return true;
}

function stop() {
  if (!runId || !worker || state.task?.status === "stopping") return;
  if (codeBrowser) codeBrowser.grant = undefined;
  revokeCodePlugin();
  if (state.task) {
    state.task.status = "stopping";
    state.task.streamingAnswer = undefined;
  }
  pending = null;
  send({ type: "stop", runId });
  dismissApproval();
  broadcast();
}

function startNativeTask(cliFixture: NonNullable<typeof cliRunFixture>, project: ProjectRoot, mode: "ask" | "plan" | "agent", prompt: string,
  home: string | null, previous?: Task, references?: Task["references"]) {
  if (mode === "agent" && (!cliFixture.allowFileEdits || !home ||
      (previous && (nativeFixtureExecution.provider === "openai" || previous.status !== "stopped")) ||
      !fixture || codeConnection() !== fixture)) {
    throw new Error("File edits require an isolated CLI fixture and saved history.");
  }
  const id = previous?.id ?? (home ? Journal.newId() : null);
  const text = cleanText(prompt, codeConnection()?.key);
  const task: Task = previous ? { ...previous, status: "starting", canResume: false } : {
    id, root: project.path, title: text.slice(0, 80), status: "starting", entries: [{ role: "user", text }],
    execution: nativeFixtureExecution, changes: [], checks: [], transmission: [], readOnly: mode !== "agent", savedLocally: !!home,
    references,
  };
  const history = home && id ? { id, directory: nativeSessionDirectory(home, id), previous } : undefined;
  if (home) saveNativeHistory(home, { ...task, nativeSession: undefined }, mode, true);
  refreshCodeFallbackSettings();
  const approval = state.codeFallback?.settings.automaticFrom === "provider_cli"
    ? state.codeFallback : undefined;
  pendingNativeHistory = home ? { home, mode, previousTurn: previous?.nativeSession?.turnId, approval } : undefined;
  const command = { runId: randomUUID(), project, fixture: cliFixture, prompt, history, references,
    protectedRoot: app.getPath("userData"), connectionKey: fixture?.key ?? "" };
  const provider = nativeFixtureExecution.provider;
  if (provider === "qwen" || provider === "moonshot" || provider === "mistral" || provider === "deepseek" || provider === "zhipu" || provider === "minimax" || provider === "xai" || provider === "google") {
    startCliFixtureTask(task, { ...command, mode, type: "start-structured-cli-fixture", provider, clientVersion: app.getVersion() });
  } else if (nativeFixtureExecution.provider === "anthropic") {
    startCliFixtureTask(task, { ...command, mode, type: "start-claude-fixture" });
  } else {
    startCliFixtureTask(task, { ...command, mode, type: "start-codex-fixture", clientVersion: app.getVersion() });
  }
}

function startCliFixtureTask(task: Task, command: Extract<WorkerCommand, { type: "start-codex-fixture" | "start-claude-fixture" | "start-structured-cli-fixture" }>) {
  discardTransientTask(state.task);
  state.task = task;
  runId = command.runId;
  state.busy = true;
  codeReferences.clear();
  try {
    send(command);
  } catch {
    runId = null;
    state.busy = false;
    pendingNativeHistory = undefined;
    if (command.type !== "start-structured-cli-fixture" && command.afterQuota && pendingFollowUp?.requestId === command.afterQuota.requestId) {
      pendingFollowUp.resolve(false);
      pendingFollowUp = null;
      activeCliContinuation = undefined;
    }
    task.status = "unknown";
    task.nativeSession = undefined;
    task.entries = [...task.entries, desktopCodeNotice("runUnknown")];
    refreshHistory();
  }
  broadcast();
}

function requestQuit() {
  if (closing) return;
  closing = true;
  stop();
  quitTimer = setTimeout(async () => {
    if ((!state.busy && !pendingMutation) || !closing) return;
    const copy = nativeCopy();
    const { response } = await dialog.showMessageBox({
      type: "warning", message: copy.quitPrompt, detail: copy.quitDetail,
      buttons: [copy.keepWaiting, copy.quitUnconfirmed], defaultId: 0, cancelId: 0,
    });
    if ((!state.busy && !pendingMutation) || !closing) return;
    if (response === 1) {
      // The saved journal remains the source of evidence for the interrupted run.
      state.busy = false;
      pendingMutation?.settle(null);
      app.quit();
    } else {
      closing = false;
    }
  }, 12_000);
}

function showApproval(request: ApprovalRequest) {
  pending = request;
  const window = newWindow({ parent: mainWindow ?? undefined, modal: true, width: 840, height: 680, minWidth: 520, minHeight: 420, title: nativeCopy().approvalTitle });
  approvalWindow = window;
  window.once("closed", () => {
    if (approvalWindow !== window) return;
    approvalWindow = null;
    if (pending?.id === request.id) answer({ id: request.id, action: "deny" });
  });
  void window.loadURL(approvalUrl).catch(() => { if (!window.isDestroyed()) window.close(); });
}

function onWorkerMessage(event: WorkerEvent) {
  if (event.type === "code-plugin") { void replyToCodePlugin(event); return; }
  if (event.type === "code-plugin-cancel") {
    const scope = codePluginScope;
    if (scope?.runId === event.runId && scope.active?.requestId === event.requestId) scope.active.controller.abort();
    return;
  }
  if (event.type === "browser-snapshot") { void replyToBrowserSnapshot(event); return; }
  if (event.type === "follow-up-queued") {
    if (pendingFollowUp?.requestId === event.requestId) {
      pendingFollowUp.resolve(event.queued && event.runId === runId && event.runId !== discardedRunId);
      pendingFollowUp = null;
    }
    return;
  }
  if (event.type === "change-diff" || event.type === "command-detail" || event.type === "recovery-detail") {
    if (pendingInspection?.id === event.requestId) pendingInspection.settle(event);
    return;
  }
  if (event.type === "change-undone" || event.type === "history-deleted") {
    if (pendingMutation?.id === event.requestId) pendingMutation.settle(event);
    return;
  }
  if (event.type === "catalog" || event.type === "catalog-failed") {
    if (event.requestId !== catalogRequest) return;
    catalogRequest = null;
    canRestartWorker = true;
    state.models = event.type === "catalog" ? event.models : [];
    state.codeCatalog = event.type === "catalog" ? "ready" : "failed";
  } else if (event.runId === runId) {
    const discarded = event.runId === discardedRunId;
    if (discarded && event.type !== "finished") return;
    if ("task" in event && state.task?.worktree?.path === event.task.root) event.task.worktree = state.task.worktree;
    if (event.type === "approval") {
      if (state.task?.status === "stopping") return;
      showApproval(event.request);
    } else if (event.type === "finished") {
      pendingFollowUp?.resolve(false);
      pendingFollowUp = null;
      if (discarded) discardTransientTask(event.task);
      const reverse = pendingCliContinuation;
      pendingCliContinuation = undefined;
      if (DESKTOP_FIXTURE_ALLOWED && !discarded && reverse) {
        try { if (startCliContinuation(reverse, event.task)) return; }
        catch { /* An unavailable checkpoint leaves the verified API refusal in place. */ }
      }
      if (DESKTOP_FIXTURE_ALLOWED && !discarded && pendingNativeHistory && event.task.id) {
        if (event.task.status === "unknown" && event.task.nativeSession?.turnId === pendingNativeHistory.previousTurn) {
          event.task.nativeSession = undefined;
          event.task.canCheckRecovery = false;
        }
        try {
          savePendingNativeHistory(pendingNativeHistory, event.task, false);
          if (startCappedContinuation(pendingNativeHistory, event.task)) return;
        }
        catch {
          event.task.canResume = false;
          event.task.canCheckRecovery = false;
          event.task.entries.push(desktopCodeNotice("unreadableCheckpoint"));
        }
      }
      pendingNativeHistory = undefined;
      if (activeContinuation && !discarded) event.task = continuationView(activeContinuation, event.task);
      if (activeCliContinuation && !discarded) event.task = cliContinuationView(activeCliContinuation, event.task);
      activeContinuation = undefined;
      activeCliContinuation = undefined;
      state.task = discarded ? null : event.task;
      state.busy = false;
      runId = null;
      discardedRunId = null;
      pending = null;
      dismissApproval();
      refreshHistory();
      if (!discarded) notifyCodeResult(event.task.status);
      if (discarded && browserSession && !linkedCode && !fixture) void restoreCodeKey(browserSession);
      if (closing) app.quit();
    } else {
      const task = activeContinuation ? continuationView(activeContinuation, event.task)
        : activeCliContinuation ? cliContinuationView(activeCliContinuation, event.task) : event.task;
      state.task = state.task?.status === "stopping" ? { ...task, status: "stopping", streamingAnswer: undefined } : task;
      if (DESKTOP_FIXTURE_ALLOWED) checkpointNativeTurn(activeCliContinuation ? event.task : state.task);
    }
  }
  broadcast();
}

function startCliContinuation(record: NonNullable<typeof pendingCliContinuation>, api: Task) {
  const { approval, project, mode } = record;
  const { destination, transfer } = approval.settings;
  const connection = codeConnection();
  const scope = currentHistoryScope();
  const readOnly = mode !== "agent";
  if (!worker || !connection || connection !== fixture || !scope || projectRoot !== project || !codexRunFixture?.allowSavedHistory ||
      !api.id || !api.savedLocally || api.readOnly !== readOnly || (!readOnly && !codexRunFixture.allowFileEdits) ||
      api.root !== project.path || api.status !== "blocked" ||
      api.execution?.executionMode !== "tomverse_api" || api.quota?.source !== "tomverse_api" || api.pendingFollowUp ||
      (readOnly && api.changes.length) || state.task?.status === "stopping" || state.codeExecutionPreference !== "tomverse_api" ||
      approval !== state.codeFallback || approval.scope !== codeFallbackScope() || approval.settings.automaticFrom !== "tomverse_api" ||
      suspended || closing || signingOut || invalidatingSession || choosing || state.update.stage === "installing" ||
      destination?.executionMode !== "provider_cli" || destination.provider !== "openai" ||
      destination.model !== codexRunFixture.model || destination.version !== codexRunFixture.version ||
      !codeFallbackModelAvailable(destination, state.models, state.codeFallbackCliModels)) return false;
  assertProjectRoot(project);
  const directory = apiCliDirectory(scope.home, api.id);
  if (existsSync(directory)) return false;
  const source = codeCliContinuation.parse({ segmentId: randomUUID(), requestId: api.quota.requestId,
    provider: destination.provider, model: destination.model, version: destination.version, transfer });
  const task: Task = { id: api.id, root: api.root, title: api.title, status: "starting",
    entries: [{ role: "user", text: api.title }], execution: codexFixtureExecution, effort: api.effort,
    changes: [], checks: [], transmission: [], savedLocally: true, readOnly };
  saveApiCliHistory(directory, task, mode, source, true);
  send({ type: "start-codex-fixture", runId: source.segmentId, project, fixture: codexRunFixture,
    prompt: api.title, mode, clientVersion: app.getVersion(), protectedRoot: app.getPath("userData"), connectionKey: connection.key,
    history: { id: api.id, directory }, apiSource: { ...source, scope, connection } });
  pendingNativeHistory = { home: directory, mode, apiSource: source };
  activeCliContinuation = { ...api, cliContinuation: { ...source, sourceModel: api.model, stage: "checking" } };
  runId = source.segmentId;
  pending = null;
  dismissApproval();
  state.task = { ...activeCliContinuation, status: "starting" };
  broadcast();
  return true;
}

function cliContinuationView(api: Task, cli: Task): Task {
  const source = api.cliContinuation;
  if (!source) return api;
  const transmission = cli.transmission.length ? cli.transmission : api.transmission;
  const apiUsage = cli.apiUsage ?? api.apiUsage;
  if (!cli.nativeSession) {
    const waiting = cli.status === "starting" || cli.status === "running" || cli.status === "stopping";
    return { ...api, status: waiting || cli.status === "unknown" ? cli.status : api.status, transmission, apiUsage,
      canResume: false, canCheckRecovery: false,
      cliContinuation: { ...source, stage: waiting ? "checking" : "unavailable" } };
  }
  const plan = api.plan ? {
    activeId: cli.plan?.activeId ? `cli:${cli.plan.activeId}` : null,
    analysis: cli.plan ? cli.plan.analysis : api.plan.analysis,
    proposalOnly: cli.plan?.proposalOnly ?? api.plan.proposalOnly,
    items: [...api.plan.items, ...(cli.plan?.items ?? []).map((row) => ({ ...row, id: `cli:${row.id}` }))],
  } : cli.plan;
  return { ...cli, title: api.title, plan, effort: api.effort, transmission, apiUsage, references: api.references, checks: [...api.checks, ...cli.checks],
    changes: [...api.changes, ...cli.changes.map((change) => ({ ...change, id: `codex:${change.id}` }))],
    entries: [...api.entries, ...cli.entries.filter(({ role }, index) => (index !== 0 || role !== "user") && (role !== "plan" || !api.plan))],
    canResume: false, cliContinuation: { ...source, stage: "started" } };
}

function startCappedContinuation(record: NonNullable<typeof pendingNativeHistory>, task: Task) {
  const { approval } = record;
  const project = projectRoot;
  const connection = codeConnection();
  const scope = currentHistoryScope();
  const settings = approval?.settings;
  const destination = settings?.destination;
  const provider = nativeFixtureExecution.provider;
  if ((provider !== "openai" && provider !== "anthropic") || !approval || approval !== state.codeFallback || approval.scope !== codeFallbackScope() || !worker ||
      !connection || connection !== fixture || !project || !scope || currentNativeHistoryHome(scope) !== record.home ||
      state.task?.status === "stopping" || state.codeExecutionPreference !== "provider_cli" || suspended || closing ||
      signingOut || invalidatingSession || choosing || state.update.stage === "installing" ||
      !task.id || task.root !== project.path || !task.savedLocally || task.status !== "blocked" ||
      task.execution?.executionMode !== "provider_cli" || task.execution.provider !== provider ||
      task.quota?.source !== (provider === "openai" ? "codex" : "claude_code") || !task.nativeSession || task.pendingFollowUp ||
      (record.mode === "agent" ? !codexRunFixture?.allowFileEdits || task.readOnly : !task.readOnly || task.changes.length > 0) ||
      task.plan?.items.some((row) => row.evidence.some((item) => item.state === "running" || item.state === "unconfirmed")) ||
      destination?.executionMode !== "tomverse_api" || !destination.model || !settings?.apiCreditCap ||
      !codeFallbackModelAvailable(destination, state.models, state.codeFallbackCliModels)) return false;
  assertProjectRoot(project);
  const segmentId = randomUUID();
  const continuation = codeContinuation.parse({ segmentId, model: destination.model,
    maximumKeyCreditCap: settings.apiCreditCap, transfer: settings.transfer });
  saveNativeHistory(record.home, task, record.mode, false, continuation);
  const saved = readNativeHistory(record.home, task.id, project.path, provider);
  if (saved?.continuation?.segmentId !== segmentId) return false;
  const view = { ...continuation, source: task.nativeSession, stage: "checking" as const };
  const source: Task = { ...restoredNativeTask(saved), continuation: view };
  try {
    send({ type: "start", runId: segmentId, project, scope, protectedRoot: app.getPath("userData"), connection,
      input: { prompt: task.title, model: continuation.model, mode: record.mode, effort: task.effort ?? "default", saveHistory: true },
      references: [], preference: "tomverse_api",
      continuation: { ...continuation, taskId: task.id, sourceHome: record.home, sourceProvider: provider } });
  } catch {
    task.continuation = { ...view, stage: "unavailable" };
    return false;
  }
  pendingNativeHistory = undefined;
  activeContinuation = source;
  runId = segmentId;
  pending = null;
  dismissApproval();
  state.task = { ...source, status: "starting" };
  broadcast();
  return true;
}

function continuationView(source: Task, api: Task): Task {
  const continuation = source.continuation;
  if (!continuation) return api;
  if (api.execution?.executionMode !== "tomverse_api") {
    return { ...source, continuation: { ...continuation, stage: "unavailable" } };
  }
  const plan = source.plan && api.plan ? {
    activeId: api.plan.activeId ? `api:${api.plan.activeId}` : null,
    analysis: api.plan.analysis,
    proposalOnly: source.plan.proposalOnly ?? api.plan.proposalOnly,
    items: [...source.plan.items, ...api.plan.items.map((row) => ({ ...row, id: `api:${row.id}` }))],
  } : api.plan ?? source.plan;
  const apiEntries = api.entries.filter(({ role }, index) => (index !== 0 || role !== "user") && (role !== "plan" || !source.plan));
  const entries = [...source.entries, ...apiEntries];
  return { ...api, title: source.title, entries, plan, references: source.references, nativeRuns: source.nativeRuns, changes: [
    ...source.changes.map((change) => ({ ...change, id: `codex:${change.id}` })), ...api.changes,
  ], continuation: { ...continuation, stage: "started" } };
}

function savePendingNativeHistory(record: NonNullable<typeof pendingNativeHistory>, task: Task, starting: boolean) {
  if (record.apiSource) saveApiCliHistory(record.home, task, record.mode, record.apiSource, starting);
  else saveNativeHistory(record.home, task, record.mode, starting);
}

function checkpointNativeTurn(task: Task, force = false) {
  const record = pendingNativeHistory;
  const turn = task.nativeSession?.turnId;
  if (!record || !task.id || !turn || turn === record.previousTurn) return;
  const plan = JSON.stringify([task.plan, task.changes, task.nativeRuns]);
  if (!force && turn === record.checkpointedTurn && plan === record.checkpointedPlan) return;
  try {
    savePendingNativeHistory(record, task, true);
    record.checkpointedTurn = turn;
    record.checkpointedPlan = plan;
  } catch { /* The startup checkpoint still blocks an implicit retry. */ }
}

function bootWorker() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(name),
  )) as Record<string, string>;
  const child = utilityProcess.fork(join(__dirname, "runner-process.cjs"), [], {
    env: { ...env, TOMVERSE_DESKTOP_PROJECT_LOCKS: codeProjectLocks() },
    stdio: "ignore", serviceName: "Tomverse Code Runtime",
  });
  worker = child;
  child.on("message", onWorkerMessage);
  child.once("exit", () => {
    if (worker !== child) return;
    worker = null;
    pendingFollowUp?.resolve(false);
    pendingFollowUp = null;
    pendingInspection?.settle(null);
    pendingMutation?.settle(null);
    pending = null;
    dismissApproval();
    catalogRequest = null;
    state.models = [];
    state.codeCatalog = codeConnection() ? "failed" : "unavailable";
    const interrupted = runId ? state.task : null;
    if (interrupted) {
      interrupted.status = "unknown";
      interrupted.streamingAnswer = undefined;
      interrupted.pendingFollowUp = undefined;
      interrupted.canResume = false;
      if (interrupted.continuation?.stage === "checking") interrupted.continuation.stage = "unavailable";
      if (interrupted.cliContinuation?.stage === "checking") interrupted.cliContinuation.stage = "unavailable";
      if (DESKTOP_FIXTURE_ALLOWED && !activeCliContinuation) checkpointNativeTurn(interrupted, true);
    }
    pendingNativeHistory = undefined;
    activeContinuation = undefined;
    pendingCliContinuation = undefined;
    activeCliContinuation = undefined;
    runId = null;
    discardedRunId = null;
    state.busy = false;
    refreshHistory();
    if (interrupted) {
      const restored = interrupted.id && interrupted.savedLocally ? readTaskHistory(interrupted.id) : null;
      state.task = restored ?? { ...interrupted, canCheckRecovery: false };
      state.task.entries.push(desktopCodeNotice("processExited"));
    }
    if (closing) app.quit();
    else if (canRestartWorker) {
      canRestartWorker = false;
      bootWorker();
    }
    if (browserSession && !linkedCode && !fixture) void restoreCodeKey(browserSession);
    broadcast();
  });
  if (DESKTOP_FIXTURE_ALLOWED && fixture) send({ type: "clean-deleted-history", protectedRoot: app.getPath("userData") });
  requestCodeCatalog();
}

function requestCodeCatalog() {
  const connection = codeConnection();
  state.models = [];
  catalogRequest = worker && connection ? randomUUID() : null;
  state.codeCatalog = catalogRequest ? "loading" : connection ? "failed" : "unavailable";
  if (catalogRequest && connection) send({ type: "catalog", requestId: catalogRequest, connection });
}

function retryCodeCatalog() {
  if (!codeConnection() || state.busy || state.codeCatalog === "loading" || state.models.length ||
      signingOut || invalidatingSession || linkAttempt || suspended || closing || state.update.stage === "installing") return;
  if (worker) requestCodeCatalog();
  else bootWorker();
  broadcast();
}

async function chooseRoot() {
  if (state.busy || pendingMutation || choosing) return false;
  choosing = true;
  const owner = browserSession?.accountId;
  try {
    const chosen = fixture
      ? fixture.root
      : (await dialog.showOpenDialog(mainWindow!, { title: nativeCopy().openFolder, properties: ["openDirectory"] })).filePaths[0];
    if (!chosen || state.busy || pendingMutation || browserSession?.accountId !== owner) return false;
    const project = bindProjectRoot(chosen);
    const root = project.path;
    const protectedRoot = await realpath(app.getPath("userData"));
    const folder = relative(root, protectedRoot);
    if (!folder || (!folder.startsWith("..") && !isAbsolute(folder))) throw new Error("Choose a project outside the app data directory.");
    const reverse = relative(protectedRoot, root);
    if (!reverse || (!reverse.startsWith("..") && !isAbsolute(reverse))) throw new Error("Choose a project outside the app data directory.");
    const git = await readGitProject(project);
    if (browserSession?.accountId !== owner) return false;
    assertProjectRoot(project);
    const projectChanged = state.root !== root || projectRoot?.identity !== project.identity;
    if (projectChanged) {
      codeReferences.clear();
      workspaceHandoff = null;
    }
    projectRoot = project;
    codeGitProject = git;
    codeWorktreeDraft = undefined;
    state.root = root;
    state.project = basename(root);
    discardTransientTask(state.task);
    state.task = null;
    refreshHistory();
    broadcast();
    return projectChanged;
  } finally {
    choosing = false;
  }
}

async function chooseCodeReferences(kind: CodeReference["kind"]) {
  const root = state.root;
  const project = projectRoot;
  const namespace = workspaceNamespace();
  const window = mainWindow;
  const session = chatSession.signal;
  const connection = codeConnection();
  if (!root || !project || !namespace || !connection || !window || window.isDestroyed() || state.busy || choosing || signingOut || closing) {
    throw new Error("Open a connected Code project to attach files or folders.");
  }
  choosing = true;
  try {
    assertProjectRoot(project);
    const copy = nativeCopy();
    const { filePaths, canceled } = await dialog.showOpenDialog(window, {
      defaultPath: root,
      title: kind === "file" ? copy.attachFiles : copy.attachFolders,
      properties: [kind === "file" ? "openFile" : "openDirectory", "multiSelections"],
    });
    if (window !== mainWindow || window.isDestroyed() || session.aborted || connection !== codeConnection() ||
        namespace !== workspaceNamespace() || signingOut || closing) {
      throw new Error("The Code project changed.");
    }
    let rejected = 0;
    if (!canceled) {
      assertProjectRoot(project);
      const workspace = new Workspace(root, [app.getPath("userData")]);
      for (const path of filePaths) {
        if (codeReferences.size >= MAX_CODE_REFERENCES) {
          rejected++;
          continue;
        }
        try {
          const reference = workspace.reference(path);
          if (reference.kind !== kind || !codeReferencePath.safeParse(reference.path).success ||
              cleanText(reference.path, connection.key) !== reference.path) {
            rejected++;
            continue;
          }
          if ([...codeReferences.values()].some((item) => item.path === reference.path)) continue;
          const id = randomUUID();
          codeReferences.set(id, { id, ...reference });
        } catch {
          rejected++;
        }
      }
    }
    return { references: [...codeReferences.values()], rejected };
  } finally {
    choosing = false;
  }
}

function historyRecord(id: string | null | undefined) {
  const scope = currentHistoryScope();
  const storage = id && historyStorage.get(id);
  if (!id || !scope || !projectRoot || (storage !== scope.home && storage !== scope.legacyHome)) return null;
  const path = historyWorktreePaths.get(id);
  const worktree = path ? readManagedWorktree(managedWorktreeHome(scope), path) : null;
  if (path && !worktree) return null;
  return { storage, scope: worktree ? managedScope(scope, worktree.project) : scope,
    project: worktree?.project ?? projectRoot, sourceProject: worktree ? projectRoot : undefined, sessionId: id, worktree: worktree?.info };
}

function nativeHistoryRecord(id: string) {
  const scope = currentHistoryScope();
  const storage = currentNativeHistoryHome(scope);
  const project = projectRoot;
  if (!scope || !storage || !project || historyStorage.get(id) !== storage) return null;
  const saved = readNativeHistory(storage, id, project.path, nativeFixtureExecution.provider);
  return saved && { storage, scope, project, sessionId: id, saved };
}

function continuationSource(id: string, scope: NonNullable<ReturnType<typeof currentHistoryScope>>) {
  const home = currentNativeHistoryHome(scope);
  if (!home) return null;
  const original = nativeSessionDirectory(home, id);
  const staged = stagedNativeDirectory(scope.home, id);
  if (existsSync(original) && existsSync(staged)) return null;
  const directory = existsSync(staged) ? staged : original;
  const provider = nativeFixtureExecution.provider;
  const saved = readNativeCheckpoint(directory, id, scope.root, provider);
  return saved?.continuation ? { home, directory, provider, saved } : null;
}

function selectedRecord() {
  const task = state.task;
  if (task?.savedLocally !== false) return historyRecord(task?.id);
  const scope = currentHistoryScope();
  if (!task.id || !scope || !projectRoot) return null;
  if (task.root === projectRoot.path) return { storage: null, scope, project: projectRoot, sessionId: task.id };
  const worktree = readManagedWorktree(managedWorktreeHome(scope), task.root);
  return worktree && { storage: null, scope: managedScope(scope, worktree.project),
    project: worktree.project, sourceProject: projectRoot, sessionId: task.id };
}

function discardTransientTask(task: Task | null) {
  if (task?.savedLocally !== false || !task.id || !worker) return;
  try { send({ type: "discard-transient", sessionId: task.id }); } catch { /* The worker may have exited. */ }
}

function loadHistory(id: string) {
  if (state.busy || pendingMutation || !state.history.some((row) => row.id === id)) return;
  const task = readTaskHistory(id);
  if (!task) return;
  discardTransientTask(state.task);
  state.task = task;
  broadcast();
}

function readTaskHistory(id: string, apiOnly = false): Task | null {
  if (!projectRoot) return null;
  try { assertProjectRoot(projectRoot); } catch { return null; }
  if (DESKTOP_FIXTURE_ALLOWED && !apiOnly) {
    const native = nativeHistoryRecord(id);
    if (native) {
      return restoredNativeTask(native.saved);
    }
  }
  const record = historyRecord(id);
  if (!record) return null;
  let saved: ReturnType<typeof Journal.read>;
  try {
    saved = Journal.read(join(record.storage, "sessions", id));
  } catch {
    if (record.storage !== record.scope.home) return null;
    return {
      id, root: record.project.path, title: desktopNativeCopy.en.unreadableTask, unreadable: true, status: "unknown", savedLocally: true, entries: [
        desktopCodeNotice("unreadableCheckpoint"),
      ], changes: [], checks: [], transmission: [],
    };
  }
  if (saved.id !== id || !matchesHistory(saved, record.scope, record.storage)) return null;
  const key = codeConnection()?.key;
  const entries = journalEntries(saved, key);
  const { transmission, apiUsage } = journalApiUsage(saved, key);
  const actual = transmission.findLast((record) => record.purpose === "agent")?.appliedEffort;
  const status = journalStatus(saved);
  const available = !record.worktree?.unavailable;
  const task: Task = {
    id, root: saved.workspace.root, title: cleanText(saved.tasks[0]?.prompt.slice(0, 80) ?? "Code task", key),
    worktree: record.worktree,
    status, entries, plan: journalPlan(saved, key), model: cleanText(saved.model.pinned ?? saved.model.requested, key), canCheckRecovery: available && status === "unknown", savedLocally: true,
    execution: tomverseApiExecution,
    effort: saved.tasks.at(-1)?.effort ?? "default", actual, changes: journalChanges(saved), checks: journalChecks(saved),
    quota: journalQuota(saved),
    transmission, apiUsage, readOnly: saved.readOnly, references: journalReferences(saved, key),
    canResume: available && record.storage === record.scope.home && canResumeJournal(saved),
    canResumeAfterQuota: available && record.storage === record.scope.home && canResumeQuotaJournal(saved),
    canAnswerClarification: available && record.storage === record.scope.home && canAnswerClarification(saved),
    pendingFollowUp: journalPendingFollowUp(saved, key),
  };
  if (apiOnly || record.worktree) return task;
  if (DESKTOP_FIXTURE_ALLOWED && saved.codeContinuation) {
    const source = continuationSource(id, record.scope)?.saved;
    if (source && matchesNativeContinuation(source, saved)) {
      return continuationView(restoredNativeTask(source), task);
    }
    task.canResumeAfterQuota = false;
  } else if (DESKTOP_FIXTURE_ALLOWED && task.quota?.source === "tomverse_api" && codexRunFixture?.allowSavedHistory &&
      record.storage === record.scope.home) {
    const cli = readNativeCheckpoint(apiCliDirectory(record.storage, id), id, record.scope.root, "openai");
    if (cli?.apiSource?.requestId === task.quota.requestId) {
      return cliContinuationView({ ...task,
        cliContinuation: { ...cli.apiSource, sourceModel: task.model, stage: "unavailable" } }, restoredNativeTask(cli));
    }
  }
  return task;
}

function answerCodeClarification(id: string, text: string) {
  const task = state.task;
  const connection = codeConnection();
  if (task?.id !== id || task.status !== "clarification" || !task.canAnswerClarification ||
      task.execution?.executionMode !== "tomverse_api" || !connection || !worker ||
      state.busy || pendingMutation || pendingFollowUp || confirmingMutation || recoveryCheckPending() || signingOut ||
      invalidatingSession || linkAttempt || suspended || closing || state.update.stage === "installing" || choosing ||
      hasCredential(text, connection.key)) return false;
  const record = selectedRecord();
  if (!record || record.storage !== null && record.storage !== record.scope.home) return false;
  assertProjectRoot(record.project);
  return new Promise<boolean>((resolve) => {
    const requestId = randomUUID();
    runId = randomUUID();
    pendingFollowUp = { requestId, resolve };
    state.busy = true;
    state.task = { ...task, status: "starting", canAnswerClarification: false };
    try {
      send({ ...record, type: "resume", runId, protectedRoot: app.getPath("userData"), connection,
        previous: task, afterClarification: { requestId, text } });
    } catch {
      runId = null;
      pendingFollowUp = null;
      state.busy = false;
      state.task = task;
      resolve(false);
    }
    broadcast();
  });
}

function resumeQuotaTask(id: string, text: string) {
  const task = state.task;
  const connection = codeConnection();
  if (!task?.canResumeAfterQuota || task.id !== id || task.status !== "blocked" || !connection || !worker ||
      state.busy || pendingMutation || pendingFollowUp || confirmingMutation || recoveryCheckPending() || signingOut ||
      invalidatingSession || linkAttempt || suspended || closing || state.update.stage === "installing" || choosing ||
      hasCredential(text, connection.key)) return false;
  if (DESKTOP_FIXTURE_ALLOWED && task.execution?.executionMode === "provider_cli") {
    return resumeNativeQuotaTask(task, text, connection);
  }
  const record = historyRecord(id);
  const saved = readTaskHistory(id, true);
  const quota = saved?.quota;
  if (!record || record.storage !== record.scope.home || !saved?.canResumeAfterQuota ||
      task.execution?.executionMode !== "tomverse_api" || task.quota?.source !== "tomverse_api" ||
      quota?.source !== "tomverse_api" || quota.requestId !== task.quota.requestId) return false;
  const continuation = task.continuation;
  const source = continuation ? continuationSource(id, record.scope)?.saved : undefined;
  if (continuation && (!source?.continuation || source.continuation.segmentId !== continuation.segmentId ||
      source.continuation.model !== continuation.model || source.continuation.maximumKeyCreditCap !== continuation.maximumKeyCreditCap)) return false;
  assertProjectRoot(record.project);
  return new Promise<boolean>((resolve) => {
    const requestId = randomUUID();
    runId = randomUUID();
    pendingFollowUp = { requestId, resolve };
    activeContinuation = source && restoredNativeTask(source);
    state.busy = true;
    state.task = { ...task, status: "starting", canResumeAfterQuota: false };
    try {
      send({ ...record, type: "resume", runId, protectedRoot: app.getPath("userData"), connection,
        previous: saved, afterQuota: { requestId, refusedRequestId: quota.requestId, text,
          ...(continuation ? { continuation: { segmentId: continuation.segmentId, maximumKeyCreditCap: continuation.maximumKeyCreditCap } } : {}) } });
    } catch {
      runId = null;
      pendingFollowUp = null;
      activeContinuation = undefined;
      state.busy = false;
      state.task = task;
      resolve(false);
    }
    broadcast();
  });
}

function resumeNativeQuotaTask(task: Task, text: string, connection: Connection) {
  const { id, nativeSession } = task;
  const fixtureInput = cliRunFixture;
  const scope = currentHistoryScope();
  const project = projectRoot;
  if (!id || !nativeSession || !fixtureInput?.allowSavedHistory || connection !== fixture || !scope || !project) return false;
  const standalone = task.cliContinuation ? null : nativeHistoryRecord(id);
  const apiRecord = task.cliContinuation ? historyRecord(id) : null;
  const api = apiRecord?.storage === scope.home ? readTaskHistory(id, true) : null;
  const directory = standalone ? nativeSessionDirectory(standalone.storage, id) : api && apiCliDirectory(scope.home, id);
  if (!directory) return false;
  const saved = standalone?.saved ?? readNativeCheckpoint(directory, id, scope.root, "openai");
  if (!saved?.nativeSession || (saved.provider !== "openai" && saved.provider !== "anthropic") ||
      saved.provider !== nativeFixtureExecution.provider || saved.nativeSession.model !== fixtureInput.model ||
      saved.nativeSession.threadId !== nativeSession.threadId || saved.nativeSession.turnId !== nativeSession.turnId ||
      (saved.mode === "agent" && !fixtureInput.allowFileEdits)) return false;
  const previous = restoredNativeTask(saved);
  if (!previous.canResumeAfterQuota) return false;
  const source = saved.apiSource;
  if (source && (!api || api.quota?.source !== "tomverse_api" || api.quota.requestId !== source.requestId ||
      source.model !== fixtureInput.model || source.version !== fixtureInput.version ||
      task.cliContinuation?.segmentId !== source.segmentId)) return false;
  if (!source && !standalone) return false;
  assertProjectRoot(project);
  return new Promise<boolean>((resolve) => {
    const requestId = randomUUID();
    const command = {
      runId: randomUUID(), project, fixture: fixtureInput, prompt: text,
      history: { id, directory, previous }, afterQuota: { requestId, connection },
      protectedRoot: app.getPath("userData"), connectionKey: connection.key,
    };
    pendingFollowUp = { requestId, resolve };
    pendingNativeHistory = undefined;
    if (source && api) activeCliContinuation = {
      ...api, cliContinuation: { ...source, sourceModel: api.model, stage: "started" },
    };
    const starting: Task = { ...task, status: "starting", canResumeAfterQuota: false };
    if (saved.provider === "anthropic") {
      startCliFixtureTask(starting, { ...command, mode: saved.mode, type: "start-claude-fixture" });
    } else {
      startCliFixtureTask(starting, { ...command, mode: saved.mode, type: "start-codex-fixture",
        clientVersion: app.getVersion(),
        ...(source ? { apiSource: { ...source, scope, connection } } : {}),
      });
    }
  });
}

function recoveryCheckPending() {
  return pendingInspection?.type === "check-recovery" || pendingInspection?.type === "check-native-recovery";
}

function requestInspection<T>(command: InspectionCommand, read: (event: InspectionEvent) => T | null): Promise<T | null> {
  const runtime = worker;
  if (state.busy || pendingMutation || recoveryCheckPending() || !runtime || signingOut || closing) {
    return Promise.resolve(null);
  }
  const { requestId: id, type } = command;
  pendingInspection?.settle(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => pendingInspection?.id === id && pendingInspection.settle(null),
      type === "check-native-recovery" && command.provider === "openai" ? 55_000 : 10_000);
    pendingInspection = { id, type, settle: (event) => {
      clearTimeout(timer);
      pendingInspection = null;
      if (!event && (type === "check-recovery" || type === "check-native-recovery") && worker === runtime) {
        try { send({ type: "cancel-recovery", requestId: id }); } catch { /* The worker may have exited. */ }
      }
      try { resolve(event ? read(event) : null); }
      catch { resolve(null); }
    } };
    try { send(command); }
    catch { pendingInspection?.settle(null); }
  });
}

function readSelectedRecord<T>(request: InspectionRequest, read: (event: InspectionEvent) => T | null): Promise<T | null> {
  const record = selectedRecord();
  const connection = codeConnection();
  if (!record || !connection) return Promise.resolve(null);
  const sourceProject = projectRoot;
  const { sessionId: taskId, scope } = record;
  const requestId = randomUUID();
  const command = request.type === "check-recovery" ? { ...request, requestId, ...record, connection } : { ...request, requestId, ...record };
  return requestInspection(command, (event) => projectRoot === sourceProject && state.task?.id === taskId && codeConnection() === connection &&
    currentHistoryScope()?.home === scope.home ? read(event) : null);
}

async function checkSelectedRecovery(taskId: string): Promise<RecoveryResult> {
  const task = state.task;
  if (task?.id !== taskId || !task.canCheckRecovery) return { status: "unavailable" };
  if (DESKTOP_FIXTURE_ALLOWED && cliRunFixture?.allowSavedHistory && task.execution?.executionMode === "provider_cli") {
    const project = projectRoot;
    const scope = currentHistoryScope();
    const session = task.nativeSession;
    const provider = task.execution.provider;
    if (!project || !scope || !session || (provider !== "openai" && provider !== "anthropic") ||
        suspended || confirmingMutation || choosing) return { status: "unavailable" };
    const segmentId = task.cliContinuation?.segmentId;
    const ordinary = !segmentId ? nativeHistoryRecord(taskId) : null;
    const directory = segmentId && historyRecord(taskId)?.storage === scope.home ? apiCliDirectory(scope.home, taskId)
      : ordinary && nativeSessionDirectory(ordinary.storage, taskId);
    if (!directory) return { status: "unavailable" };
    const result = await requestInspection({
      type: "check-native-recovery", requestId: randomUUID(), directory, sessionId: taskId, segmentId,
      project, provider, session, fixture: cliRunFixture, clientVersion: app.getVersion(),
    }, (event) => {
      if (state.task !== task || projectRoot !== project || currentHistoryScope()?.home !== scope.home ||
          suspended || closing || signingOut || event.type !== "recovery-detail") return null;
      if (event.recovery.status === "checked") {
        const updated = readTaskHistory(taskId);
        if (updated?.status !== "unknown" || updated.nativeSession?.turnId !== session.turnId ||
            updated.nativeSession.threadId !== session.threadId || updated.cliContinuation?.segmentId !== segmentId) return null;
        state.task = updated;
        broadcast();
      }
      return event.recovery;
    });
    return result ?? { status: "unavailable" };
  }
  const recovery = await readSelectedRecord({ type: "check-recovery" }, (event) => {
    if (event.type !== "recovery-detail" || state.task !== task) return null;
    if (event.evidence) {
      const restored = task.continuation ? readTaskHistory(taskId) : null;
      if (restored && restored.continuation?.segmentId === task.continuation?.segmentId) state.task = restored;
      else Object.assign(task, event.evidence);
      broadcast();
    }
    return event.recovery;
  });
  return recovery ?? { status: "unavailable" };
}

function runRecordedMutation<T>(runtime: Electron.UtilityProcess, command: MutationRequest, receive: (event: MutationEvent | null) => T) {
  const id = command.requestId;
  return new Promise<T | "unconfirmed" | "unavailable">((resolve) => {
    const timer = setTimeout(() => {
      resolve("unconfirmed");
      // Keep the operation reserved until the worker exits or reports the result.
      if (pendingMutation?.id === id && worker === runtime) {
        try { runtime.kill(); } catch { /* The operation may still be running. */ }
      }
    }, 15_000);
    pendingMutation = { id, settle: (event) => {
      clearTimeout(timer);
      pendingMutation = null;
      resolve(receive(event));
      if (closing) app.quit();
    } };
    try { send(command); }
    catch {
      clearTimeout(timer);
      pendingMutation = null;
      resolve("unavailable");
    }
  });
}

async function undoSelectedChange(changeId: string): Promise<UndoChangeResult> {
  const task = state.task;
  const record = selectedRecord();
  const owner = mainWindow;
  const session = chatSession.signal;
  const runtime = worker;
  const change = task?.changes.find((entry) => entry.id === changeId);
  if (!record || !owner || !runtime || !change || change.current !== "applied" || changeId.startsWith("codex:") ||
      state.busy || pendingMutation || recoveryCheckPending() || confirmingMutation || choosing || signingOut || closing || owner.isDestroyed()) return "unavailable";
  const sourceProject = projectRoot;
  const { sessionId: taskId, scope } = record;
  confirmingMutation = true;
  try {
    const copy = nativeCopy();
    const { response } = await dialog.showMessageBox(owner, {
      type: "warning", title: copy.undoTitle, message: copy.undoPrompt,
      detail: `${change.path.replaceAll("\n", "\\n")}\n${copy.undoDetail}`,
      buttons: [copy.cancel, copy.undoAccept], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return "cancelled";
    if (owner.isDestroyed() || owner !== mainWindow || runtime !== worker || session.aborted || signingOut || closing ||
        state.busy || pendingMutation || recoveryCheckPending() || choosing || state.update.stage === "installing" ||
        state.task?.id !== taskId || projectRoot !== sourceProject || currentHistoryScope()?.home !== scope.home) return "unavailable";
    return await runRecordedMutation(runtime, { type: "undo-change", requestId: randomUUID(), ...record, recordId: changeId }, (event) => {
      if (event?.type !== "change-undone") return "unconfirmed";
      if (!session.aborted && projectRoot === sourceProject && state.task?.id === taskId && currentHistoryScope()?.home === scope.home && event.changes) {
        state.task.changes = state.task.cliContinuation?.stage === "started"
          ? [...event.changes, ...state.task.changes.filter(({ id }) => id.startsWith("codex:"))] : event.changes;
        broadcast();
      }
      return event.result;
    });
  } finally {
    confirmingMutation = false;
  }
}

async function deleteSelectedHistory(taskId: string): Promise<DeleteHistoryResult> {
  const native = DESKTOP_FIXTURE_ALLOWED ? nativeHistoryRecord(taskId) : null;
  const record = native ?? historyRecord(taskId);
  const owner = mainWindow;
  const runtime = worker;
  const session = chatSession.signal;
  const task = state.task;
  if (!record || !owner || !runtime || task?.id !== taskId || task.savedLocally === false ||
      state.busy || pendingMutation || recoveryCheckPending() || confirmingMutation || choosing || signingOut || closing || owner.isDestroyed()) return "unavailable";
  const { project, scope, storage } = record;
  const sourceProject = projectRoot;
  confirmingMutation = true;
  try {
    const source = DESKTOP_FIXTURE_ALLOWED && !native && !project.worktree ? continuationSource(taskId, scope) : null;
    const sourceIdentity = source && pathIdentity(source.directory, "directory");
    const directoryIdentity = pathIdentity(join(storage, "sessions", taskId), "directory");
    if (!directoryIdentity) return "unavailable";
    const copy = nativeCopy();
    const { response } = await dialog.showMessageBox(owner, {
      type: "warning", title: copy.deleteHistoryTitle, message: copy.deleteHistoryPrompt,
      detail: `${task.unreadable ? copy.unreadableTask : task.title}\n${copy.deleteHistoryDetail}`,
      buttons: [copy.cancel, copy.deleteHistoryAccept], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return "cancelled";
    if (owner.isDestroyed() || owner !== mainWindow || runtime !== worker || session.aborted || signingOut || closing ||
        state.busy || pendingMutation || recoveryCheckPending() || choosing || state.update.stage === "installing" ||
        state.task !== task || projectRoot !== sourceProject || currentHistoryScope()?.home !== scope.home) return "unavailable";
    if (DESKTOP_FIXTURE_ALLOWED && native) {
      if (currentNativeHistoryHome() !== storage || !nativeHistoryRecord(taskId)) return "unavailable";
      let verified = false;
      let unlockProject: (() => void) | undefined;
      try {
        unlockProject = claimCodeProject(project, codeProjectLocks());
        deleteSession(storage, taskId, (directory) => {
          assertProjectRoot(project);
          verified = directory === nativeSessionDirectory(storage, taskId) && pathIdentity(directory, "directory") === directoryIdentity &&
            pathIdentity(nativeSessionDirectory(scope.home, taskId), "directory") === null &&
            !!readNativeHistory(storage, taskId, project.path, native.saved.provider);
          return verified;
        });
        state.task = null;
        refreshHistory();
        broadcast();
        return "deleted";
      } catch {
        refreshHistory();
        broadcast();
        return verified ? "unconfirmed" : "unavailable";
      } finally {
        unlockProject?.();
      }
    }
    if (historyRecord(taskId)?.storage !== storage) return "unavailable";
    if (source && (!sourceIdentity || currentNativeHistoryHome(scope) !== source.home)) return "unavailable";
    return await runRecordedMutation(runtime, {
      type: "delete-history", requestId: randomUUID(), ...record, directoryIdentity, protectedRoot: app.getPath("userData"),
      ...(source && sourceIdentity ? { nativeSource: { home: source.home, provider: source.provider, directory: source.directory, identity: sourceIdentity } } : {}),
    }, (event) => {
      const result = event?.type === "history-deleted" ? event.result : "unconfirmed";
      if (!session.aborted && projectRoot === sourceProject && currentHistoryScope()?.home === scope.home) {
        if (result === "deleted" && state.task === task) state.task = null;
        if (result === "deleted" || result === "unconfirmed") { refreshHistory(); broadcast(); }
      }
      return result;
    });
  } catch {
    return "unavailable";
  } finally {
    confirmingMutation = false;
  }
}

async function exportDiagnostics() {
  const task = state.task;
  const owner = mainWindow;
  const session = chatSession.signal;
  if (state.busy || pendingMutation || signingOut || closing || !task?.id || !owner || owner.isDestroyed()) return false;
  const result = await dialog.showSaveDialog(owner, {
    title: nativeCopy().saveDiagnostics, defaultPath: "tomverse-code-diagnostics.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath || owner !== mainWindow || owner.isDestroyed() || session.aborted ||
      state.task !== task || state.busy || pendingMutation || signingOut || closing) return false;
  writeFileAtomic(result.filePath, codeDiagnostics(task, app.getVersion()));
  return true;
}

async function copyDiagnostics() {
  const task = state.task;
  if (!task?.id || state.busy || pendingMutation || signingOut || closing) return false;
  await clipboard.writeText(codeDiagnostics(task, app.getVersion()));
  return true;
}

function scheduleSessionCheck(delay: number) {
  clearTimeout(sessionExpiry);
  sessionExpiry = setTimeout(() => void checkBrowserSession(), delay);
}

async function refreshDesktopCapabilities(session: StoredDesktopSession, { keepCurrentOnFailure = false } = {}) {
  const capabilities = await readDesktopCapabilities(session.accessToken, AbortSignal.timeout(5_000), accountOrigin).catch(() => null);
  if (browserSession !== session || signingOut || closing || (keepCurrentOnFailure && !capabilities)) return;
  state.capabilities = capabilities;
  broadcast();
}

function setBrowserSession(account: BrowserAccount, saved: StoredDesktopSession, storage: StorageMode) {
  if (saved.expiresAt <= Date.now()) throw new Error("The Desktop session expired.");
  browserSession = saved;
  state.language = deviceLanguage ?? account.language ?? null;
  state.account = { stage: "connected", label: account.email ?? account.name ?? "Tomverse account", storage,
    draftNamespace: createHash("sha256").update(saved.accountId).digest("hex") };
  if (!linkedCode && !fixture) void restoreCodeKey(saved);
  else if (fixture && state.codeCatalog === "unavailable") requestCodeCatalog();
  void refreshDesktopCapabilities(saved);
  scheduleSessionCheck(Math.max(0, Math.min(15_000, saved.expiresAt - Date.now() - 30_000)));
}

function clearAccountWorkspace() {

  chatTurn?.abort();
  attachmentTransfer?.controller.abort();
  attachmentReceipts.clear();
  codeReferences.clear();
  chatSession.abort();
  workspaceHandoff = null;
  chatSession = new AbortController();
  if (runId) {
    discardedRunId = runId;
    stop();
  }
  pendingInspection?.settle(null);
  discardTransientTask(state.task);
  state.task = null;
  state.history = [];
  historyStorage.clear();
  historyWorktreePaths.clear();
  state.moreHistory = false;
  historyCursor = null;
  state.root = null;
  projectRoot = null;
  codeGitProject = null;
  codeWorktreeDraft = undefined;
  state.project = null;
  state.capabilities = null;
  linkAttempt?.abort();
  linkAttempt = null;
  linkedCode = null;
  state.codeKey = { stage: "missing" };
  requestCodeCatalog();
}

async function linkCodeKey(key: string, owner: StoredDesktopSession, persist: boolean) {
  if (linkAttempt || signingOut || state.busy || browserSession?.accountId !== owner.accountId) return;
  const attempt = new AbortController();
  linkAttempt = attempt;
  const previous = state.codeKey;
  state.codeKey = { stage: "checking" };
  broadcast();
  const vault = codeKeyVault(owner.accountId);
  try {
    const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(20_000)]);
    const prefix = await verifyCodeKey(key, owner.accessToken, signal, accountOrigin).catch(async (error) => {
      if (!(error instanceof DesktopSessionRefused) || browserSession !== owner) throw error;
      await renewBrowserSession(owner);
      signal.throwIfAborted();
      const refreshed = browserSession;
      if (!refreshed || refreshed === owner || refreshed.accountId !== owner.accountId) throw error;
      return verifyCodeKey(key, refreshed.accessToken, signal, accountOrigin);
    });
    signal.throwIfAborted();
    let storage: StorageMode = "device";
    if (persist) {
      await vault.clear();
      storage = await vault.save({ accountId: owner.accountId, key }, signal);
    }
    signal.throwIfAborted();
    if (browserSession?.accountId !== owner.accountId) return;
    pendingInspection?.settle(null);
    if (codeConnection()?.key !== key) {
      codeReferences.clear();
      workspaceHandoff = null;
    }
    linkedCode = { accountId: owner.accountId, connection: { key,
      endpoint: (accountOrigin ?? DESKTOP_LIVE_ORIGIN) + "/api/code/v1" } };
    state.codeKey = { stage: "connected", prefix, storage };
    discardTransientTask(state.task);
    state.task = null;
    refreshHistory();
    requestCodeCatalog();
  } catch (error) {
    if (browserSession?.accountId !== owner.accountId || attempt.signal.aborted) return;
    if (!persist && error instanceof CodeKeyRefused) await vault.clear().catch(() => {});
    if (attempt.signal.aborted) return;
    state.codeKey = { ...previous, detail: error instanceof CodeKeyRefused ? "useActiveKey" : "keyVerifyFailure" };
  } finally {
    if (linkAttempt === attempt) {
      linkAttempt = null;
      broadcast();
    }
  }
}

async function restoreCodeKey(owner: StoredDesktopSession) {
  const saved = await codeKeyVault(owner.accountId).read();
  if (saved && !linkedCode && browserSession === owner) await linkCodeKey(saved.key, owner, false);
}

async function connectCopiedCodeKey() {
  const owner = browserSession;
  if (!owner || signingOut || state.busy || linkAttempt) return;
  const key = readCopiedCodeKey(await clipboard.readText());
  if (browserSession?.accountId !== owner.accountId || signingOut) return;
  if (!key) {
    state.codeKey = { ...state.codeKey, detail: "copyKey" };
    broadcast();
    return;
  }
  await linkCodeKey(key, owner, true);
}

async function expireAccount() {
  if (invalidatingSession) return;
  invalidatingSession = true;
  clearTimeout(sessionExpiry);
  browserSession = null;
  state.account = { stage: "expired" };
  clearAccountWorkspace();
  await sessionVault().clear().catch(() => {});
  invalidatingSession = false;
  broadcast();
}

async function rotateSavedSession(previous: StoredDesktopSession, signal: AbortSignal) {
  if (!previous.refreshToken) throw new DesktopSessionRefused();
  const vault = sessionVault();
  // Remove the old refresh credential before sending it. An interrupted request
  // can have consumed it even if this process never receives the successor.
  await vault.clear();
  signal.throwIfAborted();
  const tokens = await refreshBrowserSession(previous.refreshToken, signal, accountOrigin);
  const account = await readBrowserAccount(tokens.accessToken, signal, accountOrigin);
  if (account.id !== previous.accountId) throw new DesktopSessionRefused();
  const saved = { accountId: account.id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1_000 };
  const storage = await vault.save(saved, signal);
  signal.throwIfAborted();
  return { account, saved, storage };
}

function renewBrowserSession(previous: StoredDesktopSession): Promise<void> {
  if (renewal) return renewal.done;
  const controller = new AbortController();
  const done = (async () => {
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
      const next = await rotateSavedSession(previous, signal);
      if (browserSession !== previous || signingOut) return;
      setBrowserSession(next.account, next.saved, next.storage);
      broadcast();
    } catch {
      if (browserSession === previous && !signingOut && !controller.signal.aborted) await expireAccount();
    } finally {
      renewal = null;
    }
  })();
  renewal = { controller, done };
  return done;
}

async function checkBrowserSession() {
  const active = browserSession;
  if (!active || signingOut) return;
  if (active.expiresAt - Date.now() <= 30_000) {
    await renewBrowserSession(active);
    return;
  }
  try {
    const account = await readBrowserAccount(active.accessToken, AbortSignal.timeout(5_000), accountOrigin);
    if (browserSession === active && !signingOut && account.id !== active.accountId) await expireAccount();
  } catch (error) {
    if (browserSession === active && !signingOut && error instanceof DesktopSessionRefused) await expireAccount();
  }
  if (browserSession === active && !signingOut) scheduleSessionCheck(Math.max(0, Math.min(15_000, active.expiresAt - Date.now() - 30_000)));
}

type CodePluginScope = {
  runId: string; accountId: string; connectionId: string; namespace: string; calls: number;
  signal: AbortSignal; active?: { requestId: string; controller: AbortController };
};

let codePluginScope: CodePluginScope | undefined;

function currentCodePlugin(scope: CodePluginScope) {
  return codePluginScope === scope && runId === scope.runId && discardedRunId !== scope.runId &&
    browserSession?.accountId === scope.accountId && state.capabilities?.codeMcp && !scope.signal.aborted &&
    !signingOut && !closing && !suspended && workspaceNamespace() === scope.namespace;
}

function revokeCodePlugin() {
  const scope = codePluginScope;
  codePluginScope = undefined;
  scope?.active?.controller.abort();
}

async function replyToCodePlugin(event: Extract<WorkerEvent, { type: "code-plugin" }>) {
  const child = worker;
  const scope = codePluginScope;
  const sendResult = (result: Extract<WorkerCommand, { type: "code-plugin-result" }>["result"]) => {
    if (!child || child !== worker) return;
    try {
      child.postMessage({ type: "code-plugin-result", runId: event.runId, requestId: event.requestId, result } satisfies WorkerCommand);
    } catch {
      // The worker can exit after the task or an in-flight tool is cancelled.
    }
  };
  const account = browserSession;
  const codeKey = codeConnection()?.key;
  if (!scope || !account || !codeKey || !currentCodePlugin(scope) || event.runId !== scope.runId || scope.active || scope.calls >= 6) {
    sendResult(null);
    return;
  }
  const containsCredential = (text: string) => hasCredential(text, codeKey) ||
    text.includes(account.accessToken) || Boolean(account.refreshToken && text.includes(account.refreshToken));
  if (event.action.type === "call" && containsCredential(JSON.stringify(event.action.args))) {
    sendResult(null);
    return;
  }
  const controller = new AbortController();
  const active = { requestId: event.requestId, controller };
  scope.active = active;
  scope.calls += 1;
  try {
    const api = desktopChatApi(account.accessToken, scope.signal, accountOrigin);
    const result = await api.codePlugin(scope.connectionId, event.action, controller.signal);
    const text = JSON.stringify(result);
    sendResult(currentCodePlugin(scope) && !controller.signal.aborted && !containsCredential(text) ? result : null);
  } catch {
    sendResult(null);
  } finally {
    if (scope.active === active) scope.active = undefined;
  }
}

async function withChatAccount<T>(action: (api: ReturnType<typeof desktopChatApi>) => Promise<T>,
  writing?: DesktopTextProduct | "images" | "attachments") {
  const active = browserSession;
  if (!active || signingOut || closing) throw new Error("Connect your Tomverse account first.");
  const writeAvailable = writing === "review" ? state.capabilities?.review
    : writing === "images" ? state.capabilities?.images
      : writing === "attachments" ? state.capabilities?.attachments : state.capabilities?.chatWrite;
  if (writing && (!writeAvailable || chatWriting || state.update.stage === "installing")) throw new Error("Desktop conversation changes are unavailable.");
  const signal = chatSession.signal;
  const isCurrent = () => !signingOut && !closing && !signal.aborted && browserSession?.accountId === active.accountId;
  const request = (session: StoredDesktopSession) => action(desktopChatApi(session.accessToken, signal, accountOrigin));
  if (writing) chatWriting = true;
  try {
    const result = await request(active).catch(async (error) => {
      if (writing || !(error instanceof DesktopSessionRefused) || !isCurrent()) throw error;
      if (browserSession === active) await renewBrowserSession(active);
      if (!isCurrent() || !browserSession || browserSession === active) throw error;
      return request(browserSession);
    });
    if (isCurrent()) return result;
  } catch {
    throw new Error(writing ? "Tomverse could not confirm the Chat change." : "Tomverse could not load this Chat history.");
  } finally {
    if (writing) chatWriting = false;
  }
  throw new Error("The Tomverse account changed.");
}

function resolveStagedAttachments(ids: readonly string[] | undefined) {
  if (!ids?.length) return [];
  if (!state.capabilities?.attachments) throw new Error("Desktop attachments are unavailable.");
  const attachments = ids.map((id) => {
    const receipt = attachmentReceipts.get(id);
    if (!receipt) throw new Error("A prepared attachment could not be confirmed.");
    return receipt;
  });
  if (attachments.reduce((total, attachment) => total + attachment.size, 0) > CHAT_MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error("The selected attachments exceed the size limit.");
  }
  return attachments;
}

async function uploadAttachment(input: AttachmentBytesInput) {
  if (attachmentTransfer) throw new Error("One attachment transfer is already active.");
  const transfer = { requestId: input.requestId, controller: new AbortController() };
  attachmentTransfer = transfer;
  try {
    const receipt = await withChatAccount((api) => api.uploadAttachment(input, transfer.controller.signal), "attachments");
    attachmentReceipts.set(receipt.uploadId, receipt);
    return receipt;
  } finally {
    if (attachmentTransfer === transfer) attachmentTransfer = null;
  }
}

async function importDriveAttachments(input: DriveImportInput) {
  if (!state.capabilities?.attachments || !state.capabilities.googleDrive || !browserSession || signingOut ||
      closing || attachmentTransfer || chatWriting || state.update.stage === "installing") {
    throw new Error("Google Drive attachments are unavailable.");
  }
  const accountSignal = chatSession.signal;
  const transfer = { requestId: input.requestId, controller: new AbortController() };
  const signal = AbortSignal.any([accountSignal, transfer.controller.signal]);
  const files: AttachmentUpload[] = [];
  attachmentTransfer = transfer;
  try {
    const selection = await selectDriveFiles({
      origin: accountOrigin ?? DESKTOP_LIVE_ORIGIN, language: state.language ?? "en", slots: input.slots, signal,
      openExternal: (url) => shell.openExternal(url),
    });
    signal.throwIfAborted();
    if (!selection) return { files, incomplete: false };
    const active = browserSession;
    if (!active) throw new Error("The Desktop account changed.");
    if (active.expiresAt <= Date.now() + 60_000) await renewBrowserSession(active);
    signal.throwIfAborted();
    let remaining = input.remainingBytes;
    let incomplete = false;
    return await withChatAccount(async (api) => {
      for (const file of selection.files) {
        try {
          signal.throwIfAborted();
          const receipt = await api.importDriveAttachment(file, selection.accessToken, signal);
          if (signal.aborted || receipt.size > remaining) {
            await api.discardAttachment(receipt.uploadId).catch(() => {});
            incomplete = true;
            continue;
          }
          remaining -= receipt.size;
          attachmentReceipts.set(receipt.uploadId, receipt);
          files.push(receipt);
        } catch {
          incomplete = true;
          if (signal.aborted) break;
        }
      }
      if (signal.aborted) {
        for (const receipt of files.splice(0)) {
          attachmentReceipts.delete(receipt.uploadId);
          await api.discardAttachment(receipt.uploadId).catch(() => {});
        }
      }
      return { files, incomplete };
    }, "attachments");
  } finally {
    if (attachmentTransfer === transfer) attachmentTransfer = null;
  }
}

async function removeChat(id: string) {
  return withChatAccount(async (api) => {
    const owner = browserSession?.accountId;
    const conversation = await api.conversation({ id });
    const window = mainWindow;
    if (!window || window.isDestroyed()) return false;
    const copy = nativeCopy();
    const { response } = await dialog.showMessageBox(window, {
      type: "warning", title: copy.deleteConversationTitle, message: copy.deleteConversationPrompt,
      detail: conversation.title, buttons: [copy.cancel, copy.deleteAccept], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1 || window.isDestroyed() || window !== mainWindow || signingOut || closing ||
        browserSession?.accountId !== owner) return false;
    await api.remove(id);
    return true;
  }, "chat");
}

type CodeBrowser = {
  scope: string;
  tabs: Map<string, ReturnType<typeof createCodeBrowserView>>;
  visibleTab?: string;
  grant?: { tab: string; runId: string; url: string };
};
let codeBrowser: CodeBrowser | undefined;

async function replyToBrowserSnapshot(event: Extract<WorkerEvent, { type: "browser-snapshot" }>) {
  const child = worker;
  const browser = codeBrowser;
  const grant = browser?.grant;
  const allowed = () => Boolean(DESKTOP_FIXTURE_ALLOWED && child && worker === child && runId === event.runId &&
    event.runId !== discardedRunId && state.busy && state.task?.status === "running" && !suspended &&
    browser && browser === codeBrowser && browser.scope === currentCodeBrowserScope() &&
    grant && browser.grant === grant && grant.runId === event.runId && browser.visibleTab === grant.tab);
  let text: string | null = null;
  if (allowed() && browser && grant) {
    text = await browser.tabs.get(grant.tab)?.snapshot(grant.url) ?? null;
    if (!allowed() || !fixture) text = null;
    else if (text) text = cleanText(text, fixture.key).slice(0, 6_000);
  }
  if (child && child === worker) {
    try { send({ type: "browser-snapshot-result", runId: event.runId, requestId: event.requestId, text }); }
    catch { /* The task or runtime ended before the reply. */ }
  }
}

function currentCodeBrowserScope() {
  if (!DESKTOP_FIXTURE_ALLOWED || !fixture || codeConnection() !== fixture || signingOut || closing) return null;
  const scope = currentHistoryScope();
  return scope ? JSON.stringify([scope.home, state.task?.id ?? null, state.account.stage]) : null;
}

function closeCodeBrowser() {
  const browser = codeBrowser;
  codeBrowser = undefined;
  for (const view of browser?.tabs.values() ?? []) view.close();
}

async function runCodeBrowser(value: unknown) {
  const command = browserCommand.parse(value);
  if (command.type === "close") { closeCodeBrowser(); return; }
  const owner = mainWindow;
  const scope = currentCodeBrowserScope();
  if (!scope || !owner || owner.isDestroyed()) return;
  if (codeBrowser && codeBrowser.scope !== scope) closeCodeBrowser();
  const browser: CodeBrowser = codeBrowser ??= { scope, tabs: new Map() };
  const tabId = command.tab;
  const existing = browser.tabs.get(tabId);
  if (command.type === "share" || command.type === "unshare") {
    const url = existing?.shareableUrl();
    browser.grant = command.type === "share" && fixture?.browserInspection && url && browser.visibleTab === tabId &&
      runId && state.task?.id && state.task.status === "running" && state.task.execution?.executionMode === "tomverse_api" &&
      !suspended ? { tab: tabId, runId, url } : undefined;
    return Boolean(browser.grant);
  }
  if (command.type === "close-tab") {
    if (browser.grant?.tab === tabId) browser.grant = undefined;
    browser.tabs.delete(tabId);
    existing?.close();
    return;
  }
  if (command.type === "open") {
    const target = loopbackBrowserUrl(command.url);
    if (!target) throw new Error("Enter an HTTP loopback address with an explicit port.");
    if (browser.grant?.tab === tabId) browser.grant = undefined;
    if (existing?.origin === target.origin) return existing.load(target.href);
    if (!existing && browser.tabs.size >= MAX_CODE_BROWSER_TABS) throw new Error("Close a browser tab before opening another.");
    existing?.close();
    const view = createCodeBrowserView(owner, target.origin, tabId, (next) => {
      if (browser.grant?.tab === tabId && (next.url !== browser.grant.url || next.loading || next.failed)) browser.grant = undefined;
      if (codeBrowser?.tabs.get(tabId) === view && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("desktop:code-browser-state", next);
      }
    });
    browser.tabs.set(tabId, view);
    return view.load(target.href);
  }
  if (command.type === "layout") {
    browser.visibleTab = command.bounds ? tabId : undefined;
    if (browser.grant?.tab !== browser.visibleTab) browser.grant = undefined;
    for (const [id, view] of browser.tabs) if (id !== tabId) view.hide();
  }
  existing?.apply(command);
}

let accountSettingsApi: { signal: AbortSignal; request: ReturnType<typeof createAccountSettingsApi> } | undefined;

function connectedSettingsApi() {
  const active = browserSession;
  if (!active || state.account.stage !== "connected" || signingOut || closing) throw new Error("Connect your Tomverse account first.");
  const signal = chatSession.signal;
  if (accountSettingsApi?.signal !== signal) {
    const accountId = active.accountId;
    accountSettingsApi = {
      signal,
      request: createAccountSettingsApi(accountOrigin ?? DESKTOP_LIVE_ORIGIN, async () => {
        signal.throwIfAborted();
        if (signingOut || closing || browserSession?.accountId !== accountId) throw new Error("The Desktop account changed.");
        if (browserSession.expiresAt <= Date.now() + 30_000) await renewBrowserSession(browserSession);
        signal.throwIfAborted();
        if (signingOut || closing || browserSession?.accountId !== accountId) throw new Error("The Desktop account changed.");
        return browserSession.accessToken;
      }, signal),
    };
  }
  return accountSettingsApi.request;
}

async function accountSettings(value: unknown) {
  const input = desktopAccountSettingsInput.parse(value);
  const request = connectedSettingsApi();
  if (input.action === "pinConversation" && (state.account.stage !== "connected" || input.accountScope !== state.account.draftNamespace)) {
    return { kind: "refused" } as const;
  }
  return request(input);
}

async function sendChat(request: ChatTurnInput): Promise<ChatTurnResult> {
  const { handoffId, ...draft } = request;
  if (draft.deepResearchDepth || draft.modelId === DEEP_RESEARCH_MODEL_ID) {
    if (!state.capabilities?.deepResearch || !draft.deepResearchDepth || draft.modelId !== DEEP_RESEARCH_MODEL_ID ||
        draft.selectionMode !== "manual" || !draft.prompt.trim() || handoffId) {
      throw new Error("Deep Research is unavailable for this draft.");
    }
  }
  if (handoffId && draft.conversationId) throw new Error("Use the excerpt in a new Chat draft.");
  if (draft.tools && !state.capabilities?.composerTools) throw new Error("Chat composer options are unavailable.");
  const attachments = resolveStagedAttachments(draft.attachmentUploadIds);
  return withChatAccount(async (api) => {
    const input = { ...draft, prompt: withHandoffExcerpt("chat", draft.prompt, handoffId),
      currentLocation: accountPermissionsFixture() ? draft.currentLocation : undefined };
    const window = mainWindow;
    const turn = new AbortController();
    chatTurn = turn;
    const signal = turn.signal;
    const accountSignal = chatSession.signal;
    let assistantId: string = randomUUID();
    let id = input.conversationId;
    let sourceId: string | undefined;
    let partial = "";
    let modelId: string | undefined;
    let applied: ChatTurnResult["applied"];
    let streamStarted = false;
    let failed = false;
    let contextChanged = false;
    let researchSubmitted = false;
    let lastProgressAt = 0;
    const publish = (update: Omit<ChatTurnProgress, "requestId" | "conversationId">) => {
      if (!id || !window || window.isDestroyed() || window.webContents.isDestroyed() || window !== mainWindow ||
          accountSignal.aborted || signal.aborted || signingOut || closing) return;
      window.webContents.send("chat:progress", { requestId: input.requestId, conversationId: id, ...update });
    };
    try {
      try {
        if (id) await api.configure(await api.conversation({ id }, true, signal), input, signal);
        else {
          id = await api.create(input, signal);
          if (input.tools && Object.keys(input.tools).length) {
            await api.configure(await api.conversation({ id }, true, signal), input, signal);
          }
        }
        publish({});
        sourceId = await api.saveQuestion(id, input, signal);
        if (input.deepResearchDepth) assistantId = desktopResearchAnswerId(id, sourceId);
        if (handoffId) removeWorkspaceHandoff(handoffId);
        for (const attachment of attachments) attachmentReceipts.delete(attachment.uploadId);
        publish({ savedPrompt: input.prompt });
        const saved = await api.conversation({ id }, true, signal);
        streamStarted = true;
        const result = await api.stream(saved, input, sourceId, assistantId, signal, (text) => {
          if (text === partial) return;
          partial = text;
          const now = Date.now();
          if (now - lastProgressAt >= 50) {
            lastProgressAt = now;
            publish({ text });
          }
        }, (id) => {
          modelId = id;
          publish({ modelId: id });
        });
        researchSubmitted = Boolean(result && "deepResearch" in result);
        applied = result?.appliedReasoningEffort;
        if (applied) publish({ applied });
      } catch (error) {
        failed = !signal.aborted;
        contextChanged = failed && error instanceof DesktopChatContextChanged;
      }
      const savedId = id;
      const conversation = savedId && !accountSignal.aborted
        ? await withChatAccount((fresh) => fresh.conversation({ id: savedId }, true)).catch(() => null)
        : null;
      const answer = conversation?.messages.find((message) => message.id === assistantId);
      const status = answer?.status === "normal" ? "saved"
        : input.deepResearchDepth && (answer?.status === "pending" || researchSubmitted && !answer) ? "researching"
          : signal.aborted ? "stopped"
          : input.deepResearchDepth && answer?.status === "error" ? "failed"
          : input.deepResearchDepth && answer?.status === "incomplete" ? "unconfirmed"
          : answer || partial ? "partial" : contextChanged ? "failed"
            : streamStarted ? "unconfirmed" : failed ? "failed" : "unconfirmed";
      return { conversation, status, partial: answer ? "" : partial, modelId, applied, savedQuestion: Boolean(sourceId),
        ...(contextChanged && status === "failed" ? { contextChanged: true } : {}) };
    } finally {
      if (chatTurn === turn) chatTurn = null;
    }
  }, "chat");
}

async function sendReview(input: ReviewTurnInput): Promise<ReviewTurnResult> {
  const attachments = resolveStagedAttachments(input.attachmentUploadIds);
  const capability = state.capabilities?.review;
  if (!capability || input.choices.length > capability.modelLimit || (input.mode === "easy" && !capability.easy)) {
    throw new Error("The selected Review options are unavailable.");
  }
  return withChatAccount(async (api) => {
    const window = mainWindow;
    const turn = new AbortController();
    chatTurn = turn;
    const signal = turn.signal;
    const accountSignal = chatSession.signal;
    let id = input.conversationId;
    let savedQuestion = false;
    let dispatching = false;
    const responses = new Map<string, { id: string; text: string }>();
    const publish = (update: Omit<ReviewTurnProgress, "requestId" | "conversationId">) => {
      if (!id || !window || window !== mainWindow || window.isDestroyed() || window.webContents.isDestroyed() ||
          accountSignal.aborted || signal.aborted || signingOut || closing) return;
      window.webContents.send("review:progress", { requestId: input.requestId, conversationId: id, ...update });
    };
    try {
      try {
        let current = id ? await api.conversation({ id, product: "review" }, true, signal) : null;
        let modelIds = input.choices;
        if (input.mode === "easy") {
          const context = current?.messages.filter((message) => message.role === "user").slice(-2)
            .map((message) => message.content).join("\n") ?? "";
          const decision = await api.routeReview(input, context, signal, attachments);
          if (decision?.kind === "image" && state.capabilities?.images && !attachments.length) {
            const models = decision.choices.flatMap(({ modelId }) => modelId ? [modelId] : []);
            if (models.length) return { conversation: null, status: "saved", savedQuestion: false, partial: [],
              imageOffer: { prompt: input.prompt, models, quality: IMAGE_QUALITY_BY_PRESET[decision.preset],
                unavailable: decision.choices.flatMap(({ modelId, provider }) => modelId ? [] : [provider]) } };
          }
          if (decision?.kind !== "text" || decision.choices.some((choice) => !choice.modelId)) {
            throw new Error("Tomverse could not route this Review as text.");
          }
          modelIds = decision.choices.map((choice) => choice.modelId!);
        }
        if (input.effort !== "default") {
          const effort = input.effort;
          const models = await api.models();
          if (input.mode !== "professional" || modelIds.some((modelId) =>
            !models.find((model) => model.id === modelId)?.reasoningEfforts?.includes(effort))) {
            throw new Error("The selected models do not share this reasoning effort.");
          }
        }
        if (!id) {
          id = await api.createReview(modelIds, input.prompt, signal);
        } else if (current) {
          await api.configureReview(current, modelIds, signal);
        }
        current = await api.conversation({ id, product: "review" }, true, signal);
        if (current.selectedModels.length !== modelIds.length || !modelIds.every((modelId) => current!.selectedModels.includes(modelId))) {
          throw new Error("Tomverse did not confirm the selected Review models.");
        }
        const admission = modelIds.length > 1 ? await api.admitReview(current, input, modelIds, signal, attachments) : undefined;
        const sourceId = await api.saveQuestion(id, input, signal);
        savedQuestion = true;
        for (const attachment of attachments) attachmentReceipts.delete(attachment.uploadId);
        publish({ savedPrompt: input.prompt });
        const saved = await api.conversation({ id, product: "review" }, true, signal);
        dispatching = true;
        await Promise.allSettled(modelIds.map(async (modelId) => {
          const assistant = { id: randomUUID(), text: "" };
          responses.set(modelId, assistant);
          let lastProgressAt = 0;
          await api.stream(saved, { modelId, selectionMode: "manual", effort: input.effort, review: true, admission },
            sourceId, assistant.id, signal, (text) => {
              assistant.text = text;
              const now = Date.now();
              if (now - lastProgressAt >= 50) {
                lastProgressAt = now;
                publish({ modelId, text });
              }
            });
        }));
      } catch {
        // Keep any saved question available for a readback after a refusal or transport failure.
      }
      const savedId = id;
      const conversation = savedId && !accountSignal.aborted
        ? await withChatAccount((fresh) => fresh.conversation({ id: savedId, product: "review" }, true)).catch(() => null)
        : null;
      const stored = new Map(conversation?.messages.map((message) => [message.id, message]));
      const partial = [...responses].flatMap(([modelId, response]) =>
        response.text && !stored.has(response.id) ? [{ modelId, text: response.text }] : []);
      const completed = [...responses.values()].filter(({ id }) => stored.get(id)?.status === "normal").length;
      const status = completed && completed === responses.size ? "saved" : signal.aborted ? "stopped"
        : completed || partial.length ? "partial" : dispatching ? "unconfirmed" : "failed";
      return { conversation, status, savedQuestion, partial };
    } finally {
      if (chatTurn === turn) chatTurn = null;
    }
  }, "review");
}

async function saveGeneratedFile(load: () => Promise<{ bytes: Uint8Array; suggestedName: string; extension: string }>,
  title: string, filterName: string) {
  const window = mainWindow;
  const accountSignal = chatSession.signal;
  const owner = browserSession?.accountId;
  if (!window || !owner) return false;
  const current = () => window === mainWindow && !window.isDestroyed() && !accountSignal.aborted &&
    !signingOut && !closing && browserSession?.accountId === owner;
  if (!current() || savingGenerated || state.update.stage === "installing") return false;
  savingGenerated = true;
  try {
    const { bytes, suggestedName, extension } = await load();
    if (!current()) return false;
    const target = await dialog.showSaveDialog(window, {
      title, defaultPath: suggestedName, filters: [{ name: filterName, extensions: [extension] }],
    });
    if (target.canceled || !target.filePath || !isAbsolute(target.filePath) || !current()) return false;
    const staging = join(dirname(target.filePath), `.tomverse-save-${randomUUID()}.tmp`);
    const file = await open(staging, "wx", 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      if (!current()) return false;
      await link(staging, target.filePath);
      return true;
    } finally {
      await unlink(staging).catch(() => {});
    }
  } finally {
    savingGenerated = false;
  }
}

function saveImage(id: string, modelId: string) {
  const copy = nativeCopy();
  return saveGeneratedFile(async () => {
    const image = await withChatAccount((api) => api.imageBytes(id, false));
    return { bytes: image.bytes, suggestedName: imageDownloadFilename({ generationId: id, modelId, mimeType: image.mimeType }),
      extension: imageDownloadExtension(image.mimeType) };
  }, copy.saveImage, copy.imageFilter);
}

function saveArtifact(input: SaveArtifactInput) {
  const format = requireArtifactFormat(input.format);
  return saveGeneratedFile(async () => ({
    bytes: await withChatAccount((api) => api.artifactBytes(input)),
    suggestedName: sanitizeArtifactFilename(input.filename, input.format),
    extension: format.extension.slice(1),
  }), nativeCopy().saveGenerated, format.label);
}

async function restoreBrowserSession() {
  if (!DESKTOP_AUTH_ALLOWED) return;
  const attempt = new AbortController();
  loginAttempt = attempt;
  state.account = { stage: "restoring" };
  try {
    const saved = await sessionVault().read();
    if (!saved) {
      state.account = { stage: "idle" };
      return;
    }
    const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(12_000)]);
    if (saved.expiresAt - Date.now() <= 30_000) {
      const next = await rotateSavedSession(saved, signal);
      setBrowserSession(next.account, next.saved, next.storage);
      return;
    }
    const account = await readBrowserAccount(saved.accessToken, signal, accountOrigin);
    signal.throwIfAborted();
    if (account.id !== saved.accountId) throw new Error("The saved Desktop account changed.");
    setBrowserSession(account, saved, "device");
  } catch {
    state.account = { stage: "idle" };
  } finally {
    loginAttempt = null;
    broadcast();
  }
}

async function completeSignIn(result: BrowserSession, signal: AbortSignal) {
  signal.throwIfAborted();
  const saved = { accountId: result.account.id, accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken,
    expiresAt: Date.now() + result.tokens.expiresIn * 1_000 };
  const vault = sessionVault();
  await vault.clear();
  const storage = await vault.save(saved, signal);
  signal.throwIfAborted();
  clearAccountWorkspace();
  setBrowserSession(result.account, saved, storage);
}

async function signIn(provider?: DesktopIdentityProvider) {
  if (!DESKTOP_AUTH_ALLOWED || loginAttempt || browserSession || signingOut || invalidatingSession || closing) return;
  const attempt = new AbortController();
  loginAttempt = attempt;
  state.account = { stage: "waiting" };
  broadcast();
  try {
    const result = await signInThroughBrowser({ openExternal: (url) => shell.openExternal(url),
      version: app.getVersion(), signal: attempt.signal, origin: accountOrigin, provider });
    await completeSignIn(result, attempt.signal);
  } catch {
    state.account = { stage: attempt.signal.aborted ? "idle" : "failed" };
  } finally {
    loginAttempt = null;
    broadcast();
  }
}

async function submitEmailLogin(input: DesktopLoginEmail): Promise<DesktopEmailResult> {
  if (!DESKTOP_LOGIN_WINDOW_REQUIRED || browserSession || loginAttempt || signingOut || invalidatingSession || closing) {
    return { ok: false, status: "unavailable" };
  }
  const attempt = new AbortController();
  loginAttempt = attempt;
  try {
    const send = (proof?: string) => signInByDesktopEmail(input, app.getVersion(), attempt.signal, accountOrigin, proof, state.language ?? undefined);
    let result = await send();
    if (!result.ok && result.status === "challenge" && input.action === "request" && loginWindow) {
      const proof = await solveEmailLoginChallenge(loginWindow, accountOrigin ?? DESKTOP_LIVE_ORIGIN, attempt.signal);
      if (proof) result = await send(proof);
    }
    if (result.ok && "session" in result) await completeSignIn(result.session, attempt.signal);
    return result.ok ? { ok: true } : result;
  } catch {
    return { ok: false, status: "failed" };
  } finally {
    if (loginAttempt === attempt) loginAttempt = null;
    broadcast();
  }
}

async function signOut() {
  const active = browserSession;
  if (!active || signingOut) return;
  const connected = state.account;
  signingOut = true;
  chatTurn?.abort();
  attachmentTransfer?.controller.abort();
  renewal?.controller.abort();
  state.account = { stage: "signing-out" };
  broadcast();
  try {
    await sessionVault().clear();
    clearTimeout(sessionExpiry);
    browserSession = null;
    clearAccountWorkspace();
    state.account = { stage: "idle" };
    if (active.refreshToken) {
      try {
        await revokeBrowserSession(active.refreshToken, AbortSignal.timeout(5_000), accountOrigin);
      } catch {
        state.account = { stage: "idle", detail: "signOutRevokeFailure" };
      }
    }
  } catch {
    state.account = { ...connected, detail: "signOutStorageFailure" };
  } finally {
    signingOut = false;
    if (browserSession === active) scheduleSessionCheck(0);
    broadcast();
  }
}

function taskPulls() {
  const task = state.task;
  if (!task?.id || !task.savedLocally || task.unreadable || closing || signingOut ||
      state.busy || pendingMutation || confirmingMutation) return null;
  const record = historyRecord(task.id) ?? (DESKTOP_FIXTURE_ALLOWED ? nativeHistoryRecord(task.id) : null);
  if (!record) return null;
  try {
    const directory = join(record.storage, "sessions", sessionId.parse(task.id));
    const identity = pathIdentity(directory, "directory");
    if (!identity || realpathSync(directory) !== directory) return null;
    return { identity, file: join(directory, "github-links.json") };
  } catch { return null; }
}

const taskPullsInFlight = new Set<string>();

async function readTaskPullCommand(value: unknown) {
  const command = taskPullCommand.parse(value);
  const location = taskPulls();
  if (!location) return [];
  const readSaved = () => {
    try {
      if (!pathIdentity(location.file, "file") || statSync(location.file).size > 16_384) return [];
      return z.array(pullEvidence).max(10).parse(JSON.parse(readFileSync(location.file, "utf8")))
        .filter((row) => githubPullUrl(row.url));
    } catch { return []; }
  };
  if (command.type === "list") return readSaved();
  if (command.type === "open") {
    const link = githubPullUrl(command.link.url);
    const saved = readSaved();
    if (link && saved.some((row) => row.url === link.url)) await shell.openExternal(link.url);
    return saved;
  }
  if (taskPullsInFlight.has(location.file)) throw new Error("A GitHub check is already running for this task.");
  taskPullsInFlight.add(location.file);
  try {
    const session = chatSession.signal;
    const result = await readGithubPull(command.link, session);
    const current = taskPulls();
    if (session.aborted || current?.file !== location.file || current.identity !== location.identity) return [];
    const updated = [result, ...readSaved().filter((row) => row.url.toLowerCase() !== result.url.toLowerCase() ||
      row.environment !== result.environment)].slice(0, 10);
    writeFileAtomic(location.file, JSON.stringify(updated));
    return updated;
  } finally { taskPullsInFlight.delete(location.file); }
}

let dictation: { id: string; session: AbortSignal; expiry: number; mediaGranted: boolean; sent: boolean; controller: AbortController } | undefined;

function accountPermissionsFixture() {
  return DESKTOP_FIXTURE_ALLOWED && DESKTOP_ACCOUNT_DEVICE_FIXTURE_ALLOWED && Boolean(DESKTOP_AUTH_FIXTURE_ORIGIN) &&
    accountOrigin === DESKTOP_AUTH_FIXTURE_ORIGIN &&
    Boolean(browserSession) && !suspended && !signingOut && !closing;
}

let geolocationGrant: { session: AbortSignal; expiry: number } | undefined;

function mayRequestChatLocation(contents: Electron.WebContents | null) {
  return Boolean(accountPermissionsFixture() && geolocationGrant && !geolocationGrant.session.aborted &&
    Date.now() < geolocationGrant.expiry && mainWindow && !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents && contents.getURL() === shellUrl);
}

function stopDictation(notify = false) {
  const active = dictation;
  dictation = undefined;
  active?.controller.abort();
  if (notify && active && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("desktop:dictation-stop");
  }
}

function mayRequestDictation(contents: Electron.WebContents | null) {
  return Boolean(accountPermissionsFixture() && dictation && !dictation.session.aborted && !dictation.sent &&
    !dictation.mediaGranted && Date.now() < dictation.expiry && mainWindow && !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents && contents.getURL() === shellUrl);
}

function registerIpc() {
  const update = updates();
  const main = (name: string, action: (input: unknown) => unknown) => ipcMain.handle(name, (event, input: unknown) => {
    trusted(event, mainWindow, shellUrl);
    if (DESKTOP_LOGIN_WINDOW_REQUIRED && state.account.stage !== "connected") throw new Error("Sign in to Tomverse Desktop.");
    return action(input);
  });
  const login = (name: string, action: (input: unknown) => unknown) => ipcMain.handle(name, (event, input: unknown) => {
    trusted(event, loginWindow, loginUrl);
    return action(input);
  });
  login("login:state", () => ({ account: state.account, language: state.language }));
  login("login:provider", (input) => signIn(desktopIdentityProvider.parse(input)));
  login("login:email", (input) => submitEmailLogin(desktopLoginEmail.parse(input)));
  login("login:cancel", () => { loginAttempt?.abort(); });
  login("login:quit", () => { loginAttempt?.abort(); app.quit(); });
  main("desktop:state", () => {
    refreshCodeFallbackSettings();
    return { ...state, handoff: currentHandoff() };
  });
  main("desktop:code-browser", runCodeBrowser);
  main("desktop:location-arm", () => {
    if (!accountPermissionsFixture()) return false;
    geolocationGrant = { session: chatSession.signal, expiry: Date.now() + 12_000 };
    return true;
  });
  main("desktop:dictation-arm", () => {
    if (!accountPermissionsFixture()) return null;
    stopDictation();
    const id = randomUUID();
    dictation = { id, session: chatSession.signal, expiry: Date.now() + 15_000, mediaGranted: false, sent: false,
      controller: new AbortController() };
    return id;
  });
  main("desktop:dictation-cancel", (value) => { if (dictation?.id === z.uuid().parse(value)) stopDictation(); });
  main("desktop:dictation-transcribe", async (value) => {
    const input = dictationClip.parse(value);
    const active = dictation;
    if (!accountPermissionsFixture() || !active || active.id !== input.id || active.session.aborted || active.sent || !active.mediaGranted) {
      return { status: 403, code: "VOICE_INPUT_DISABLED" };
    }
    active.sent = true;
    try { return await withChatAccount((api) => api.transcribeDictation(input, active.controller.signal)); }
    finally { if (dictation === active) stopDictation(); }
  });
  main("desktop:task-pulls", readTaskPullCommand);
  main("desktop:language", (value) => setLanguage(z.enum(SUPPORTED_LANGUAGES).parse(value)));
  main("desktop:code-execution-preference", (value) => setCodeExecutionPreference(codeExecutionMode.parse(value)));
  main("desktop:update-code-fallback", (value) => saveCodeFallback(codeFallbackUpdate.parse(value)));
  main("desktop:choose-cli-path", (value) => chooseCliPath(cliProvider.optional().parse(value)));
  main("desktop:save-cli-path", (value) => saveCliPath(cliPathInput.parse(value)));
  main("desktop:remove-cli-path", (value) => removeCliPath(cliProvider.parse(value)));
  const readCliAccount = DESKTOP_CLI_AUTH_FIXTURE_ALLOWED ? checkCliAccount : () => unknownCliAccount;
  main("desktop:check-cli-account", (value) => readCliAccount(cliProvider.parse(value)));
  const readCliProtocol = DESKTOP_CLI_PROTOCOL_CHECK_ALLOWED ? checkCliProtocol : () => ({ status: "unavailable" });
  main("desktop:check-cli-protocol", (value) => readCliProtocol(cliProvider.parse(value)));
  main("desktop:cancel-cli-check", (value) => {
    const kind = z.enum(["account", "protocol"]).parse(value);
    if (cliInspection?.kind === kind) cliInspection.controller.abort();
  });
  main("desktop:open-cli-auth-guide", (value) => webViewHost.openGuide(cliAuthGuides[cliProvider.parse(value)]));
  main("desktop:web-view", (value) => webViewHost.run(value));
  main("desktop:choose-root", chooseRoot);
  main("desktop:retry-code-catalog", retryCodeCatalog);
  main("desktop:confirm-handoff", (value) => confirmWorkspaceHandoff(workspaceHandoffInput.parse(value)));
  main("desktop:remove-handoff", (value) => removeWorkspaceHandoff(z.uuid().parse(value)));
  main("desktop:choose-code-references", (value) => chooseCodeReferences(codeReferenceKind.parse(value)));
  main("desktop:remove-code-reference", (value) => { codeReferences.delete(z.uuid().parse(value)); });
  main("desktop:new-task", async () => {
    if (state.busy || pendingMutation || choosing) return;
    discardTransientTask(state.task);
    state.task = null;
    codeWorktreeDraft = undefined;
    const project = projectRoot;
    if (project) {
      choosing = true;
      try {
        const git = await readGitProject(project);
        if (projectRoot === project) codeGitProject = git;
      } finally { choosing = false; }
    }
    broadcast();
  });
  main("desktop:start", async (value) => {
    const { handoffId, executionMode, workspace, ...draft } = startInput.parse(value);
    if (recoveryCheckPending()) throw new Error("Wait for the recovery check to finish.");
    const connection = codeConnection();
    const sourceProject = projectRoot;
    const scope = currentHistoryScope();
    const preference = state.codeExecutionPreference;
    const installingUpdate = () => state.update.stage === "installing";
    if (!worker || !sourceProject || state.busy || pendingMutation || signingOut || linkAttempt || suspended || closing ||
        installingUpdate() || choosing) {
      throw new Error("Choose an available project and Code connection first.");
    }
    const references = (draft.referenceIds ?? []).map((referenceId) => {
      const reference = codeReferences.get(referenceId);
      if (!reference) throw new Error("Select the project references again.");
      return { path: reference.path, kind: reference.kind };
    });
    if (draft.permissionProfile === "accept_edits" && (readProjectPermissionProfile() !== "accept_edits" || draft.mode !== "agent" || preference !== "tomverse_api")) {
      throw new Error("Accept Edits is unavailable for this execution route.");
    }
    if (draft.pluginConnectionId && (draft.mode !== "ask" || preference !== "tomverse_api" || draft.saveHistory !== false ||
      !state.capabilities?.codeMcp || !browserSession || !workspaceNamespace())) {
      throw new Error("Code plugins require a connected account and an Ask task without local history.");
    }
    if (DESKTOP_FIXTURE_ALLOWED && cliRunFixture && preference === "provider_cli") {
      if (workspace?.kind === "worktree") throw new Error("This Code execution route requires an existing folder.");
      const home = draft.saveHistory === true ? currentNativeHistoryHome(scope) : null;
      if (draft.mode === "agent" && !cliRunFixture.allowFileEdits) {
        throw new Error("The CLI fixture requires a read-only request.");
      }
      if (executionMode !== "provider_cli" || draft.model !== cliRunFixture.model || draft.effort !== "default" ||
          (draft.mode === "agent" && !home) ||
          (draft.saveHistory !== false && !home)) {
        throw new Error("The CLI fixture requires a supported request and history preference.");
      }
      const prompt = withHandoffExcerpt("code", draft.prompt, handoffId);
      if (connection && hasCredential(prompt, connection.key)) throw new Error("The Code request contains a Tomverse credential.");
      assertProjectRoot(sourceProject);
      startNativeTask(cliRunFixture, sourceProject, draft.mode, prompt, home, undefined, references.length ? references : undefined);
      if (handoffId) removeWorkspaceHandoff(handoffId);
      return;
    }
    const model = state.models.find((candidate) => candidate.id === draft.model);
    if (!connection || !scope || !model) {
      throw new Error("Choose an available project and Code connection first.");
    }
    const route = codeRouteFor(preference, model);
    if (route.executionMode !== "tomverse_api") throw new Error("The selected Code execution route is unavailable.");
    if (executionMode && executionMode !== route.executionMode) throw new Error("The Code execution route changed. Check the selected route and try again.");
    const input = { ...draft, prompt: withHandoffExcerpt("code", draft.prompt, handoffId) };
    if (workspace?.kind === "worktree" && draft.mode !== "agent") throw new Error("Select Agent to start a worktree.");
    assertProjectRoot(sourceProject);
    let worktree: ManagedWorktree | undefined;
    if (draft.mode === "agent" && workspace?.kind !== "local" && (codeGitProject || workspace?.kind === "worktree")) {
      if (hasCredential(input.prompt, connection.key)) throw new Error("The Code request contains a Tomverse credential.");
      const git = codeGitProject;
      const reservation = codeWorktreeDraft;
      if (!git || git === "unavailable" || !reservation || (workspace && reservation.id !== workspace.id)) {
        throw new Error("Check the starting branch or select the current folder.");
      }
      const session = chatSession.signal;
      choosing = true;
      try {
        worktree = await createManagedWorktree(sourceProject, git, reservation.home, reservation.id, workspace?.base ?? git.bases[0]!, {
          references,
          checkReady(project) {
            if (projectRoot !== sourceProject || codeConnection() !== connection || !worker || session.aborted || signingOut ||
                suspended || closing || installingUpdate() || state.codeExecutionPreference !== preference) {
              throw new Error("The Code connection changed.");
            }
            const checkout = new Workspace(project.path, [app.getPath("userData"), codeProjectLocks()]);
            for (const reference of references) {
              if (checkout.reference(reference.path).kind !== reference.kind) throw new Error("A selected reference is unavailable in this branch.");
            }
          },
        });
      } catch {
        codeWorktreeDraft = undefined;
        if (projectRoot === sourceProject && !session.aborted && !closing) codeGitProject = await readGitProject(sourceProject);
        broadcast();
        throw new Error("The worktree could not start. Check your starting branch and project references.");
      } finally { choosing = false; }
    }
    const project = worktree?.project ?? sourceProject;
    const taskScope = worktree ? managedScope(scope, project) : scope;
    assertProjectRoot(project);
    const id = randomUUID();
    runId = id;
    revokeCodePlugin();
    if (draft.pluginConnectionId && browserSession) {
      codePluginScope = { runId: id, accountId: browserSession.accountId, connectionId: draft.pluginConnectionId,
        namespace: workspaceNamespace()!, calls: 0, signal: chatSession.signal };
    }
    state.busy = true;
    const prompt = cleanText(input.prompt, connection.key);
    discardTransientTask(state.task);
    state.task = { id: null, root: project.path, worktree: worktree?.info, title: prompt.slice(0, 80), status: "starting", entries: [{ role: "user", text: prompt }],
      execution: route, changes: [], checks: [], transmission: [], readOnly: input.mode !== "agent", savedLocally: input.saveHistory !== false, references };
    const approval = state.codeFallback;
    pendingCliContinuation = !worktree && input.permissionProfile !== "accept_edits" && DESKTOP_FIXTURE_ALLOWED && connection === fixture && codexRunFixture?.allowSavedHistory &&
      (input.mode !== "agent" || codexRunFixture.allowFileEdits) && input.saveHistory !== false &&
      approval?.settings.automaticFrom === "tomverse_api"
      ? { mode: input.mode, project, approval } : undefined;
    send({ type: "start", runId: id, project, scope: taskScope, protectedRoot: app.getPath("userData"), connection, input, references, preference,
      ...(DESKTOP_FIXTURE_ALLOWED && connection === fixture && fixture?.browserInspection ? { browserSnapshot: true } : {}) });
    if (handoffId) removeWorkspaceHandoff(handoffId);
    codeReferences.clear();
    codeWorktreeDraft = undefined;
    broadcast();
  });
  main("desktop:permission-profile", (value) => {
    const profile = codePermissionProfile.parse(value);
    const path = projectPermissionPath();
    if (!path || !projectRoot || state.busy || signingOut || choosing || closing) return false;
    assertProjectRoot(projectRoot);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, profile);
    broadcast();
    return true;
  });
  main("desktop:stop", stop);
  main("desktop:follow-up", (value) => {
    const { id, text } = followUpInput.parse(value);
    const task = state.task;
    if (typeof id === "string" && task?.status === "clarification") return answerCodeClarification(id, text);
    if (typeof id === "string" && task?.status === "blocked") return resumeQuotaTask(id, text);
    const connection = codeConnection();
    const activeRunId = runId;
    const matchesTask = typeof id === "string" ? task?.id === id && task.execution?.executionMode === "tomverse_api"
      : DESKTOP_FIXTURE_ALLOWED && cliRunFixture && task?.execution?.executionMode === "provider_cli" &&
        task.execution.provider === nativeFixtureExecution.provider &&
        task.nativeSession?.threadId === id.threadId && task.nativeSession.turnId === id.turnId;
    if (!worker || !connection || !projectRoot || !activeRunId || activeRunId === discardedRunId || !state.busy ||
        !matchesTask || task?.status !== "running" || task.pendingFollowUp || pendingFollowUp || suspended || closing || signingOut ||
        hasCredential(text, connection.key)) return false;
    assertProjectRoot(projectRoot);
    if (task.worktree) {
      const scope = currentHistoryScope();
      const activeWorktree = scope && readManagedWorktree(managedWorktreeHome(scope), task.root);
      if (!activeWorktree || activeWorktree.info.unavailable) return false;
    }
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      pendingFollowUp = { requestId, resolve };
      try { send({ type: "follow-up", runId: activeRunId, requestId, text }); }
      catch {
        pendingFollowUp = null;
        resolve(false);
      }
    });
  });
  main("desktop:resume", (value) => {
    const session = sessionId.parse(value);
    const task = state.task;
    const connection = codeConnection();
    if (!task?.canResume || task.status !== "stopped" || task.id !== session || !worker || !connection ||
        state.busy || pendingMutation || recoveryCheckPending() || signingOut || linkAttempt || suspended || closing ||
        state.update.stage === "installing" || choosing || confirmingMutation) return false;
    if (DESKTOP_FIXTURE_ALLOWED && cliRunFixture?.allowSavedHistory && task.execution?.executionMode === "provider_cli") {
      const native = nativeHistoryRecord(session);
      if (!native?.saved.nativeSession || (native.saved.mode === "agent" && (native.saved.provider === "openai" || !cliRunFixture.allowFileEdits)) ||
          native.saved.status !== "stopped" || state.codeExecutionPreference !== "provider_cli" ||
          native.saved.provider !== task.execution.provider || native.saved.nativeSession.model !== cliRunFixture.model ||
          native.saved.nativeSession.turnId !== task.nativeSession?.turnId ||
          native.saved.nativeSession.threadId !== task.nativeSession.threadId) return false;
      assertProjectRoot(native.project);
      startNativeTask(cliRunFixture, native.project, native.saved.mode, "Continue the stopped task from its saved context.", native.storage, restoredNativeTask(native.saved));
      return true;
    }
    const record = selectedRecord();
    if (!record) return false;
    assertProjectRoot(record.project);
    runId = randomUUID();
    state.busy = true;
    state.task = { ...task, status: "starting", canResume: false };
    send({ ...record, type: "resume", runId, protectedRoot: app.getPath("userData"), connection, previous: task });
    broadcast();
    return true;
  });
  main("desktop:history", (id) => loadHistory(sessionId.parse(id)));
  main("desktop:delete-history", (id) => deleteSelectedHistory(sessionId.parse(id)));
  main("desktop:more-history", () => { refreshHistory(true); broadcast(); });
  main("desktop:read-change", (value) => {
    const id = z.string().min(1).max(128).parse(value);
    const task = state.task;
    if (!task?.changes.some((change) => change.id === id)) return null;
    const read = (event: InspectionEvent) => event.type === "change-diff" ? event.inspection : null;
    const codexChange = id.startsWith("codex:");
    if (DESKTOP_FIXTURE_ALLOWED && task.id && projectRoot &&
        (codexChange || (!task.cliContinuation && task.execution?.executionMode === "provider_cli" && !task.readOnly))) {
      const project = projectRoot;
      const scope = currentHistoryScope();
      if (!scope) return null;
      let directory: string;
      let provider: NativeFixtureProvider = "openai";
      if (task.cliContinuation) {
        directory = apiCliDirectory(scope.home, task.id);
        const saved = readNativeCheckpoint(directory, task.id, project.path, "openai");
        if (saved?.mode !== "agent" || saved.apiSource?.segmentId !== task.cliContinuation.segmentId) return null;
      } else if (codexChange) {
        const source = continuationSource(task.id, scope);
        if (source?.saved.mode !== "agent" || source.saved.continuation?.segmentId !== task.continuation?.segmentId) return null;
        directory = source.directory;
      } else {
        const source = nativeHistoryRecord(task.id);
        if (source?.saved.mode !== "agent") return null;
        directory = nativeSessionDirectory(source.storage, task.id);
        provider = source.saved.provider;
      }
      return requestInspection({ type: "read-native-change", requestId: randomUUID(), taskId: task.id, project,
        recordId: id.replace(/^codex:/, ""), directory, provider }, (event) =>
        state.task === task && projectRoot === project && currentHistoryScope()?.home === scope.home ? read(event) : null);
    }
    return readSelectedRecord({ type: "read-change", recordId: id }, read);
  });
  main("desktop:read-command", (value) => {
    const id = z.string().regex(/^command-\d{1,8}$/).parse(value);
    return state.task?.checks.some((check) => check.id === id)
      ? readSelectedRecord({ type: "read-command", recordId: id }, (event) => event.type === "command-detail" ? event.inspection : null) : null;
  });
  main("desktop:check-recovery", (id) => checkSelectedRecovery(sessionId.parse(id)));
  main("desktop:undo-change", (id) => undoSelectedChange(z.string().min(1).max(128).parse(id)));
  main("desktop:export-diagnostics", exportDiagnostics);
  main("desktop:copy-diagnostics", copyDiagnostics);
  main("desktop:code-notifications", (value) => setCodeNotifications(z.boolean().parse(value)));
  main("desktop:web", (destination) => shell.openExternal(webOrigin + webPaths[webDestination.parse(destination)]));
  main("desktop:account-settings", accountSettings);
  main("desktop:check-update", update.check);
  main("desktop:install-update", update.install);
  main("desktop:sign-in", () => signIn());
  main("desktop:sign-out", signOut);
  main("desktop:connect-copied-code-key", connectCopiedCodeKey);
  main("desktop:cancel-sign-in", () => loginAttempt?.abort());
  main("desktop:plugin-inventory", () => {
    if (!state.capabilities?.plugins) return { enabled: false, servers: [], connections: [] };
    return withChatAccount((api) => api.pluginInventory());
  });
  main("chat:history", (value) => {
    const product = desktopTextProduct.default("chat").parse(value);
    return withChatAccount((api) => api.history(product));
  });
  main("chat:search", (value) => {
    const { query, product } = chatHistorySearchInput.parse(value);
    return withChatAccount((api) => api.search(query, product));
  });
  main("chat:conversation", (value) => {
    const page = chatPageInput.parse(value);
    return withChatAccount((api) => api.conversation(page));
  });
  main("chat:imported-source", (value) => {
    const input = chatSourceInput.parse(value);
    return withChatAccount((api) => api.importedSource(input));
  });
  main("chat:rename", (value) => {
    const input = chatRenameInput.parse(value);
    return withChatAccount((api) => api.rename(input), "chat");
  });
  main("chat:remove", (value) => removeChat(chatId.parse(value)));
  main("chat:models", () => withChatAccount((api) => api.models()));
  main("chat:copy-text", (value) => clipboard.writeText(z.string().min(1).max(1_000_000).parse(value)));
  main("chat:export", (value) => {
    const input = z.object({ id: chatId, title: z.string().max(500), includeSource: z.boolean() }).strict().parse(value);
    const request = connectedSettingsApi();
    return saveGeneratedFile(async () => ({
      bytes: await request.exportConversation(input.id, input.includeSource),
      suggestedName: sanitizeFileName(input.title) + ".txt",
      extension: "txt",
    }), nativeCopy().saveGenerated, "TXT");
  });
  main("chat:send", (value) => sendChat(chatTurnInput.parse(value)));
  main("chat:stop", () => chatTurn?.abort());
  main("chat:research-status", (value) => {
    if (!state.capabilities?.deepResearch) throw new Error("Deep Research is unavailable.");
    return withChatAccount((api) => api.checkDeepResearch(chatId.parse(value)));
  });
  main("review:send", (value) => sendReview(reviewTurnInput.parse(value)));
  main("review:analysis-setup", (value) => {
    if (!state.capabilities?.reviewAnalysis) throw new Error("Review analysis is unavailable.");
    return withChatAccount((api) => api.prepareReviewAnalysis(chatId.parse(value)), "review");
  });
  main("review:analysis-run", (value) => {
    if (!state.capabilities?.reviewAnalysis) throw new Error("Review analysis is unavailable.");
    return withChatAccount((api) => api.runReviewAnalysis(reviewAnalysisRequest.parse(value)), "review");
  });
  main("attachment:drive", (value) => importDriveAttachments(driveImportInput.parse(value)));
  main("attachment:upload", (value) => uploadAttachment(attachmentBytesInput.parse(value)));
  main("attachment:cancel", (value) => {
    if (attachmentTransfer?.requestId === z.uuid().parse(value)) attachmentTransfer.controller.abort();
  });
  main("attachment:discard", (value) => {
    const id = chatId.parse(value);
    if (!attachmentReceipts.has(id)) return;
    return withChatAccount(async (api) => {
      await api.discardAttachment(id);
      attachmentReceipts.delete(id);
    }, "attachments");
  });
  main("image:conversations", () => withChatAccount((api) => api.imageConversations()));
  main("image:history", (value) => withChatAccount((api) => api.imageHistory(chatId.parse(value))));
  main("image:group", (value) => withChatAccount((api) => api.imageGroup(chatId.parse(value))));
  main("image:generate", async (value) => {
    const input = imageRequest.parse(value);
    const owner = browserSession;
    const capability = state.capabilities?.images;
    const models = capability?.models.filter(({ id }) => input.models.includes(id)) ?? [];
    if (!capability || input.models.length > capability.maxModels || models.length !== input.models.length ||
        models.some(({ prices }) => !prices.some(({ size, quality }) => size === input.size && quality === input.quality))) {
      throw new Error("Tomverse could not confirm the quoted image models and prices.");
    }
    if (models.some(({ id, pricingVersion }) => input.pricing[id] !== pricingVersion)) {
      return { status: "price-changed" as const };
    }
    const result = await withChatAccount((api) => api.generateImages(input), "images");
    if (result.status === "price-changed" && owner && browserSession === owner) {
      await refreshDesktopCapabilities(owner, { keepCurrentOnFailure: true });
    }
    return result;
  });
  main("image:preview", (value) => withChatAccount((api) => api.imageBytes(chatId.parse(value), true)));
  main("image:save", (value) => {
    const input = z.object({ id: chatId, modelId: z.string().min(1).max(120) }).strict().parse(value);
    return saveImage(input.id, input.modelId);
  });
  main("artifact:save", (value) => saveArtifact(saveArtifactInput.parse(value)));
  ipcMain.handle("approval:read", (event) => {
    trusted(event, approvalWindow, approvalUrl);
    return pending ? { ...pending, language: state.language ?? "en" } : null;
  });
  ipcMain.handle("approval:decide", (event, value: unknown) => {
    trusted(event, approvalWindow, approvalUrl);
    return answer(decisions.parse(value));
  });
}

function fitWindowBounds(saved: Electron.Rectangle, workArea: Electron.Rectangle): Electron.Rectangle {
  const width = Math.min(Math.max(saved.width, 630), workArea.width);
  const height = Math.min(Math.max(saved.height, 450), workArea.height);
  return {
    x: Math.max(workArea.x, Math.min(saved.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(saved.y, workArea.y + workArea.height - height)),
    width, height,
  };
}

function createMainWindow() {
  const primary = screen.getPrimaryDisplay().workArea;
  let saved: Electron.Rectangle | undefined;
  try { saved = windowBounds.parse(JSON.parse(readFileSync(windowBoundsPath(), "utf8"))); }
  catch { /* The first launch and an unreadable preference both use the primary display. */ }
  const workArea = saved ? screen.getDisplayMatching(saved).workArea : primary;
  const window = newWindow({
    ...(saved ? fitWindowBounds(saved, workArea) : { width: Math.min(1440, workArea.width), height: Math.min(960, workArea.height) }),
    minWidth: Math.min(630, workArea.width), minHeight: Math.min(450, workArea.height),
  });
  mainWindow = window;
  window.on("focus", () => void checkBrowserSession());
  function keepWindowOnDisplay() {
    if (window.isDestroyed() || window.isMaximized() || window.isMinimized() || window.isFullScreen()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    window.setMinimumSize(Math.min(630, area.width), Math.min(450, area.height));
    const visible = fitWindowBounds(bounds, area);
    if (bounds.x !== visible.x || bounds.y !== visible.y || bounds.width !== visible.width || bounds.height !== visible.height) {
      window.setBounds(visible);
    }
  }
  screen.on("display-removed", keepWindowOnDisplay);
  screen.on("display-metrics-changed", keepWindowOnDisplay);
  window.on("restore", keepWindowOnDisplay);
  let recovering = false;
  async function recoverWorkspace(replaceWindow: boolean) {
    if (window.isDestroyed() || recovering || closing) return;
    recovering = true;
    const copy = nativeCopy();
    const { response } = await dialog.showMessageBox({
      type: "error", title: "Tomverse Desktop", message: copy.workspaceFailed,
      buttons: [copy.retry, copy.quit], defaultId: 0, cancelId: 1,
    });
    recovering = false;
    if (window.isDestroyed() || closing) return;
    if (response !== 0) {
      app.quit();
      return;
    }
    if (replaceWindow) {
      createMainWindow();
      window.destroy();
    } else loadWorkspace();
  }
  function loadWorkspace() {
    void window.loadURL(shellUrl).then(() => {
      if (!window.isDestroyed()) window.show();
    }, () => recoverWorkspace(false));
  }
  window.webContents.on("render-process-gone", () => {
    closeCodeBrowser();
    stopDictation();
    stop();
    void recoverWorkspace(true);
  });
  window.on("close", (event) => {
    if (state.busy || pendingMutation) {
      event.preventDefault();
      requestQuit();
      return;
    }
    try { writeFileAtomic(windowBoundsPath(), JSON.stringify(window.getNormalBounds())); }
    catch { /* A preference write must not prevent closing the app. */ }
  });
  window.once("closed", () => {
    screen.off("display-removed", keepWindowOnDisplay);
    screen.off("display-metrics-changed", keepWindowOnDisplay);
    if (mainWindow === window) {

      closeCodeBrowser();
      stopDictation();
      chatTurn?.abort();
      mainWindow = null;
    }
  });
  loadWorkspace();
}

function createLoginWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const window = newWindow({
    width: Math.min(470, area.width), height: Math.min(504, area.height),
    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    transparent: true, backgroundColor: "#00000000", hasShadow: false, thickFrame: false,
  });
  loginWindow = window;
  window.once("closed", () => {
    if (loginWindow !== window) return;
    loginWindow = null;
    loginAttempt?.abort();
    app.quit();
  });
  void window.loadURL(loginUrl).then(() => {
    if (!window.isDestroyed()) window.show();
  }, () => { if (!window.isDestroyed()) window.close(); });
}

function syncAccountWindow() {
  if (closing || suspended) return;
  if (state.account.stage === "connected") {
    const existing = mainWindow;
    if (!existing) createMainWindow();
    const previous = loginWindow;
    loginWindow = null;
    if (previous && !previous.isDestroyed()) {
      if (existing && !existing.isDestroyed()) existing.show();
      previous.close();
    }
  } else {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
    if (!loginWindow && !signingOut && !invalidatingSession) createLoginWindow();
    if (loginWindow && !state.busy && !pendingMutation && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  }
}

function blockedPackagedSwitch(option: string) {
  if (!app.commandLine.hasSwitch(option)) return false;
  const localInspector = (option === "inspect" || option === "remote-debugging-port") && app.commandLine.getSwitchValue(option) === "0";
  return !packagedTaskQa || !localInspector;
}

if (app.isPackaged && ((packagedTaskQa && !cliRunFixture) || unsafeSwitches.some(blockedPackagedSwitch))) app.exit(64);
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const window = loginWindow ?? mainWindow;
    if (!window || window.isDestroyed()) return;
    window.restore();
    window.focus();
  });
  app.on("before-quit", (event) => {
    if (state.busy || pendingMutation) {
      event.preventDefault();
      requestQuit();
    }
  });
  app.on("will-quit", () => {
    for (const close of cliPathWatches.values()) close();
    cliPathWatches.clear();
    cliInspection?.controller.abort();
    loginAttempt?.abort();
    linkAttempt?.abort();
    renewal?.controller.abort();
    browserSession = null;
    linkedCode = null;
    clearTimeout(sessionExpiry);
    clearTimeout(quitTimer);
    const child = worker;
    worker = null;
    child?.kill();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => {
    if (!accountWindowsReady || mainWindow || loginWindow) return;
    if (DESKTOP_LOGIN_WINDOW_REQUIRED) syncAccountWindow();
    else createMainWindow();
  });
  void app.whenReady().then(async () => {
    protocol.handle("tomverse", async (request) => {
      const address = new URL(request.url);
      if (request.method !== "GET" || address.host !== "desktop" || address.search) return new Response(null, { status: 404 });
      const route = address.pathname;
      const isPage = route === "/" || route === "/approval" || route === "/login";
      if (!isPage && !/^\/assets\/[A-Za-z0-9_.-]+$/.test(route)) return new Response(null, { status: 404 });
      const mime = isPage ? "text/html; charset=utf-8" : assetTypes[extname(route)];
      if (!mime) return new Response(null, { status: 404 });
      try {
        const bytes = await readFile(join(__dirname, "..", "renderer", isPage ? "index.html" : route.slice(1)));
        return new Response(new Uint8Array(bytes), { headers: {
          "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
          ...(isPage ? { "Content-Security-Policy": contentPolicy, "X-Frame-Options": "DENY" } : {}),
        } });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === "geolocation" || permission === "geolocation-approximate") {
        const allow = details.isMainFrame && mayRequestChatLocation(contents);
        if (allow) geolocationGrant = undefined;
        callback(allow);
        return;
      }
      const audioOnly = "mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio";
      const allow = permission === "media" && details.isMainFrame && audioOnly && mayRequestDictation(contents);
      if (allow && dictation) dictation.mediaGranted = true;
      callback(allow);
    });
    session.defaultSession.on("will-download", (event) => event.preventDefault());
    loadLanguage();
    loadCodeExecutionPreference();
    loadCliPaths();
    loadCodeNotifications();
    powerMonitor.on("suspend", () => {
      cliInspection?.controller.abort();
      suspended = true;
      geolocationGrant = undefined;
      stopDictation(true);
      stop();
    });
    powerMonitor.on("resume", () => {
      suspended = false;
      if (!closing) void checkBrowserSession();
    });
    registerIpc();
    bootWorker();
    if (DESKTOP_LOGIN_WINDOW_REQUIRED) await restoreBrowserSession();
    accountWindowsReady = true;
    if (DESKTOP_LOGIN_WINDOW_REQUIRED) syncAccountWindow();
    else {
      void restoreBrowserSession();
      createMainWindow();
    }
  });
}
