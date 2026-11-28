import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { killTree, killTreeSync } from "../../../tomverse-cli/src/commands.js";
import { isSecretPath } from "../../../tomverse-cli/src/workspace.js";
import type { PermissionModeId } from "../permission-contract";
import { cliModelArgumentPattern, cliPermissionPlan, LIVE_CLI_LIMITS, ZAI_ANTHROPIC_BASE_URL, type CliPermissionPlan, type LiveCliProvider } from "../provider-cli-exec-contract";
import { codeProcessLaunch } from "./code-process-launch";

/**
 * Runs the person's own provider CLI (Codex `exec`, Claude Code's stream protocol) for one task and turns what it prints
 * into the events the Code screen already shows. The file is the one the person saved and trusted (providerCli.resolveSaved);
 * this module never searches PATH and never takes a path from model output. It calls no Tomverse API and spends no credits.
 */

export type ExecFile = { path: string; kind: "create" | "update" | "delete" };
export type ExecEvent =
  | { type: "session"; id: string; model?: string }
  | { type: "message"; id: string; text: string }
  | { type: "delta"; id: string; text: string }
  | { type: "command"; id: string; command: string; state: "running" | "done" | "failed" | "declined"; exitCode?: number | null; output?: string }
  | { type: "files"; id: string; files: ExecFile[]; state: "running" | "done" | "failed" }
  | { type: "tool"; id: string; name: string; detail?: string; state: "running" | "done" | "failed" }
  | { type: "notice"; text: string }
  | { type: "turn"; state: "completed" | "failed"; error?: string };

export type CliApproval = { id: string; tool: string; input: Record<string, unknown> };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4_000) => (typeof value === "string" ? value.slice(0, max) : undefined);

// ---------------------------------------------------------------- arguments

const claudeShell = ["Bash", "PowerShell"];

/** Claude Code's rule patterns for the files that can hold credentials, by name (the same names as isSecretPath). */
const secretNames = [".env*", ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials", ".pypirc", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore",
  "*.jks", "*.asc", "*.ppk", "id_rsa*", "id_ed25519*", "id_dsa*", "id_ecdsa*", "credential*", "secret*", "*service?account*.json", "*service-account*.json", "*gcp?key*.json", "*gcp-key*.json"];
const secretFolders = [".ssh", ".aws", ".gnupg", ".git", ".tomverse"];
/** Reading or changing one of these is denied in every mode, as Tomverse's own file tools do; a request naming one is never shown to the person. */
export const claudeSecretRules = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].flatMap((tool) => [
  ...secretNames.map((name) => `${tool}(**/${name})`), ...secretFolders.map((folder) => `${tool}(**/${folder}/**)`),
]);

/** Names of Claude Code's built-in tools a run may use, by the permission it was granted (the tool list is the hard limit). */
export function claudeTools(grants: PermissionModeId, platform: NodeJS.Platform = process.platform): string[] {
  // No Grep: a search over a folder returns file contents without passing the Read deny rules for credential files (Claude Code applies
  // them to Grep only best-effort), so reading goes through Read, which they cover, and Glob lists names only.
  const read = ["Read", "Glob"];
  if (grants === "read_only") return read;
  return [...read, "Edit", "Write", "Bash", ...(platform === "win32" ? ["PowerShell"] : [])];
}

/**
 * The write modes' sandbox as a Codex permission profile instead of `--sandbox workspace-write`: everything readable, the
 * project and the temp folder writable, no network, and the credential files and folders found in the project (`readOnlyPaths`, relative to it)
 * read-only. Codex takes a glob here only to deny reading (which needs the elevated Windows sandbox), so each one is named.
 * On Windows a read-only file can still be deleted, since deleting is a right on its folder.
 */
export function codexWriteProfile(readOnlyPaths: readonly string[]): string[] {
  const project = [`"."="write"`, ...readOnlyPaths.map((path) => `${JSON.stringify(path)}="read"`)];
  const entries = [`":root"="read"`, `":tmpdir"="write"`, `":workspace_roots"={${project.join(", ")}}`];
  return ["-c", 'default_permissions="tomverse"', "-c", `permissions.tomverse={filesystem={${entries.join(", ")}}}`];
}

/** Codex's command line cannot grow without bound (Windows stops at 32 767 characters). */
const PROFILE_CHARACTERS = 28_000;

