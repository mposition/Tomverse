import { z } from "zod";
import type { ComparisonReview, ReviewSetup } from "../../../packages/chat-core/src/review";
import type { CodeSandboxInput, CodeSandboxView } from "./code-sandbox-contract";
import type { AccountSettingsAction, AccountSettingsResult, DesktopAccountSettingsInput } from "./account-settings-contract";
import type { DesktopAccountDataInput, DesktopAccountDataResult } from "./account-data-contract";
import type { AssistantImportAction, AssistantImportInput, AssistantImportResult } from "./assistant-import-contract";
import type {
  ChatConversation, ChatHistoryHit, ChatHistoryRow, ChatImportedSource, ChatModel, ChatPageInput, ChatRenameInput, ChatSourceInput, ChatStarter,
  ChatTurnInput, ChatTurnProgress, ChatTurnResult, ChatUnlockImportedInput, ChatUnlockImportedResult, DesktopTextProduct, ReviewAnalysisRequest, ReviewCapability, ReviewTurnInput, ReviewTurnProgress, ReviewTurnResult, SaveArtifactInput,
} from "./chat-contract";
import type { ImageBytes, ImageCapability, ImageGenerationResult, ImageGroup, ImageHistory, ImageRequest } from "./images-contract";
import type { PullEvidence, taskPullCommand } from "./github-pr-contract";
import type { GitApprovalView, GitCommand, GitResultMap } from "./git-actions-contract";
import type { DictationClip, DictationReply } from "./dictation-contract";
import type { BrowserCommand, BrowserState, ElementPick } from "./browser-contract";
import type { ComputerCommand, ComputerResult, ComputerState } from "./computer-contract";
import type { TerminalCommand, TerminalEvent, TerminalInfo, TerminalListing, TerminalReplayResult } from "./terminal-contract";
import type { WebViewCommand, WebViewState } from "./web-view-contract";
import type { ChatExtrasAction, ChatExtrasInput, ChatExtrasOutput, ReviewExportInput } from "./chat-extras-contract";
import type { DesktopPluginInventory } from "./plugin-contract";
import type { ConnectorInput, ConnectorInventory, ConnectorResult } from "./connector-contract";
import type { LocalExtensionsCommand, LocalExtensionsView } from "./local-extensions-contract";
import type { PluginsCommand, PluginsView } from "./plugins-contract";
import type { AttachmentBytesInput, AttachmentUpload } from "./attachment-contract";
import type { BillingAction, BillingResult, BillingState, DesktopBillingInput } from "./billing-contract";
import type { DesktopManagedCodeInput, ManagedCodeView } from "./managed-code-contract";
import type { DesktopProjectAction, DesktopProjectInput, DesktopProjectOutcome } from "./project-contract";
import type { DesktopResearchAction, DesktopResearchInput, DesktopResearchOutcome } from "./research-contract";
import type { ReviewAction, ReviewInput, ReviewOutcome } from "./review-contract";
import type { WorkspaceReference } from "../../tomverse-cli/src/runtime";
import type { TaskPlan, TaskPlanEvidence } from "../../tomverse-cli/src/task-plan";
import type { ApiQuotaReason } from "../../tomverse-cli/src/quota-refusal";
import type { CodeOrchestration } from "./orchestrate-contract";
import type { Language } from "../../../lib/language";
import type { desktopNativeCopy } from "../../../locales/desktopNative";
import { codeExecutionMode, type CliAccount, type CliPathCheck, type CliPaths, type CliProtocolCheck, type CliProvider,
  type CodeExecutionMode, type claudeFixtureExecution, type codexFixtureExecution, type kimiFixtureExecution, type qwenFixtureExecution, type vibeFixtureExecution, type deepSeekFixtureExecution, type zCodeFixtureExecution, type miniMaxFixtureExecution, type grokFixtureExecution, type antigravityFixtureExecution,
  type tomverseApiExecution } from "./code-execution";
import type { CodeCliContinuation, CodeContinuation, CodeFallbackCliModels, CodeFallbackSettings, CodeFallbackUpdate } from "./code-fallback";
import type { PermissionCommand, PermissionResult, PermissionsView } from "./permission-contract";
import type { LaneKind, ParallelCommand, ParallelView, ScheduleCommand, ScheduleResult, ScheduleView } from "./parallel-contract";

type DesktopDetail = keyof typeof desktopNativeCopy.en;

