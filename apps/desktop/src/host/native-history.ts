import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { same, sha256, writeFileAtomic, type SessionState } from "../../../tomverse-cli/src/runtime.js";
import { taskAnalysisSchema } from "../../../tomverse-cli/src/task-plan.js";
import { acpUsageSources, asProposedCodePlan, codeNativeAssignment as assignment, codeNativeQuota, codeNativeRunEvidence, codeReferenceKind, codeReferencePath,
  kimiNativeSessionId, zCodeNativeSessionId, miniMaxNativeSessionId, MAX_CODE_NATIVE_RUNS, MAX_CODE_REFERENCES, sessionId, startInput,
  type CodeNativeRunEvidence, type CodeNativeUsage, type Task } from "../contract";
import { antigravityFixtureExecution, claudeFixtureExecution, codexFixtureExecution, kimiFixtureExecution, nativeFixtureProvider, qwenFixtureExecution, vibeFixtureExecution, deepSeekFixtureExecution, zCodeFixtureExecution, miniMaxFixtureExecution, grokFixtureExecution, type NativeFixtureProvider } from "../code-execution";
import { codeCliContinuation, codeContinuation, type CodeCliContinuation, type CodeContinuation } from "../code-fallback";
import type { CliFixtureInput } from "./cli-fixture-input";
import { desktopCodeNotice } from "./desktop-notice";