/**
 * The files and folders under `root` that can hold credentials (isSecretPath), relative to it with forward slashes; a
 * folder is given as `<folder>/**`, and so is a folder that cannot be listed. Nothing under one is listed, and no link is
 * followed. A project folder that cannot be listed is an error: the run does not start with write access.
 *
 * `node_modules` is searched too (owner decision 2026-11-28): a credential can sit there (a cache, a linked local package).
 * The cost is that packages with such names (an `.npmrc`, test keys such as `*.pem`, `credential-provider-*`) are read-only
 * for the run, so installing or updating one of them from Codex fails on macOS and Linux.
 */
export async function credentialPathsIn(root: string): Promise<string[]> {
  const found: string[] = [];
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(relative ? `${base}/${relative}` : base, { withFileTypes: true }); } catch (error) {
      // A folder that cannot be listed could hide one: it is read-only as a whole. The project itself must be listed.
      if (!relative) throw error;
      found.push(`${relative}/**`);
      continue;
    }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isSecretPath(entry.name)) found.push(`${path}/**`);
        else pending.push(path);
      } else if (isSecretPath(entry.name)) found.push(path);
    }
  }
  return found.sort();
}

/**
 * `codex exec` never asks for approval. The user's config file and exec-policy rules are not loaded (they could widen the
 * sandbox or add tools that run outside it); the flags below are the whole permission. The prompt comes on stdin.
 * On Windows the sandbox is named here: without the config file Codex has none there and refuses every command, reads
 * included. The unelevated sandbox needs no administrator setup.
 */
export function codexArguments(input: { cwd: string; plan: CliPermissionPlan; platform?: NodeJS.Platform; readOnlyPaths?: readonly string[]; model?: string }): string[] {
  const { grants } = input.plan;
  const permission = grants === "read_only" ? ["--sandbox", "read-only"]
    : grants === "auto_review" || grants === "allow_all" ? codexWriteProfile(input.readOnlyPaths ?? []) : null;
  if (!permission) throw new Error("Codex has no approval route for this permission.");
  const windows = (input.platform ?? process.platform) === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : [];
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...windows, "-C", input.cwd, ...permission,
    ...modelArgument("--model", input.model), "-"];
}

/**
 * Claude Code in `--restricted` mode ignores the user, project and local settings files (a repository cannot bring its own
 * allow rules or hooks), and the tool list is the hard limit of what the run can reach. The approvals it asks for come back
 * over the stream protocol (`--permission-prompt-tool stdio`; without it Claude Code denies them without asking). Skills are off.
 * Allow all pre-approves the file tools only: a command is never approved without the person, because the shell cannot be
 * confined the way Codex's sandbox is. Claude Code itself still runs a few commands it classes as read-only (such as `echo`)
 * without asking; the credential deny rules apply to those too.
 */
export function claudeArguments(input: { plan: CliPermissionPlan; sessionId: string; platform?: NodeJS.Platform; model?: string }): string[] {
  const { grants } = input.plan;
  const tools = claudeTools(grants, input.platform);
  const mode = grants === "read_only" ? ["--permission-mode", "dontAsk", "--permission-prompts", "none"]
    : ["--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
  return ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--restricted", "--disable-slash-commands", "--no-session-persistence", "--session-id", input.sessionId, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", tools.join(","), "--disallowedTools", claudeSecretRules.join(","),
    ...(grants === "allow_all" ? ["--allowedTools", tools.filter((tool) => !claudeShell.includes(tool)).join(",")] : []), ...mode,
    ...modelArgument("--model", input.model)];
}

/** The Tomverse model the person chose, by its provider's own id; none keeps the CLI's default. Anything else is refused, never passed. */
function modelArgument(flag: string, model: string | undefined): string[] {
  if (model === undefined) return [];
  if (!cliModelArgumentPattern.test(model)) throw new Error("The selected model cannot be passed to the CLI.");
  return [flag, model];
}

const inherited = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "SystemDrive", "PUBLIC", "ALLUSERSPROFILE", "HOMEDRIVE", "HOMEPATH", "USERDOMAIN",
  "COMPUTERNAME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LC_ALL",
  "LC_CTYPE", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