export const MAX_CODE_REFERENCES = 10;
export const MAX_CODE_PROMPT_CHARACTERS = 24_000;
export const MAX_HANDOFF_EXCERPT_CHARACTERS = 2_400;
export const codeReferenceKind = z.enum(["file", "folder"]);
export const codeReferencePath = z.string().min(1).max(2048);
export const codePermissionProfile = z.enum(["manual", "accept_edits"]);
export type CodePermissionProfile = z.infer<typeof codePermissionProfile>;
export const codeWorktreeCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const codeWorktreeBase = z.object({ ref: z.string().min(1).max(512), commit: codeWorktreeCommit }).strict();
export const codeWorktreeChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("worktree"), id: z.uuid(), base: codeWorktreeBase }).strict(),
]);
export type CodeWorktreeChoice = z.infer<typeof codeWorktreeChoice>;
export type CodeWorktreeBase = z.infer<typeof codeWorktreeBase>;
export type CodeWorktree = {
  path: string;
  branch: string;
  base: CodeWorktreeBase;
  unavailable?: true;
};
export type CodeGitWorkspace = { kind: "unavailable" } | {
  kind: "git"; id: string; path: string; branch: string; bases: CodeWorktreeBase[];
};
/** "default", or a reasoning level id the coding API's model catalog names for the model (low, high, and any it adds). */
export const codeEffort = z.string().regex(/^(?:default|[a-z][a-z0-9_-]{0,23})$/);
export const codeLimitProfile = z.enum(["standard", "extended", "unlimited"]);
export type CodeLimitProfile = z.infer<typeof codeLimitProfile>;
export const startInput = z.object({
  pluginConnectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  workspace: codeWorktreeChoice.optional(),
  prompt: z.string().trim().max(MAX_CODE_PROMPT_CHARACTERS),
  mode: z.enum(["ask", "agent", "plan"]),
  model: z.string().min(1).max(240),
  effort: codeEffort,
  executionMode: codeExecutionMode.optional(),
  limits: codeLimitProfile.optional(),
  goal: z.boolean().optional(),
  /** Subagent orchestration for this task (parallel subtasks with write scopes and verification). Off unless the person turned it on. */
  orchestrate: z.boolean().optional(),
  permissionProfile: codePermissionProfile.optional(),
  saveHistory: z.boolean().optional(),
  handoffId: z.uuid().optional(),
  referenceIds: z.array(z.uuid()).max(MAX_CODE_REFERENCES).refine((items) => new Set(items).size === items.length).optional(),
}).strict().refine((input) => input.prompt.length > 0 || Boolean(input.handoffId));