const nativeId = z.string().regex(/^[\w.:-]{1,160}$/);
type Provider = NativeFixtureProvider;
const fixtureExecutions = { openai: codexFixtureExecution, anthropic: claudeFixtureExecution, qwen: qwenFixtureExecution, moonshot: kimiFixtureExecution, mistral: vibeFixtureExecution, deepseek: deepSeekFixtureExecution, zhipu: zCodeFixtureExecution, minimax: miniMaxFixtureExecution, xai: grokFixtureExecution, google: antigravityFixtureExecution };
const historyPrefixes = { openai: "codex", anthropic: "claude", qwen: "qwen", moonshot: "kimi", mistral: "vibe", deepseek: "deepseek", zhipu: "zcode", minimax: "minimax", xai: "grok", google: "antigravity" };
const quotaProviders = { codex: "openai", claude_code: "anthropic", grok_build: "xai", qwen_code: "qwen", zcode: "zhipu" } as const;
const usageSources: Partial<Record<Provider, CodeNativeUsage["source"]>> = {
  ...acpUsageSources, openai: "codex_thread", anthropic: "claude_turn", qwen: "qwen_requests", zhipu: "zcode_turn",
};
const plan = z.object({ activeId: z.null(), analysis: taskAnalysisSchema.optional(), items: z.array(z.object({
  id: nativeId, segmentId: nativeId.optional(), title: z.string().max(1600), complete: z.boolean(), cancelled: z.boolean(),
  completionUnverified: z.boolean().optional(), nativeAssignment: assignment.optional(), evidenceStart: z.number().int().min(0).max(64).optional(),
  nativeStatus: z.enum(["pending", "in_progress", "completed"]).optional(),
  evidence: z.array(z.object({ tool: z.enum(["run_command", "read_file", "list_files", "apply_patch"]), state: z.enum(["succeeded", "failed", "unconfirmed"]),
    assignment, nativeItemId: nativeId.optional(), nativeCallId: nativeId.optional(), nativeReadBinding: z.string().regex(/^[0-9a-f]{64}$/).optional() })).max(64),
}).refine((row) => {
  const start = row.evidenceStart ?? 0;
  if (start > row.evidence.length) return false;
  if (!row.complete) return true;
  const current = row.evidence.slice(start);
  return !row.cancelled && current.length > 0 && current.every(({ state }) => state === "succeeded") &&
    row.evidence.every(({ state }) => state !== "unconfirmed");
})).max(24) });
const entry = z.union([z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(24_000) }), z.object({ role: z.literal("plan") })]);
const checkpoint = z.object({
  provider: nativeFixtureProvider.default("openai"),
  version: z.literal(1), id: sessionId, root: z.string().max(4096), title: z.string().max(80), mode: z.enum(["ask", "plan", "agent"]),
  status: z.enum(["completed", "stopped", "failed", "unknown", "blocked"]), entries: z.array(entry).max(80),
  references: z.array(z.object({ path: codeReferencePath, kind: codeReferenceKind }).strict()).max(MAX_CODE_REFERENCES).optional(),
  plan: plan.optional(), nativeSession: assignment.optional(), effort: startInput.shape.effort.optional(),
  nativeRuns: z.array(codeNativeRunEvidence).max(MAX_CODE_NATIVE_RUNS).optional(), quota: codeNativeQuota.optional(),
  continuation: codeContinuation.optional(),
  apiSource: codeCliContinuation.optional(),
  changes: z.array(z.object({ id: nativeId, path: z.string().min(1).max(2048), kind: z.enum(["create", "update", "delete"]),
    current: z.enum(["applied", "writing", "failed", "undone", "not_attempted"]) })).max(1200).optional(),
}).refine(({ provider, mode, nativeSession, nativeRuns, plan, status, quota, continuation, apiSource, changes }) => {
  const session = nativeSession ?? nativeRuns?.at(-1)?.session;
  const modelSource = provider === "openai" ? "codex_reroute" : provider === "anthropic" ? "claude_assistant" : undefined;
  const threadId = provider === "moonshot" ? kimiNativeSessionId : provider === "openai" ? nativeId : provider === "mistral" ? z.guid() : provider === "zhipu" ? zCodeNativeSessionId : provider === "minimax" ? miniMaxNativeSessionId : z.uuid();
  const matches = (item: z.infer<typeof assignment>) =>
    item.threadId === session?.threadId && item.model === session.model && (item.provider ?? "openai") === provider &&
    (!item.reportedModel || item.reportedModel.source === modelSource);
  if (nativeSession && (!matches(nativeSession) || !threadId.safeParse(nativeSession.threadId).success)) return false;
  if ((status === "blocked") !== !!quota || (quota && (quotaProviders[quota.source] !== provider ||
      quota.threadId !== nativeSession?.threadId ||
      quota.turnId !== nativeSession.turnId))) return false;
  if (continuation && ((!quota || quota.source !== "codex" && quota.source !== "claude_code") ||
      plan?.items.some((item) => item.evidence.some((record) => record.state === "unconfirmed")))) return false;
  if (apiSource && (continuation || apiSource.provider !== provider ||
      (nativeSession && nativeSession.model !== apiSource.model))) return false;
  if (nativeRuns && (new Set(nativeRuns.map(({ session }) => session.turnId)).size !== nativeRuns.length ||
      !nativeRuns.every(({ session, usage, quota }) => matches(session) &&
        (!usage || usage.source === usageSources[provider]) &&
        (!quota || quotaProviders[quota.source] === provider &&
          quota.threadId === session.threadId && quota.turnId === session.turnId)))) return false;
  if (mode !== "agent" && changes?.length) return false;
  return !plan || plan.items.every((row) =>
    (!row.segmentId || !nativeSession || row.segmentId === (apiSource?.segmentId ?? nativeSession.threadId)) &&
    (provider === "openai" ? !row.nativeStatus
      : !!row.nativeStatus && row.id.startsWith(`${historyPrefixes[provider]}-`) && (!row.complete || row.nativeStatus === "completed")) &&
    (!nativeSession || !row.nativeAssignment || matches(row.nativeAssignment)) &&
    row.evidence.every((item) => (item.tool === "read_file" || (provider === "openai" && (item.tool === "run_command" || item.tool === "list_files")) || (mode === "agent" && item.tool === "apply_patch")) &&
      (!nativeSession || matches(item.assignment)) &&
      (provider === "openai" || (!!item.nativeItemId && (status !== "stopped" || item.state !== "unconfirmed")))));
});