/**
 * What the CLI is started with: the system and user-profile variables it needs to find its own sign-in, the PATH its tools run
 * with, and proxy settings. No Tomverse variable, no session or Code token, and no provider API key (the run uses the CLI's saved
 * sign-in, so the subscription is what is used) is passed on. The one key is the Z.ai route's own: the person's Coding Plan key,
 * with Z.ai's endpoint and a settings folder of its own, so Claude Code neither uses nor changes the person's Claude sign-in.
 */
export function cliExecEnvironment(env: NodeJS.ProcessEnv, provider: LiveCliProvider, platform: NodeJS.Platform = process.platform,
    zai?: ZaiRun): Record<string, string> {
  const result: Record<string, string> = {};
  const lower = new Map(Object.keys(env).map((key) => [key.toLowerCase(), key]));
  for (const name of inherited) {
    const key = platform === "win32" ? lower.get(name.toLowerCase()) : Object.hasOwn(env, name) ? name : undefined;
    const value = key === undefined ? undefined : env[key];
    if (value) result[platform === "win32" && name.toLowerCase() === "path" ? "PATH" : name] = value;
  }
  result.NO_COLOR = "1";
  if (provider !== "openai") {
    result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    result.DISABLE_AUTOUPDATER = "1";
  }
  if (provider === "zai" && zai) {
    result.CLAUDE_CONFIG_DIR = zai.configDir;
    result.ANTHROPIC_BASE_URL = ZAI_ANTHROPIC_BASE_URL;
    result.ANTHROPIC_AUTH_TOKEN = zai.key;
    // Z.ai's documented timeout for the Coding Plan: its long answers outlast Claude Code's default.
    result.API_TIMEOUT_MS = "3000000";
    result.DISABLE_TELEMETRY = "1";
  }
  return result;
}

// ------------------------------------------------------------------- Codex

const fileKinds: Record<string, ExecFile["kind"]> = { add: "create", create: "create", update: "update", delete: "delete" };

/** Reads the JSONL of `codex exec --json`. Unknown events and fields are ignored. */
export function codexParser() {
  return (line: Json): ExecEvent[] => {
    const type = text(line.type);
    if (type === "thread.started") return [{ type: "session", id: text(line.thread_id, 200) ?? "" }];
    if (type === "turn.completed") return [{ type: "turn", state: "completed" }];
    if (type === "turn.failed") return [{ type: "turn", state: "failed", ...(isRecord(line.error) ? { error: text(line.error.message, 600) } : {}) }];
    if (type === "error") return [{ type: "notice", text: text(line.message, 600) ?? "" }];
    if ((type !== "item.started" && type !== "item.updated" && type !== "item.completed") || !isRecord(line.item)) return [];
    const item = line.item;
    const id = text(item.id, 200);
    const kind = text(item.type);
    if (!id || !kind) return [];
    const finished = type === "item.completed";
    const status = text(item.status);
    if (kind === "agent_message") return finished && typeof item.text === "string" ? [{ type: "message", id, text: item.text.slice(0, LIVE_CLI_LIMITS.message) }] : [];
    if (kind === "command_execution") {
      const state = !finished || status === "in_progress" ? "running" : status === "declined" ? "declined" : status === "completed" ? "done" : "failed";
      return [{ type: "command", id, command: text(item.command, 2_000) ?? "", state,
        ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
        ...(finished && typeof item.aggregated_output === "string" ? { output: item.aggregated_output.slice(-LIVE_CLI_LIMITS.commandOutput) } : {}) }];
    }
    if (kind === "file_change") {
      const files = Array.isArray(item.changes) ? item.changes.flatMap((change): ExecFile[] => {
        const path = isRecord(change) ? text(change.path, 2_048) : undefined;
        const mapped = isRecord(change) ? fileKinds[text(change.kind) ?? ""] : undefined;
        return path && mapped ? [{ path, kind: mapped }] : [];
      }) : [];
      return [{ type: "files", id, files, state: !finished || status === "in_progress" ? "running" : status === "completed" ? "done" : "failed" }];
    }
    if (kind === "mcp_tool_call") {
      return [{ type: "tool", id, name: `${text(item.server, 80) ?? "mcp"}.${text(item.tool, 120) ?? "tool"}`,
        state: !finished || status === "in_progress" ? "running" : status === "completed" ? "done" : "failed" }];
    }
    if (kind === "web_search") return finished ? [{ type: "tool", id, name: "web_search", detail: text(item.query, 300), state: "done" }] : [];
    if (kind === "error" && finished) return [{ type: "notice", text: text(item.message, 600) ?? "" }];
    return [];
  };
}