export const sessionId = z.string().regex(/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/);
const nativeId = z.string().regex(/^[\w.:-]{1,160}$/);
const nativeTurn = z.object({ threadId: nativeId, turnId: nativeId }).strict();
export const codeNativeReportedModel = z.object({
  model: nativeId,
  source: z.enum(["codex_reroute", "claude_assistant"]),
  previousModel: nativeId.optional(),
}).strict();
const followUpTarget = z.union([sessionId, nativeTurn]);
export const followUpInput = z.object({ id: followUpTarget, text: z.string().trim().min(1).max(MAX_CODE_PROMPT_CHARACTERS) }).strict();
export type FollowUpTarget = z.infer<typeof followUpTarget>;
const handoffExcerpt = z.string().trim().min(1).max(MAX_HANDOFF_EXCERPT_CHARACTERS);
export const workspaceHandoffInput = z.discriminatedUnion("target", [
  z.object({ target: z.literal("code"), excerpt: handoffExcerpt }).strict(),
  z.object({ target: z.literal("chat"), excerpt: handoffExcerpt, sourceTaskId: sessionId }).strict(),
]);
const queueItemId = z.string().regex(/^q-[0-9a-f]{8}$/);
const queueText = z.string().trim().min(1).max(MAX_CODE_PROMPT_CHARACTERS);
/** What the person can do with the messages held for after the current turn. */
export const queueOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), text: queueText }).strict(),
  z.object({ kind: z.literal("edit"), itemId: queueItemId, text: queueText }).strict(),
  z.object({ kind: z.literal("remove"), itemId: queueItemId }).strict(),
  z.object({ kind: z.literal("move"), itemId: queueItemId, direction: z.union([z.literal(-1), z.literal(1)]) }).strict(),
]);
export const queueInput = z.object({ id: z.string().regex(/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/), operation: queueOperation }).strict();
export type QueueOperation = z.infer<typeof queueOperation>;
const backgroundHandle = z.string().regex(/^bg-[0-9a-f]{6}$/);
export const backgroundInput = z.object({ id: z.string().regex(/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/), handle: backgroundHandle }).strict();
export const codeMemoryInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z.object({ action: z.literal("remove"), id: z.string().regex(/^m-[0-9a-f]{8}$/) }).strict(),
  z.object({ action: z.literal("set-enabled"), enabled: z.boolean() }).strict(),
]);
export type CodeMemoryInput = z.infer<typeof codeMemoryInput>;
/** Skills, commands and agent definitions of the open project and the user's own folders, and the import from Claude Code / Codex. */
export const codeExtensionsInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("import-preview") }).strict(),
  z.object({ action: z.literal("import-apply"), ids: z.array(z.string().regex(/^i-[0-9a-f]{12}$/)).min(1).max(50) }).strict(),
]);
export type CodeExtensionsInput = z.infer<typeof codeExtensionsInput>;
export type CodeExtensionsImportItem = {
  id: string; kind: "instructions" | "skill" | "command" | "agent" | "mcp"; tool: "claude" | "codex" | "agents"; name: string; source: string;
  scope: "project" | "user"; status: "in-use" | "importable" | "imported" | "conflict" | "unsupported"; detail?: string;
  /** MCP servers: the kind of server and what it runs, with every secret-looking value hidden. */
  mcp?: { transport: "stdio" | "http"; summary: string; values: Array<{ key: string; value: string }> };
};
export type CodeExtensionsView = {
  project: boolean;
  skills: Array<{ name: string; description: string; source: string; scope: "project" | "user"; implicit: boolean; ignored: string[] }>;
  commands: Array<{ name: string; description: string; argumentHint?: string; source: string; scope: "project" | "user"; ignored: string[] }>;
  agents: Array<{ name: string; description: string; source: string; scope: "project" | "user"; base: "explore" | "worker"; model?: string; ignored: string[] }>;
  /** What the composer's / list offers besides the built-in commands. */
  slash: Array<{ name: string; kind: "skill" | "command"; description: string; argumentHint?: string }>;
  issues: string[];
  importItems?: CodeExtensionsImportItem[];
  imported?: { written: string[]; skipped: number };
};
/** The agent's notes about the open project, and whether Code keeps notes at all. */
export type CodeMemoryView = { enabled: boolean; project: boolean; entries: Array<{ id: string; text: string; at: string }> };
export const decisions = z.object({
  id: z.uuid(),
  action: z.enum(["once", "run", "deny"]),
}).strict();
export type StartInput = z.infer<typeof startInput>;
export type WorkspaceHandoffInput = z.infer<typeof workspaceHandoffInput>;
export type WorkspaceHandoff = { id: string; target: WorkspaceHandoffInput["target"]; excerpt: string; project: string };
export type Decision = z.infer<typeof decisions>;
export type Model = { id: string; name: string; provider: string; efforts: string[] };
export type RunStatus = "starting" | "running" | "approval" | "stopping" | "completed" | "clarification" | "blocked" | "stopped" | "unknown" | "failed";
export type CodeEventEntry = { role: "event"; text: string; notice?: DesktopDetail };
/** turn: the position of a user message among the turns of a saved task, for rewinding and forking there. */
export type Entry = { role: "user" | "assistant"; text: string; turn?: number } | { role: "plan" } | CodeEventEntry;
export const kimiNativeSessionId = z.string().regex(/^session_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
export const zCodeNativeSessionId = z.string().regex(/^sess_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
export const miniMaxNativeSessionId = z.string().regex(/^mvs_[a-f\d]{32}$/);
export const codeNativeAssignment = nativeTurn.extend({
  model: nativeId, provider: z.enum(["anthropic", "qwen", "moonshot", "mistral", "deepseek", "zhipu", "minimax", "xai", "google"]).optional(), reportedModel: codeNativeReportedModel.optional(),
});
export type CodeNativeAssignment = z.infer<typeof codeNativeAssignment>;
export type CodeApiModelObservation = {
  reportedModel?: { model: string; source: "api_header" | "api_receipt" };
  appliedEffort?: StartInput["effort"];
};
export type CodeTaskPlan = Pick<TaskPlan, "activeId" | "analysis"> & {
  proposalOnly?: true;
  items: Array<Omit<TaskPlan["items"][number], "evidence"> & {
    segmentId?: string;
    nativeAssignment?: CodeNativeAssignment;
    apiAssignment?: CodeApiModelObservation & { assignment: NonNullable<TaskPlanEvidence["assignment"]> };
    nativeStatus?: "pending" | "in_progress" | "completed";
    completionUnverified?: boolean;
    evidence: Array<Omit<TaskPlanEvidence, "callId" | "assignment"> & CodeApiModelObservation & {
      assignment?: TaskPlanEvidence["assignment"] | CodeNativeAssignment;
      nativeItemId?: string;
      nativeCallId?: string;
      nativeReadBinding?: string;
    }>;
  }>;
};
export function asProposedCodePlan(plan: CodeTaskPlan): CodeTaskPlan {
  return { ...plan, proposalOnly: true, activeId: null, items: plan.items.map((row) => ({
    ...row, complete: false, completionUnverified: false,
  })) };
}
export type Change = { id: string; path: string; kind: string; current: string };
export type ChangeInspection = { text: string | null; current: string; canUndo: boolean };
export type CompactHistoryResult = "compacted" | "nothing" | "failed" | "unavailable";
export type CodeRewindMode = "both" | "files" | "conversation";
/** What a rewind to a turn would do, for the confirmation: the files newest first, the commands that cannot be undone, and what can be chosen. */
export type CodeRewindPlan = {
  text: string; files: Array<{ path: string; kind: string; outcome: "will_undo" | "conflict"; reason?: string }>;
  commands: string[]; conversationAvailable: boolean; blocked?: true;
};
export type RewindTurnResult = { result: "rewound" | "cancelled" | "unavailable" | "unconfirmed"; text?: string; undone?: number; conflicts?: number };
export const historyTurnInput = z.object({ id: sessionId, turn: z.int().min(0).max(100_000) }).strict();
export type ForkTurnResult = { result: "forked" | "cancelled" | "unavailable" | "unconfirmed" };
export type UndoChangeResult = "undone" | "cancelled" | "conflict" | "unavailable" | "unconfirmed";
export type DeleteHistoryResult = "deleted" | "cancelled" | "locked" | "unavailable" | "unconfirmed";
export type CodeNativeRecoverySummary = { turn: "running" | "completed" | "stopped" | "failed" | "unconfirmed"; passed: number; failed: number; unconfirmed: number };
export type RecoveryResult = { status: "checked"; notes: string[]; native?: CodeNativeRecoverySummary } | { status: "locked" | "unavailable" };
export type Verification = { id: string; tool: string; state: string; exitCode?: number };
export const zCodeExtraUsageUnavailableCode = z.enum(["1316", "1317", "1318", "1319", "1320", "1321"]);
export const zCodePlanQuotaCode = z.enum(["1308", "1310", ...zCodeExtraUsageUnavailableCode.options]);
export const codeNativeQuota = z.discriminatedUnion("source", [
  nativeTurn.extend({ source: z.literal("codex"), reason: z.literal("usageLimitExceeded") }),
  nativeTurn.extend({ source: z.literal("claude_code"), reason: z.literal("credits_required"), threadId: z.uuid(), turnId: z.uuid(), eventId: z.uuid() }),
  nativeTurn.extend({ source: z.literal("grok_build"), reason: z.literal("grokFreeUsageExhausted"),
    threadId: z.uuid(), turnId: z.uuid(), promptId: z.uuid() }),
  nativeTurn.extend({ source: z.literal("qwen_code"), reason: z.literal("qwenSubscriptionUsageExhausted"),
    threadId: z.uuid(), turnId: z.uuid(), requestId: z.string().regex(/^[\w.-]{1,128}$/).optional(),
    resetAt: z.iso.datetime().optional() }),
  nativeTurn.extend({ source: z.literal("zcode"), reason: z.literal("zCodePlanUsageExhausted"),
    threadId: zCodeNativeSessionId, turnId: z.uuid(), eventId: z.uuid(), providerCode: zCodePlanQuotaCode }),
]);
export type CodeQuotaEvidence =
  | { source: "tomverse_api"; reason: ApiQuotaReason; requestId: string; resetAt?: string }
  | z.infer<typeof codeNativeQuota>;
const tokenCount = z.int().nonnegative();
export const acpUsageSources = { google: "antigravity_turn", mistral: "vibe_session", minimax: "minimax_turn", xai: "grok_turn" } as const;
export const MAX_QWEN_USAGE_REQUESTS = 128;
const qwenTokenCount = tokenCount.max(2_147_483_647);
export const qwenRequestUsage = z.object({ executionId: z.uuid(), inputTokens: qwenTokenCount, outputTokens: qwenTokenCount });
export const codeNativeUsage = z.discriminatedUnion("source", [
  z.object({ source: z.literal("codex_thread"), totalTokens: tokenCount }),
  z.object({ source: z.literal("claude_turn"), inputTokens: tokenCount, outputTokens: tokenCount,
    cacheReadTokens: tokenCount.optional(), cacheWriteTokens: tokenCount.optional() }),
  z.object({ source: z.enum(Object.values(acpUsageSources)), inputTokens: tokenCount, outputTokens: tokenCount }),
  z.object({ source: z.literal("zcode_turn"), nativeTurnId: nativeId, eventId: z.uuid(), reportedRequests: z.int().positive(),
    inputTokens: tokenCount, outputTokens: tokenCount }),
  z.object({ source: z.literal("qwen_requests"), requestCount: z.int().min(1).max(MAX_QWEN_USAGE_REQUESTS),
    requests: z.array(qwenRequestUsage).min(1).max(MAX_QWEN_USAGE_REQUESTS),
  }).refine(({ requests, requestCount }) => requests.length <= requestCount &&
    new Set(requests.map(({ executionId }) => executionId)).size === requests.length),
]);
export type CodeNativeUsage = z.infer<typeof codeNativeUsage>;
export const codeNativeRunEvidence = z.object({
  session: codeNativeAssignment,
  usage: codeNativeUsage.optional(),
  quota: codeNativeQuota.optional(),
});
export type CodeNativeRunEvidence = z.infer<typeof codeNativeRunEvidence>;
export const MAX_CODE_NATIVE_RUNS = 64;
export type CommandInspection = {
  command?: { file: string; args: string[]; cwd: string; envNames: string[]; timeoutMs: number; mode: "argv" | "shell" };
  stdout: string;
  stderr: string;
  error?: string;
  signal?: string;
  elapsedMs?: number;
  stdoutOmitted: number;
  stderrOmitted: number;
};
export type Transmission = {
  segmentId: string; requestId?: string; quota?: Extract<CodeQuotaEvidence, { source: "tomverse_api" }>;
  seq: number; purpose: string; state: string; model?: string; httpStatus?: number; appliedEffort?: StartInput["effort"];
  catalogProvider?: string;
  receipt: { status: "held" | "settled" | "released"; credits: number } | { status: "unknown" };
  receiptNotFound?: boolean;
  contents?: { model?: string; effort?: Exclude<StartInput["effort"], "default">;
    projectInstructions: boolean; projectInstructionsTruncated?: boolean; messageCount: number; toolResultCount: number;
    commandOutput?: { results: number; truncated: number };
    listedPathCount?: number; truncatedListingCount?: number;
    fileReads: Array<{ path: string; truncated: boolean }>; moreFileReads: number;
    webReads?: Array<{ url: string; truncated: boolean }>; moreWebReads?: number; imageCount?: number; projectMemory?: boolean };
};
/** A command the task keeps running in the background: what it is, whether it still runs, and the newest of what it printed. */
export type CodeBackgroundCommand = {
  handle: string; command: string; state: "running" | "exited" | "stopped"; exitCode?: number | null; startedAt: string; output: string;
};
/** A run the model handed to a subagent (explore or worker): what it was asked, and how it is going or ended. */
export type CodeSubagent = {
  id: string; kind: "explore" | "worker"; task: string; requests: number;
  state: "running" | "completed" | "failed" | "cancelled" | "limit" | "unknown"; summary?: string;
};
export type CodeGoalState = {
  maxContinuations: number; continuations: number;
  last?: { met: boolean; summary: string; next?: string };
};
export type CodeApiUsage = { requestCount: number; settled: number; held: number; unknown: number };
export type Task = {
  id: string | null;
  root: string;
  worktree?: CodeWorktree;
  title: string;
  status: RunStatus;
  entries: Entry[];
  streamingAnswer?: string;
  plan?: CodeTaskPlan;
  effort?: StartInput["effort"];
  actual?: StartInput["effort"];
  model?: string;
  execution?: typeof tomverseApiExecution | typeof codexFixtureExecution | typeof claudeFixtureExecution | typeof qwenFixtureExecution | typeof kimiFixtureExecution | typeof vibeFixtureExecution | typeof deepSeekFixtureExecution | typeof zCodeFixtureExecution | typeof miniMaxFixtureExecution | typeof grokFixtureExecution | typeof antigravityFixtureExecution;
  nativeSession?: CodeNativeAssignment;
  nativeRuns?: CodeNativeRunEvidence[];
  pendingNativeApproval?: { callId: string; turnId: string };
  continuation?: CodeContinuation & { source: CodeNativeAssignment; stage: "checking" | "unavailable" | "started" };
  cliContinuation?: CodeCliContinuation & { sourceModel?: string; stage: "checking" | "unavailable" | "started" };
  quota?: CodeQuotaEvidence;
  changes: Change[];
  checks: Verification[];
  transmission: Transmission[];
  apiUsage?: CodeApiUsage;
  canCheckRecovery?: boolean;
  canResume?: boolean;
  canResumeAfterQuota?: boolean;
  canAnswerClarification?: boolean;
  pendingFollowUp?: string;
  /** Messages held for after the model finishes, in the order they will run. */
  queued?: Array<{ id: string; text: string }>;
  /** Commands this task keeps running in the background; they end with the task. */
  background?: CodeBackgroundCommand[];
  /** The saved task can be taken back to the start of one of its turns, or forked. */
  canRewind?: true;
  /** Subagents the model started in this task, newest last. */
  subagents?: CodeSubagent[];
  /** Orchestration: the limits this task runs with and the subtasks of its delegate calls. Absent when it is off. */
  orchestration?: CodeOrchestration;
  /** The saved limit profile when it is not the standard one. */
  limits?: Exclude<CodeLimitProfile, "standard">;
  goal?: CodeGoalState;
  /** An estimate of the conversation the next request would carry, against the model's context window. */
  context?: { tokens: number; window: number };
  unreadable?: true;
  savedLocally?: boolean;
  readOnly?: boolean;
  references?: WorkspaceReference[];
};
export type CodeReference = WorkspaceReference & { id: string };

export type UpdateState = {
  stage: "unavailable" | "idle" | "checking" | "downloading" | "ready" | "installing" | "failed";
  detail?: DesktopDetail;
};
export type TaskSummary = { id: string; title: string; status: string; unreadable?: true };
export type AccountState = ({ stage: "unavailable" | "idle" | "waiting" | "restoring" | "signing-out" | "failed" | "expired" }
  | { stage: "connected"; label: string; storage: "device" | "session"; draftNamespace: string }) & { detail?: DesktopDetail };
export type CodeKeyState = ({ stage: "missing" | "checking" } | { stage: "connected"; prefix: string; storage: "device" | "session" }) & { detail?: DesktopDetail };

export type Snapshot = {
  codeGitWorkspace?: CodeGitWorkspace;
  codeBrowserAvailable?: boolean;
  /** Terminals: available when a project is open, enabled when the person turned them on. They belong to the open task. */
  codeTerminal?: { available: boolean; enabled: boolean };
  codeBrowserInspection?: boolean;
  /** The agent's browser tools (the browser_* tools) are on: the person's switch, or a test fixture that turned them on. */
  codeBrowserAgent?: boolean;
  deviceFixtureAvailable?: boolean;
  root: string | null;
  project: string | null;
  draftNamespace: string | null;
  handoff: WorkspaceHandoff | null;
  models: Model[];
  codeCatalog: "unavailable" | "loading" | "ready" | "failed";
  task: Task | null;
  history: TaskSummary[];
  moreHistory: boolean;
  busy: boolean;
  localFixture: boolean;
  version: string;
  language: Language | null;
  update: UpdateState;
  codeNotifications: { available: boolean; enabled: boolean };
  codeExecutionPreference: CodeExecutionMode;
  projectPermissionProfile?: CodePermissionProfile;
  /** The permission mode and the allow, ask and deny rules (permission-contract.ts). */
  permissions?: PermissionsView;
  codeFallback: { scope: string; settings: CodeFallbackSettings } | null;
  codeFallbackCliModels: CodeFallbackCliModels;
  cliPaths: CliPaths;
  supportedCliPaths: CliProvider[];
  cliAuthFixture: boolean;
  cliProtocolCheckAvailable: boolean;
  codexFixtureModel?: string;
  nativeFixtureEdits?: true;
  cliFixtureHistory?: true;
  claudeFixtureModel?: string;
  qwenFixtureModel?: string;
  vibeFixtureModel?: string;
  deepSeekFixtureModel?: string;
  zCodeFixtureModel?: string;
  miniMaxFixtureModel?: string;
  grokFixtureModel?: string;
  antigravityFixtureModel?: string;
  kimiFixtureModel?: string;
  account: AccountState;
  capabilities: {
    autoSelection: boolean; chatWrite: boolean; chatImport: boolean; chatStarters: ChatStarter[];
    googleDrive?: boolean; deepResearch?: boolean;
    reviewAnalysis?: boolean; composerTools?: boolean; searchReadiness?: { brave: boolean };
    review: ReviewCapability | null; images: ImageCapability | null; attachments: boolean; plugins?: boolean; codeMcp?: boolean;
    billing?: boolean; managedCode?: boolean;
  } | null;
  codeKey: CodeKeyState;
  /** Tasks that run next to the open one: the activity list and the full view of the tasks the window observes. */
  parallel?: ParallelView;
  /** Scheduled runs: the schedules, their run records and what the schedule form needs to know. */
  schedules?: ScheduleView;
};

export type ApprovalRequest = {
  /** Which task asked, when it is not the open one: set by the main process, never by the task. */
  task?: { title: string; folder: string; kind: LaneKind };
  language?: Language;
  id: string;
  root: string;
  tool: string;
  explanation?: string;
  canRemember: boolean;
  command?: { mode: string; file: string; args: string[]; cwd: string; display: string; env: string[]; timeoutMs: number; background?: boolean };
  /** A public web page the task asks to read: the address, and the site the approval is for. */
  web?: { url: string; host: string };
  /** A click or typing in the local browser tab: the site, the page, the element and the text the agent would type. */
  browser?: { action: "click" | "type"; origin: string; url: string; selector: string; text?: string; clear?: boolean; submit?: boolean };
  /** A click, typing, key or scroll in the one desktop window the person chose for the task. */
  computer?: { action: "click" | "type" | "key" | "scroll"; window: { title: string; app: string }; x?: number; y?: number; button?: "left" | "right"; double?: boolean;
    text?: string; key?: string; dx?: number; dy?: number };
  /** A call of a tool of an MCP server on this computer: which server and tool, where the server is defined, and the arguments. */
  mcp?: { server: string; tool: string; scope: "user" | "project"; args: string };
  files?: Array<{ path: string; action: string; eol: string; bom: boolean; preimage: string | null; postimage: string | null; before: string | null; after: string | null }>;
  /** The subagent or subtask this request is for: a worker's change or command, asked one at a time. */
  origin?: { id: string; title: string };
  /** A commit or push the main process asks the person to approve: built from the repository, answered only in the approval window. */
  git?: GitApprovalView;
};

export type DesktopApi = {
  armChatLocation: () => Promise<boolean>;
  armDictation: () => Promise<string | null>;
  cancelDictation: (id: string) => Promise<void>;
  transcribeDictation: (input: DictationClip) => Promise<DictationReply>;
  subscribeDictationStop: (listener: () => void) => () => void;
  taskPulls: (command: z.infer<typeof taskPullCommand>) => Promise<PullEvidence[]>;
  git<Type extends GitCommand["type"]>(command: Extract<GitCommand, { type: Type }>): Promise<GitResultMap[Type]>;
  codeBrowser: (command: BrowserCommand) => Promise<boolean | void>;
  codeComputer: (command: ComputerCommand) => Promise<ComputerResult>;
  subscribeCodeComputer: (listener: (state: ComputerState) => void) => () => void;
  subscribeCodeBrowser: (listener: (state: BrowserState) => void) => () => void;
  subscribeCodeBrowserPick: (listener: (pick: ElementPick) => void) => () => void;
  codeTerminal: (command: TerminalCommand) => Promise<TerminalListing | TerminalInfo | TerminalReplayResult | void>;
  subscribeCodeTerminal: (listener: (event: TerminalEvent) => void) => () => void;
  webView: (command: WebViewCommand) => Promise<void>;
  subscribeWebView: (listener: (state: WebViewState | null) => void) => () => void;
  state(): Promise<Snapshot>;
  setProjectPermissionProfile(profile: CodePermissionProfile): Promise<boolean>;
  permissions(command: PermissionCommand): Promise<PermissionResult>;
  setLanguage(language: Language): Promise<void>;
  setCodeExecutionPreference(mode: CodeExecutionMode): Promise<void>;
  updateCodeFallback(input: CodeFallbackUpdate): Promise<void>;
  chooseCliPath(provider?: CliProvider): Promise<string | null>;
  saveCliPath(input: { provider: CliProvider; path: string }): Promise<CliPathCheck>;
  removeCliPath(provider: CliProvider): Promise<void>;
  checkCliAccount(provider: CliProvider): Promise<CliAccount>;
  openCliAuthGuide(provider: CliProvider): Promise<void>;
  checkCliProtocol(provider: CliProvider): Promise<CliProtocolCheck>;
  cancelCliCheck(kind: "account" | "protocol"): Promise<void>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  chooseRoot(): Promise<boolean>;
  retryCodeCatalog(): Promise<void>;
  chooseCodeReferences(kind: WorkspaceReference["kind"]): Promise<{ references: CodeReference[]; rejected: number }>;
  removeCodeReference(id: string): Promise<void>;
  newTask(): Promise<void>;
  confirmHandoff(input: WorkspaceHandoffInput): Promise<WorkspaceHandoff | null>;
  removeHandoff(id: string): Promise<void>;
  start(input: StartInput): Promise<void>;
  resume(id: string): Promise<boolean>;
  followUp(id: FollowUpTarget, text: string): Promise<boolean>;
  queueMessage(id: string, operation: QueueOperation): Promise<boolean>;
  stopBackground(id: string, handle: string): Promise<boolean>;
  stopSubagents(id: string, subtask?: string): Promise<boolean>;
  codeMemory(input: CodeMemoryInput): Promise<CodeMemoryView>;
  codeExtensions(input: CodeExtensionsInput): Promise<CodeExtensionsView>;
  localExtensions(command: LocalExtensionsCommand): Promise<LocalExtensionsView>;
  codeSandbox(input: CodeSandboxInput): Promise<CodeSandboxView>;
  plugins(command: PluginsCommand): Promise<PluginsView>;
  /** Starts a task next to the open one (its own runtime process), and acts on the tasks in the activity list. */
  startParallel(input: StartInput): Promise<void>;
  parallel(command: ParallelCommand): Promise<boolean>;
  schedules(command: ScheduleCommand): Promise<ScheduleResult>;
  stop(): Promise<void>;
  openHistory(id: string): Promise<void>;
  deleteHistory(id: string): Promise<DeleteHistoryResult>;
  compactTask(id: string): Promise<CompactHistoryResult>;
  moreHistory(): Promise<void>;
  readChange(id: string): Promise<ChangeInspection | null>;
  undoChange(id: string): Promise<UndoChangeResult>;
  /** The review panel: the diff of a scope, taking one hunk back, and asking other models to review it. */
  review<Action extends ReviewAction>(input: Extract<ReviewInput, { action: Action }>): Promise<ReviewOutcome<Action>>;
  rewindTurn(taskId: string, turn: number): Promise<RewindTurnResult>;
  forkTurn(taskId: string, turn: number): Promise<ForkTurnResult>;
  readCommand(id: string): Promise<CommandInspection | null>;
  checkRecovery(id: string): Promise<RecoveryResult>;
  exportDiagnostics(): Promise<boolean>;
  copyDiagnostics(): Promise<boolean>;
  accountSettings<Action extends AccountSettingsAction>(
    input: Extract<DesktopAccountSettingsInput, { action: Action }>,
  ): Promise<AccountSettingsResult<Action>>;
  accountData(input: DesktopAccountDataInput): Promise<DesktopAccountDataResult>;
  assistantImport<Action extends AssistantImportAction>(input: Extract<AssistantImportInput, { action: Action }>): Promise<AssistantImportResult<Action>>;
  billing<Action extends BillingAction>(input: Extract<DesktopBillingInput, { action: Action }>): Promise<BillingResult<Action>>;
  /** The checkout window and this account's purchase records, pushed on every change (see `billing({ action: "purchases" })`). */
  subscribeBilling(listener: (state: BillingState) => void): () => void;
  /** Managed Code credits: read the catalogue and the reservation, reserve, release. Credit numbers are the server's receipt values. */
  managedCode(input: DesktopManagedCodeInput): Promise<ManagedCodeView>;
  chatExtras<Action extends ChatExtrasAction>(input: Extract<ChatExtrasInput, { action: Action }>): Promise<ChatExtrasOutput[Action]>;
  exportReviewAnalysis(input: ReviewExportInput): Promise<boolean>;
  projects<Action extends DesktopProjectAction>(input: Extract<DesktopProjectInput, { action: Action }>): Promise<DesktopProjectOutcome<Action>>;
  research<Action extends DesktopResearchAction>(input: Extract<DesktopResearchInput, { action: Action }>): Promise<DesktopResearchOutcome<Action>>;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  setCodeNotifications(enabled: boolean): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  connectCopiedCodeKey(): Promise<void>;
  cancelSignIn(): Promise<void>;
  chatHistory(product?: DesktopTextProduct): Promise<ChatHistoryRow[]>;
  chatSearch(query: string, product?: DesktopTextProduct): Promise<ChatHistoryHit[]>;
  chatConversation(input: ChatPageInput): Promise<ChatConversation>;
  chatImportedSource(input: ChatSourceInput): Promise<ChatImportedSource>;
  chatUnlockImportedSource(input: ChatUnlockImportedInput): Promise<ChatUnlockImportedResult>;
  renameChat(input: ChatRenameInput): Promise<{ title: string }>;
  removeChat(id: string): Promise<boolean>;
  chatModels(): Promise<ChatModel[]>;
  prepareReviewAnalysis(id: string): Promise<ReviewSetup>;
  runReviewAnalysis(input: ReviewAnalysisRequest): Promise<ComparisonReview>;
  copyChatText(text: string): Promise<void>;
  exportChat(input: { id: string; title: string; includeSource: boolean }): Promise<boolean>;
  sendChat(input: ChatTurnInput): Promise<ChatTurnResult>;
  stopChat(): Promise<void>;
  subscribeChat(listener: (progress: ChatTurnProgress) => void): () => void;
  sendReview(input: ReviewTurnInput): Promise<ReviewTurnResult>;
  subscribeReview(listener: (progress: ReviewTurnProgress) => void): () => void;
  imageConversations(): Promise<ChatHistoryRow[]>;
  imageHistory(id: string): Promise<ImageHistory>;
  imageGroup(id: string): Promise<ImageGroup>;
  generateImages(input: ImageRequest): Promise<ImageGenerationResult>;
  previewImage(id: string): Promise<ImageBytes>;
  saveImage(input: { id: string; modelId: string }): Promise<boolean>;
  saveArtifact(input: SaveArtifactInput): Promise<boolean>;
  pluginInventory(): Promise<DesktopPluginInventory>;
  connectorInventory(): Promise<ConnectorInventory>;
  connectorAction(input: ConnectorInput): Promise<ConnectorResult>;
  importDriveAttachments(input: import("./attachment-contract").DriveImportInput): Promise<{ files: AttachmentUpload[]; incomplete: boolean }>;
  checkDeepResearch(id: string): Promise<{ status: "submitted" | "in_progress" | "completed" | "failed"; content?: string }>;
  uploadAttachment(input: AttachmentBytesInput): Promise<AttachmentUpload>;
  cancelAttachmentUpload(requestId: string): Promise<void>;
  discardAttachment(uploadId: string): Promise<void>;
  approval(): Promise<ApprovalRequest | null>;
  decide(input: Decision): Promise<boolean>;
};