export function nativeHistoryHome(apiHistoryHome: string, fixture: CliFixtureInput, provider: Provider) {
  const codingPlan = provider === "zhipu" && "codingPlan" in fixture && fixture.codingPlan === true;
  const subscription = provider === "qwen" && "subscriptionCa" in fixture && typeof fixture.subscriptionCa === "string";
  const scope = sha256(JSON.stringify([apiHistoryHome, fixture.executable, fixture.version, fixture.model, fixture.origin,
    ...(codingPlan ? ["coding-plan"] : []), ...(subscription ? ["qwen-subscription"] : [])]));
  // MiniMax adds long SQLite backup filenames inside the session profile on Windows.
  if (provider === "minimax") return join(dirname(apiHistoryHome), "m-" + Buffer.from(scope, "hex").toString("base64url"));
  return join(dirname(apiHistoryHome), `${historyPrefixes[provider]}-${scope}`);
}

export const nativeSessionDirectory = (home: string, id: string) => join(home, "sessions", sessionId.parse(id));
export const apiCliDirectory = (home: string, id: string) => join(nativeSessionDirectory(home, id), "cli");
export const stagedNativeDirectory = (home: string, id: string) => join(nativeSessionDirectory(home, id), "native-source");
export const retiredHistoryDirectory = (directory: string, identity: string) =>
  join(dirname(directory), `.deleted-${basename(directory)}.${identity.replace(":", "-")}`);
const checkpointPath = (directory: string) => join(directory, "session.json");
const limit = 8 * 1024 * 1024;

function ensureLocalDirectory(directory: string) {
  if (!existsSync(directory)) {
    ensureLocalDirectory(dirname(directory));
    mkdirSync(directory, { mode: 0o700 });
  }
  if (!lstatSync(directory).isDirectory() || !same(realpathSync(directory), directory)) throw new Error("The CLI history folder changed.");
}

export function saveNativeHistory(home: string, task: Task, mode: "ask" | "plan" | "agent", starting = false, continuation?: CodeContinuation) {
  saveNativeCheckpoint(nativeSessionDirectory(home, sessionId.parse(task.id)), task, mode, starting, continuation);
}

export function saveApiCliHistory(directory: string, task: Task, mode: "ask" | "plan" | "agent", source: CodeCliContinuation, starting: boolean) {
  saveNativeCheckpoint(directory, task, mode, starting, undefined, source);
}

export function saveNativeCheckpoint(directory: string, task: Task, mode: "ask" | "plan" | "agent", starting: boolean,
  continuation?: CodeContinuation, apiSource?: CodeCliContinuation) {
  if (task.execution?.executionMode !== "provider_cli") throw new Error("Expected a provider CLI task.");
  const id = sessionId.parse(task.id);
  ensureLocalDirectory(directory);
  const entries = task.entries.filter(({ role }) => role !== "event");
  const recent = entries.slice(-78);
  if (entries.length > recent.length && !recent.some(({ role }) => role === "plan") && task.plan) recent.unshift({ role: "plan" });
  if (entries.length > 78 && entries[0]) recent.unshift(entries[0]);
  const data = checkpoint.parse({
    provider: task.execution.provider,
    version: 1, id, root: task.root, title: task.title, mode, status: starting ? "unknown" : task.status,
    entries: recent.map((entry) => entry.role === "plan" ? entry : { ...entry, text: entry.text.slice(0, 24_000) }),
    references: task.references,
    plan: task.plan && { activeId: null, analysis: task.plan.analysis, items: task.plan.items.map((row) => ({
      ...row, evidence: row.evidence.map((item) => item.state === "running" ? { ...item, state: "unconfirmed" } : item),
      ...(starting && !row.complete && !row.cancelled ? { completionUnverified: true } : {}),
    })) },
    nativeSession: task.nativeSession,
    nativeRuns: task.nativeRuns,
    effort: task.effort,
    quota: starting ? undefined : task.quota,
    continuation,
    apiSource,
    changes: mode === "agent" ? task.changes : undefined,
  });
  writeFileAtomic(checkpointPath(directory), JSON.stringify(data));
}

export function readNativeHistory(home: string, id: string, root: string, provider: Provider) {
  return sessionId.safeParse(id).success ? readNativeCheckpoint(nativeSessionDirectory(home, id), id, root, provider) : null;
}