// ------------------------------------------------------------------ Claude

const claudeShellTools = new Set(["Bash", "PowerShell"]);
const claudeEditTools = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** Reads the stream-json frames of `claude -p`. Approvals are returned separately by the runner; unknown frames are ignored. */
export function claudeParser() {
  const uses = new Map<string, { tool: string; path?: string }>();
  const streaming = { block: -1 };
  return (frame: Json): ExecEvent[] => {
    const type = text(frame.type);
    if (type === "system" && frame.subtype === "init") return [{ type: "session", id: text(frame.session_id, 200) ?? "", model: text(frame.model, 160) }];
    if (type === "stream_event" && isRecord(frame.event)) {
      const event = frame.event;
      if (event.type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "text") {
        streaming.block = typeof event.index === "number" ? event.index : 0;
        return [];
      }
      if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta" && typeof event.delta.text === "string" &&
          streaming.block === (typeof event.index === "number" ? event.index : 0)) {
        return [{ type: "delta", id: "stream", text: event.delta.text }];
      }
      return [];
    }
    if (type === "assistant" && isRecord(frame.message) && Array.isArray(frame.message.content)) {
      const events: ExecEvent[] = [];
      const frameId = text(frame.uuid, 100) ?? randomUUID();
      streaming.block = -1;
      frame.message.content.forEach((block, index) => {
        if (!isRecord(block)) return;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          events.push({ type: "message", id: `${frameId}:${index}`, text: block.text.slice(0, LIVE_CLI_LIMITS.message) });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const input = isRecord(block.input) ? block.input : {};
          const id = block.id.slice(0, 200);
          if (claudeShellTools.has(block.name)) {
            uses.set(id, { tool: "shell" });
            events.push({ type: "command", id, command: text(input.command, 2_000) ?? "", state: "running" });
          } else if (claudeEditTools.has(block.name)) {
            const path = text(input.file_path, 2_048) ?? text(input.notebook_path, 2_048);
            uses.set(id, { tool: block.name, path });
            events.push({ type: "files", id, files: path ? [{ path, kind: block.name === "Write" ? "create" : "update" }] : [], state: "running" });
          } else {
            uses.set(id, { tool: block.name });
            events.push({ type: "tool", id, name: block.name.slice(0, 120),
              detail: text(input.file_path, 300) ?? text(input.pattern, 300) ?? text(input.query, 300) ?? text(input.url, 300), state: "running" });
          }
        }
      });
      return events;
    }
    if (type === "user" && isRecord(frame.message) && Array.isArray(frame.message.content)) {
      const events: ExecEvent[] = [];
      for (const block of frame.message.content) {
        if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const id = block.tool_use_id.slice(0, 200);
        const use = uses.get(id);
        if (!use) continue;
        uses.delete(id);
        const failed = block.is_error === true;
        if (use.tool === "shell") {
          events.push({ type: "command", id, command: "", state: failed ? "failed" : "done",
            output: toolResultText(block.content).slice(-LIVE_CLI_LIMITS.commandOutput) });
        } else if (claudeEditTools.has(use.tool)) {
          const written = isRecord(frame.tool_use_result) ? text(frame.tool_use_result.type, 20) : undefined;
          const kind: ExecFile["kind"] = written === "create" ? "create" : "update";
          events.push({ type: "files", id, files: use.path ? [{ path: use.path, kind }] : [], state: failed ? "failed" : "done" });
        } else {
          events.push({ type: "tool", id, name: use.tool, state: failed ? "failed" : "done" });
        }
      }
      return events;
    }
    if (type === "result") {
      const failed = frame.is_error === true || (typeof frame.subtype === "string" && frame.subtype !== "success");
      return [{ type: "turn", state: failed ? "failed" : "completed", ...(failed ? { error: text(frame.result, 600) ?? text(frame.subtype, 80) } : {}) }];
    }
    return [];
  };
}

// ------------------------------------------------------------------ runner

/** The Z.ai route's key and Claude Code settings folder, from the main process for this run only. */
export type ZaiRun = { key: string; configDir: string };

export type ExecRun = {
  provider: LiveCliProvider;
  /** The Z.ai route only. */
  zai?: ZaiRun;
  /** The saved, verified executable. */
  file: string;
  /** Arguments placed before the CLI's own (a test runs a stand-in script through the Node binary this way). */
  argsPrefix?: readonly string[];
  /** The provider's own id of the Tomverse model the person chose; without it the CLI runs its default model. */
  model?: string;
  cwd: string;
  prompt: string;
  mode: PermissionModeId;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onEvent: (event: ExecEvent) => void;
  /** Claude Code only: asks the person; false denies. Called one request at a time. */
  approve?: (request: CliApproval, signal: AbortSignal) => Promise<boolean>;
  platform?: NodeJS.Platform;
  /** Lower limits for a test. */
  limits?: Partial<{ stream: number; line: number }>;
};
export type ExecResult = {
  status: "completed" | "stopped" | "failed" | "unknown";
  exitCode: number | null;
  error?: string;
  plan: CliPermissionPlan;
  /** Lines the CLI printed that were too long or not protocol JSON. */
  skipped: number;
  stderr: string;
};

const closeDeadline = 3_000;
const stderrKeep = 4_000;

/** Splits a byte stream into lines without keeping more than `limit` of one line. */
function lineReader(limit: number, onLine: (line: string) => void, onSkip: () => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  const take = (chunk: string) => {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        if (dropping) return;
        pending += rest;
        if (pending.length > limit) { pending = ""; dropping = true; onSkip(); }
        return;
      }
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (dropping) { dropping = false; continue; }
      const line = pending + piece;
      pending = "";
      if (line.length > limit) { onSkip(); continue; }
      if (line.trim()) onLine(line);
    }
  };
  return { push: (buffer: Buffer) => take(decoder.write(buffer)), end: () => { take(decoder.end()); if (pending.trim() && !dropping) onLine(pending); pending = ""; } };
}