export function readNativeCheckpoint(directory: string, id: string, root: string, provider: Provider) {
  try {
    if (!same(realpathSync(directory), directory)) return null;
    const path = checkpointPath(directory);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit || !same(realpathSync(path), path)) return null;
    const result = checkpoint.parse(JSON.parse(readFileSync(path, "utf8")));
    return result.id === id && result.root === root && result.provider === provider ? result : null;
  } catch { return null; }
}

export function matchesNativeContinuation(native: ReturnType<typeof readNativeCheckpoint>, api: SessionState) {
  return !!native?.continuation && !!api.codeContinuation &&
    native.continuation.segmentId === api.codeContinuation.segmentId &&
    native.continuation.maximumKeyCreditCap === api.codeContinuation.maximumKeyCreditCap &&
    native.continuation.model === api.model.requested;
}

export function listNativeHistory(home: string, root: string, provider: Provider) {
  try {
    const directory = join(home, "sessions");
    if (!same(realpathSync(directory), directory)) return [];
    return readdirSync(directory).flatMap((id) => {
      const saved = readNativeHistory(home, id, root, provider);
      return saved ? [{ id, title: saved.title, status: saved.status }] : [];
    });
  } catch { return []; }
}

export function canResumeNativeQuota(task: Task) {
  return task.status === "blocked" && task.savedLocally === true && !!task.nativeSession && !!task.quota &&
    (task.quota.source === "codex" || task.quota.source === "claude_code") && task.quota.threadId === task.nativeSession.threadId &&
    task.quota.turnId === task.nativeSession.turnId && !task.pendingFollowUp &&
    !task.plan?.items.some((row) => row.evidence.some(({ state }) => state === "running" || state === "unconfirmed")) &&
    task.changes.every(({ current }) => current === "applied");
}

export function recordNativeRun(task: Task, usage?: CodeNativeUsage) {
  const session = task.nativeSession;
  if (!session) return;
  const runs = task.nativeRuns ?? [];
  const last = runs.at(-1);
  const previous = last?.session.turnId === session.turnId ? last : undefined;
  const earlier = previous ? runs.slice(0, -1) : runs;
  const quota = task.quota && task.quota.source !== "tomverse_api" && task.quota.turnId === session.turnId ? task.quota : previous?.quota;
  const record: CodeNativeRunEvidence = { session, usage: usage ?? previous?.usage, quota };
  task.nativeRuns = [...earlier.slice(1 - MAX_CODE_NATIVE_RUNS), record];
}

export function restoredNativeTask(saved: z.infer<typeof checkpoint>): Task {
  const entries: Task["entries"] = [...saved.entries];
  if (saved.status === "unknown") entries.push(desktopCodeNotice("runUnknown"));
  if (saved.status === "failed") entries.push(desktopCodeNotice("runtimeFailed"));
  const preserveNativePlan = saved.provider !== "openai" && saved.provider !== "anthropic";
  const plan = preserveNativePlan && saved.plan ? { ...saved.plan, items: saved.plan.items.map((row) =>
    row.nativeStatus === "pending" && !row.evidence.length ? { ...row, nativeAssignment: undefined } : row) } : saved.plan;
  const task: Task = {
    id: saved.id, root: saved.root, title: saved.title, status: saved.status, entries,
    plan: plan && saved.mode === "plan" ? asProposedCodePlan(plan) : plan,
    references: saved.references,
    readOnly: saved.mode !== "agent", savedLocally: true, execution: fixtureExecutions[saved.provider], quota: saved.quota,
    nativeSession: saved.nativeSession, nativeRuns: saved.nativeRuns, effort: saved.effort,
    continuation: saved.continuation && saved.nativeSession && { ...saved.continuation, source: saved.nativeSession, stage: "unavailable" },
    model: saved.nativeSession?.model, canResume: (saved.mode !== "agent" || saved.provider !== "openai") &&
      saved.status === "stopped" && !!saved.nativeSession,
    canCheckRecovery: (saved.provider === "openai" || saved.provider === "anthropic") && saved.status === "unknown" && !!saved.nativeSession,
    changes: saved.changes ?? [], checks: [], transmission: [],
  };
  recordNativeRun(task);
  task.canResumeAfterQuota = canResumeNativeQuota(task);
  return task;
}