export async function runProviderCli(run: ExecRun): Promise<ExecResult> {
  const plan = cliPermissionPlan(run.provider, run.mode);
  const sessionId = randomUUID();
  const result = (status: ExecResult["status"], exitCode: number | null, extra: Partial<ExecResult> = {}): ExecResult =>
    ({ status, exitCode, plan, skipped, stderr: stderrTail, ...extra });
  let skipped = 0;
  let stderrTail = "";
  // Codex changes files without asking in the write modes, so the credential files it may read are made read-only first.
  let readOnlyPaths: string[] = [];
  try { if (run.provider === "openai" && plan.grants !== "read_only") readOnlyPaths = await credentialPathsIn(run.cwd); } catch {
    return result("failed", null, { error: "The project folder could not be read." });
  }
  if (codexWriteProfile(readOnlyPaths).join(" ").length > PROFILE_CHARACTERS) {
    return result("failed", null, { error: "The project has too many credential files to protect. Use Read only, or another route." });
  }
  const args = [...(run.argsPrefix ?? []),
    ...(run.provider === "openai" ? codexArguments({ cwd: run.cwd, plan, platform: run.platform, readOnlyPaths, model: run.model }) : claudeArguments({ plan, sessionId, platform: run.platform, model: run.model }))];
  if (run.provider === "zai" && !run.zai?.key) return result("failed", null, { error: "Add the Z.ai Coding Plan key in Settings > Development CLIs." });
  if (run.signal.aborted) return result("stopped", null);

  const launch = codeProcessLaunch(run.file, args);
  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.args, {
      cwd: run.cwd, env: cliExecEnvironment(run.env, run.provider, run.platform, run.zai), shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return result("failed", null, { error: "The CLI could not be started." });
  }
  const pid = child.pid;
  const onExit = () => { if (pid) killTreeSync(pid); };
  process.once("exit", onExit);

  const stdin = child.stdin!;
  stdin.on("error", () => undefined);
  const parse = run.provider === "openai" ? codexParser() : claudeParser();
  let turn: "completed" | "failed" | undefined;
  let error: string | undefined;
  let bytes = 0;
  let overflow = false;
  let spawnFailed = false;
  let approvals = Promise.resolve();
  const pendingApprovals = new Map<string, AbortController>();
  const send = (frame: Json) => { try { stdin.write(`${JSON.stringify(frame)}\n`); } catch { /* The CLI already ended. */ } };
  const emit = (event: ExecEvent) => {
    if (event.type === "turn") { turn = event.state; error = event.error ?? error; }
    run.onEvent(event);
  };

  const answer = (requestId: string, request: Json) => {
    const input = isRecord(request.input) ? request.input : {};
    const tool = text(request.tool_name, 200) ?? "unknown";
    const controller = new AbortController();
    pendingApprovals.set(requestId, controller);
    const signal = AbortSignal.any([run.signal, controller.signal]);
    approvals = approvals.then(async () => {
      let allowed = false;
      try {
        allowed = !!run.approve && plan.approvals === "card" && !signal.aborted && await run.approve({ id: requestId, tool, input }, signal);
      } catch { allowed = false; }
      pendingApprovals.delete(requestId);
      if (controller.signal.aborted && !run.signal.aborted) return;
      send({ type: "control_response", response: { subtype: "success", request_id: requestId,
        response: allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The person declined this action in Tomverse Desktop." } } });
    });
  };

  const handle = (line: string) => {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { skipped += 1; return; }
    if (!isRecord(frame)) { skipped += 1; return; }
    if (run.provider !== "openai") {
      if (frame.type === "control_request" && isRecord(frame.request) && frame.request.subtype === "can_use_tool" && typeof frame.request_id === "string") {
        answer(frame.request_id, frame.request);
        return;
      }
      if (frame.type === "control_cancel_request" && typeof frame.request_id === "string") {
        pendingApprovals.get(frame.request_id)?.abort();
        return;
      }
      if (frame.type === "control_request" && typeof frame.request_id === "string") {
        // A request this adapter does not serve is refused, never left waiting.
        send({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "Unsupported request." } });
        return;
      }
    }
    for (const event of parse(frame)) {
      emit(event);
      if (event.type === "turn" && run.provider !== "openai") stdin.end();
    }
  };

  const streamLimit = run.limits?.stream ?? LIVE_CLI_LIMITS.stream;
  const stdout = lineReader(run.limits?.line ?? LIVE_CLI_LIMITS.line, handle, () => { skipped += 1; });
  let killing: Promise<unknown> | undefined;
  const kill = () => { killing ??= killTree(child).catch(() => { child.kill("SIGKILL"); }); return killing; };
  child.stdout!.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > streamLimit) {
      if (!overflow) { overflow = true; void kill(); }
      return;
    }
    stdout.push(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-stderrKeep); });
  child.stdout!.on("error", () => undefined);
  child.stderr!.on("error", () => undefined);

  const closed = new Promise<number | null>((resolve) => {
    let settled = false;
    const done = (code: number | null) => { if (!settled) { settled = true; resolve(code); } };
    child.once("error", () => { spawnFailed = true; done(null); });
    child.once("close", (code) => done(code));
    child.once("exit", (code) => {
      // Whatever the CLI left running (a background command, a child of a crashed CLI) ends with it, and a question
      // nobody can answer any more is cancelled. This runs at the exit itself, before the process id can mean anything else.
      // killTree lists the orphans of the exited process too: on Windows by the parent id they still record, on POSIX by the
      // process group (a command that started its own session is not found once its parent is gone).
      for (const controller of pendingApprovals.values()) controller.abort();
      void kill();
      // A grandchild that kept the pipes open must not hold the run: give the pipes a moment to flush, then let go.
      setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); done(code); }, closeDeadline).unref();
    });
  });

  const onAbort = () => { for (const controller of pendingApprovals.values()) controller.abort(); void kill(); };
  run.signal.addEventListener("abort", onAbort, { once: true });
  if (run.signal.aborted) onAbort();

  if (run.provider === "openai") {
    stdin.end(run.prompt);
  } else {
    send({ type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: run.prompt }] } });
  }

  try {
    const exitCode = await closed;
    stdout.end();
    await approvals.catch(() => undefined);
    if (spawnFailed) return result("failed", null, { error: "The CLI could not be started." });
    if (run.signal.aborted) return result("stopped", exitCode);
    if (overflow) return result("failed", exitCode, { error: "The CLI printed more than Tomverse Desktop reads." });
    if (turn === "completed" && exitCode === 0) return result("completed", exitCode);
    // A run that ended without saying how it went has an unknown outcome: it may have changed files.
    if (!turn) return result("unknown", exitCode, { error });
    return result("failed", exitCode, { error });
  } finally {
    run.signal.removeEventListener("abort", onAbort);
    process.removeListener("exit", onExit);
    await kill();
    stdin.destroy();
  }
}
