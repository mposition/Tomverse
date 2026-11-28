import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { commandNamesSecretPath, isSecretPath } from "../../../tomverse-cli/src/workspace.js";
import type { PermissionModeId } from "../permission-contract";
import { LIVE_CLI_LIMITS, providerConfigFolders, type CliPermissionPlan, type LiveAcpProvider } from "../provider-cli-exec-contract";
import type { CliApproval, ExecEvent, ExecFile } from "./provider-cli-exec";

/**
 * The live "ACP" adapter: Qwen Code, Grok Build, Kimi Code, Mistral Vibe, MiniMax Code and Antigravity run the person's own installed CLI as
 * an Agent Client Protocol agent (JSON-RPC over stdio) in the person's real project folder and real home, so each CLI uses its
 * own sign-in. This is not the fixture path (acp-turn.ts): no loopback model server, no temporary home, no pinned version.
 *
 * Desktop is a deliberately small client. It advertises no file-system and no terminal capability, so the agent uses its own
 * tools; the one request it serves is `session/request_permission`, answered from the permission plan below. Every other
 * request from the agent is refused. Nothing here reads or writes a project file.
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4_000) => (typeof value === "string" ? value.slice(0, max) : undefined);

// ----------------------------------------------------------------- arguments

/**
 * The arguments that start each CLI as an ACP agent. Qwen Code, Kimi Code, Mistral Vibe, Grok Build and MiniMax Code are the
 * same ones the fixture routes start (structured-cli-fixture-run.ts, cli-protocol.ts); the live run drops the fixture's
 * isolation flags (agent profiles, bare mode, loopback providers). Not confirmed against the current releases: Qwen Code
 * 1.0.0-preview.2 (the fixture pins 0.28.4) and Grok Build's agent flags are the ones to check first.
 * - Qwen Code: `--acp`; `--approval-mode default` keeps its own approvals on so they reach the client.
 * - Kimi Code: the `acp` subcommand. MiniMax Code: the `acp` subcommand of `mcode`.
 * - Mistral Vibe: `vibe-acp` takes no arguments.
 * - Antigravity (`agy`): the `acp` subcommand with telemetry off; the fixture's profile, log and endpoint flags are left out so it uses its own
 *   sign-in under ~/.gemini.
 * - Grok Build: `--no-auto-update` keeps the run from replacing the person's file; `agent stdio` is its ACP server.
 */
export const acpCommandLine: Record<LiveAcpProvider, readonly string[]> = {
  qwen: ["--acp", "--approval-mode", "default"],
  xai: ["--no-auto-update", "agent", "--no-leader", "stdio"],
  moonshot: ["acp"],
  mistral: [],
  minimax: ["acp"],
  google: ["acp", "--disable-telemetry"],
};
export const acpArguments = (provider: LiveAcpProvider): string[] => [...acpCommandLine[provider]];

/** How long the CLI has to answer `initialize` and `session/new`, and how long it has to exit after the turn before it is ended. */
export const ACP_HANDSHAKE_MS = 60_000;
export const ACP_EXIT_GRACE_MS = 1_500;

// ------------------------------------------------------------ credential paths

const configFolders = new Set<string>(providerConfigFolders);
const invisible = /[­؜᠎​-‏‪-‮⁠-⁯﻿]/g;
const credentialName = /credential|oauth|(^|[-_.])auth\.json$|api[-_]?key|(access|refresh|id)[-_]?token/i;

/**
 * Whether a path names something that can hold credentials: everything isSecretPath names, anything inside a provider CLI's
 * settings folder (~/.qwen, ~/.vibe, ~/.grok ...; auth.json, subscription_credentials.json and the like), and files named like
 * a credential store. Name-based, like isSecretPath: it refuses on the name alone, whether or not the path is under the project.
 */
export function acpSecretPath(path: string): boolean {
  if (isSecretPath(path)) return true;
  const segments = path.normalize("NFKC").replace(invisible, "").replaceAll("\\", "/").toLowerCase().split("/");
  return segments.some((segment) => configFolders.has(segment)) || credentialName.test(segments.at(-1) ?? "");
}

const commandWords = (command: string) => command.split(/[\s"'=,;<>|&()`]+/).filter(Boolean);
const commandNamesCredential = (command: string) => commandNamesSecretPath(command, { everyWord: true }) || commandWords(command).some(acpSecretPath);

/** Whether the path lies inside the project, after the links of the nearest existing folder are resolved. */
export function insideProject(path: string, cwd: string): boolean {
  if (/[\u0000-\u001f]/.test(path)) return false;
  const windows = process.platform === "win32";
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  const within = (child: string, parent: string) => {
    const rel = relative(fold(parent), fold(child));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const target = resolve(cwd, path);
  try {
    const root = realpathSync.native(cwd);
    // The path may be written with the project's real path or with the path the person opened.
    if (!within(target, cwd) && !within(target, root)) return false;
    let existing = target;
    for (;;) {
      try { return within(realpathSync.native(existing), root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return false;
        const parent = dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
  } catch { return false; }
}

// ---------------------------------------------------------------- permissions

const pathKeys = new Set(["path", "file_path", "filepath", "absolute_path", "absolutepath", "file", "filename", "notebook_path", "target", "source",
  "destination", "dest", "old_path", "new_path", "directory", "dir", "cwd"]);
const listKeys = new Set(["paths", "files", "file_paths"]);
const readKinds = new Set(["read", "search", "think"]);

function parsedInput(value: unknown): Json | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length > 64 * 1024) return undefined;
  try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

function collectPaths(value: unknown, into: string[], depth = 0) {
  if (depth > 3 || !isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (pathKeys.has(name) && typeof item === "string") {
      into.push(item);
    } else if (Array.isArray(item)) {
      for (const entry of item.slice(0, 64)) {
        if (typeof entry === "string") { if (listKeys.has(name)) into.push(entry); } else collectPaths(entry, into, depth + 1);
      }
    } else {
      collectPaths(item, into, depth + 1);
    }
  }
}

type Diff = { path: string; oldText?: string | null; newText: string };
export type AcpPermission = {
  /** "allow": answered yes with no card. "deny": answered no with no card. "ask": the person's card. "refuse": no card, and the person is told. */
  verdict: "allow" | "deny" | "ask" | "refuse";
  approval: CliApproval;
  allowOption?: string;
  rejectOption?: string;
};

/**
 * Reads one `session/request_permission` and decides what Desktop does with it, by the permission plan:
 * - Read only (no approvals): a read or search inside the project is allowed; every write, command or other request is denied.
 * - Ask and Auto review: everything goes to the person's card, except a request naming a credential file or a provider CLI's
 *   settings folder, which is refused and never shown.
 * - Allow all: a file edit whose every path is inside the project is allowed; commands, network and anything outside the
 *   project still go to the card, as with Claude Code.
 * "Allow always" is never chosen: only `allow_once` is ever selected.
 */
export function classifyAcpPermission(params: unknown, context: { cwd: string; plan: CliPermissionPlan }): AcpPermission {
  const body = isRecord(params) ? params : {};
  const call = isRecord(body.toolCall) ? body.toolCall : {};
  const options = Array.isArray(body.options) ? body.options.filter(isRecord) : [];
  const optionOf = (kind: string) => options.find((option) => option.kind === kind && typeof option.optionId === "string")?.optionId as string | undefined;
  const allowOption = optionOf("allow_once");
  const rejectOption = optionOf("reject_once");
  const id = text(call.toolCallId, 200) ?? "unknown";
  const kind = text(call.kind, 40) ?? "other";
  const title = text(call.title, 300);
  const raw = parsedInput(call.rawInput);

  const paths: string[] = [];
  const diffs: Diff[] = [];
  for (const location of Array.isArray(call.locations) ? call.locations.slice(0, 64) : []) {
    const path = isRecord(location) ? text(location.path, 4_096) : undefined;
    if (path) paths.push(path);
  }
  for (const entry of Array.isArray(call.content) ? call.content.slice(0, 64) : []) {
    if (!isRecord(entry) || entry.type !== "diff" || typeof entry.path !== "string") continue;
    paths.push(entry.path);
    diffs.push({ path: entry.path, oldText: typeof entry.oldText === "string" ? entry.oldText : null, newText: typeof entry.newText === "string" ? entry.newText : "" });
  }
  collectPaths(raw, paths);
  const rawCommand = raw?.command ?? raw?.cmd;
  const command = typeof rawCommand === "string" ? rawCommand : Array.isArray(rawCommand) && rawCommand.every((word) => typeof word === "string") ? rawCommand.join(" ")
    : kind === "execute" ? title : undefined;

  let approval: CliApproval;
  if (kind === "execute" && command) {
    approval = { id, tool: "Bash", input: { command, ...(title && title !== command ? { description: title } : {}) } };
  } else if (kind === "edit" && diffs.length === 1) {
    const [diff] = diffs;
    approval = diff.oldText === null || diff.oldText === undefined
      ? { id, tool: "Write", input: { file_path: diff.path, content: diff.newText } }
      : { id, tool: "Edit", input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText } };
  } else if (kind === "edit" && diffs.length > 1) {
    approval = { id, tool: "MultiEdit", input: { file_path: diffs[0]!.path, edits: diffs.map(({ path, oldText, newText }) => ({ path, old_string: oldText ?? "", new_string: newText })) } };
  } else {
    approval = { id, tool: title ?? kind, input: { kind, ...(title ? { title } : {}), ...(paths.length ? { paths } : {}), ...(raw ? { rawInput: raw } : {}) } };
  }

  const secret = paths.some(acpSecretPath) || (command !== undefined && commandNamesCredential(command));
  const inside = paths.every((path) => insideProject(path, context.cwd));
  const result = (verdict: AcpPermission["verdict"], marked = approval): AcpPermission => ({ verdict, approval: marked, allowOption, rejectOption });
  if (context.plan.approvals === "none") return result(!secret && inside && readKinds.has(kind) && !command && allowOption ? "allow" : "deny");
  if (secret) return result("refuse", { ...approval, refused: true });
  if (context.plan.grants === "allow_all" && kind === "edit" && paths.length > 0 && inside && !command && allowOption) return result("allow");
  return result("ask");
}

// --------------------------------------------------------------------- client

const unsafeMode = /auto|yolo|bypass|accept|dont.?ask|full|allow/i;
const safeModes = ["default", "ask", "normal"];
const fileKinds: Record<string, ExecFile["kind"]> = { edit: "update", move: "update", delete: "delete" };
const toolStates: Record<string, "running" | "done" | "failed"> = { pending: "running", in_progress: "running", completed: "done", failed: "failed" };

export type AcpClientOptions = {
  cwd: string;
  prompt: string;
  mode: PermissionModeId;
  plan: CliPermissionPlan;
  /** Writes one JSON-RPC frame. */
  send: (frame: Json) => void;
  emit: (event: ExecEvent) => void;
  /** Asks the person on a card; false denies. Called one request at a time. */
  approve?: (request: CliApproval, signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
  clientVersion?: string;
  handshakeMs?: number;
};

type Tool = { kind: string; title: string; files: ExecFile[]; command?: string };

export function createAcpClient(options: AcpClientOptions) {
  let nextId = 1;
  const waiting = new Map<number, (frame: Json) => void>();
  const tools = new Map<string, Tool>();
  const pendingApprovals = new Set<AbortController>();
  let approvals: Promise<void> = Promise.resolve();
  let sessionId = "";
  let prompted = false;
  let finished = false;
  let reply = "";
  let messages = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = (body: Json) => options.send({ jsonrpc: "2.0", ...body });
  const request = (method: string, params: Json) => new Promise<Json>((resolvePromise) => {
    const id = nextId++;
    waiting.set(id, resolvePromise);
    frame({ id, method, params });
  });
  const errorText = (reply: Json) => isRecord(reply.error) ? text(reply.error.message, 600) ?? "The CLI reported an error." : "The CLI reported an error.";

  const turn = (state: "completed" | "failed", error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    options.emit({ type: "turn", state, ...(error ? { error } : {}) });
  };
  const flush = () => {
    if (!reply.trim()) { reply = ""; return; }
    options.emit({ type: "message", id: `acp-message-${messages++}`, text: reply.slice(0, LIVE_CLI_LIMITS.message) });
    reply = "";
  };

  function toolEvents(id: string, update: Json): ExecEvent[] {
    const known = tools.get(id);
    const kind = text(update.kind, 40) ?? known?.kind ?? "other";
    const title = text(update.title, 300) ?? known?.title ?? "tool";
    const raw = parsedInput(update.rawInput);
    const files: ExecFile[] = [...(known?.files ?? [])];
    const addFile = (path: string | undefined, created: boolean) => {
      if (!path || files.some((file) => file.path === path)) return;
      files.push({ path: path.slice(0, 2_048), kind: kind === "delete" ? "delete" : created ? "create" : fileKinds[kind] ?? "update" });
    };
    const output: string[] = [];
    for (const entry of Array.isArray(update.content) ? update.content.slice(0, 64) : []) {
      if (!isRecord(entry)) continue;
      if (entry.type === "diff" && typeof entry.path === "string") addFile(entry.path, entry.oldText === null || entry.oldText === undefined);
      else if (entry.type === "content" && isRecord(entry.content) && typeof entry.content.text === "string") output.push(entry.content.text);
    }
    if (fileKinds[kind] || kind === "delete") for (const location of Array.isArray(update.locations) ? update.locations.slice(0, 64) : []) {
      addFile(isRecord(location) ? text(location.path, 2_048) : undefined, false);
    }
    const rawCommand = raw?.command ?? raw?.cmd;
    const command = known?.command ?? (typeof rawCommand === "string" ? rawCommand : kind === "execute" ? title : undefined);
    if (tools.size < 5_000 || known) tools.set(id, { kind, title, files, ...(command ? { command } : {}) });
    const status = text(update.status, 20);
    const state = (status && toolStates[status]) || "running";
    if (kind === "execute") {
      const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
      const printed = output.join("\n") || text(update.rawOutput, LIVE_CLI_LIMITS.commandOutput) || text(rawOutput?.output, LIVE_CLI_LIMITS.commandOutput) || text(rawOutput?.stdout, LIVE_CLI_LIMITS.commandOutput);
      return [{ type: "command", id, command: command ?? "", state, ...(state !== "running" && printed ? { output: printed.slice(-LIVE_CLI_LIMITS.commandOutput) } : {}) }];
    }
    if (fileKinds[kind] || kind === "delete") return [{ type: "files", id, files, state }];
    return [{ type: "tool", id, name: title.slice(0, 120), detail: text(raw?.path, 300) ?? text(raw?.file_path, 300) ?? text(raw?.pattern, 300) ?? text(raw?.query, 300) ?? text(raw?.url, 300), state }];
  }

  function onUpdate(update: Json) {
    const kind = text(update.sessionUpdate, 60);
    if (kind === "agent_message_chunk") {
      const content = update.content;
      if (isRecord(content) && content.type === "text" && typeof content.text === "string" && reply.length < LIVE_CLI_LIMITS.message) {
        reply += content.text;
        options.emit({ type: "delta", id: "stream", text: content.text });
      }
      return;
    }
    if (kind === "agent_thought_chunk" || kind === "user_message_chunk") return;
    flush();
    const id = text(update.toolCallId, 200);
    if ((kind === "tool_call" || kind === "tool_call_update") && id) for (const event of toolEvents(id, update)) options.emit(event);
  }

  function answer(id: unknown, params: unknown) {
    const controller = new AbortController();
    pendingApprovals.add(controller);
    const signal = AbortSignal.any([options.signal, controller.signal]);
    approvals = approvals.then(async () => {
      const decision = classifyAcpPermission(params, { cwd: options.cwd, plan: options.plan });
      let allowed = decision.verdict === "allow";
      if (!finished && !signal.aborted && (decision.verdict === "ask" || decision.verdict === "refuse") && options.approve && options.plan.approvals === "card") {
        try { allowed = (await options.approve(decision.approval, signal)) && decision.verdict === "ask" && !!decision.allowOption; } catch { allowed = false; }
      }
      pendingApprovals.delete(controller);
      if (controller.signal.aborted && !options.signal.aborted) return;
      const chosen = allowed ? decision.allowOption : decision.rejectOption;
      frame({ id, result: { outcome: chosen ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" } } });
    });
  }

  async function selectMode(created: Json) {
    const modes = isRecord(created.modes) ? created.modes : undefined;
    const current = text(modes?.currentModeId, 80);
    const available = Array.isArray(modes?.availableModes)
      ? modes.availableModes.flatMap((mode) => (isRecord(mode) && typeof mode.id === "string" ? [mode.id] : [])) : [];
    const unsafe = current !== undefined && unsafeMode.test(current);
    // Read only prefers the CLI's own plan mode; a mode that approves on its own is never kept.
    const target = options.plan.grants === "read_only" && available.includes("plan") ? "plan" : unsafe ? safeModes.find((id) => available.includes(id)) : undefined;
    const refusal = new Error(`The CLI started in "${current}" mode, which approves actions on its own, and Tomverse Desktop could not switch it off.`);
    if (unsafe && !target) throw refusal;
    if (!target || target === current) return;
    const switched = await request("session/set_mode", { sessionId, modeId: target });
    if (switched.error && unsafe) throw refusal;
  }

  async function drive() {
    const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "tomverse-desktop", title: "Tomverse Desktop", version: options.clientVersion ?? "0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const info = isRecord(initialized.result) ? initialized.result : undefined;
    if (!info || initialized.error || info.protocolVersion !== 1) throw new Error(initialized.error ? errorText(initialized) : "The CLI did not answer as an ACP agent (protocol version 1).");
    const created = await request("session/new", { cwd: options.cwd, mcpServers: [] });
    const session = isRecord(created.result) ? created.result : undefined;
    if (created.error || !session || typeof session.sessionId !== "string" || !session.sessionId) {
      const code = isRecord(created.error) ? created.error.code : undefined;
      throw new Error(code === -32000 ? "The CLI is not signed in. Sign in with the CLI itself, then try again." : created.error ? errorText(created) : "The CLI did not start a session.");
    }
    sessionId = session.sessionId.slice(0, 200);
    options.emit({ type: "session", id: sessionId });
    await selectMode(session);
    clearTimeout(timer);
    prompted = true;
    const done = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] });
    flush();
    if (done.error) return turn("failed", errorText(done));
    const stop = isRecord(done.result) ? text(done.result.stopReason, 40) : undefined;
    if (stop === "end_turn") return turn("completed");
    turn("failed", stop === "cancelled" ? "The CLI ended the task." : stop === "refusal" ? "The model refused the task." : stop === "max_tokens" ? "The model reached its output limit."
      : stop === "max_turn_requests" ? "The CLI reached its request limit for one task." : "The CLI ended the task without a result.");
  }

  return {
    /** Starts the handshake, the session and the prompt. */
    start() {
      timer = setTimeout(() => turn("failed", "The CLI did not complete the ACP handshake."), options.handshakeMs ?? ACP_HANDSHAKE_MS);
      timer.unref?.();
      drive().catch((error: unknown) => turn("failed", error instanceof Error ? error.message.slice(0, 600) : "The CLI failed."));
    },
    /** One frame the CLI printed. */
    handle(message: Json) {
      const method = typeof message.method === "string" ? message.method : undefined;
      const hasId = typeof message.id === "number" || typeof message.id === "string";
      if (!method) {
        const resolveReply = typeof message.id === "number" ? waiting.get(message.id) : undefined;
        if (resolveReply && typeof message.id === "number") { waiting.delete(message.id); resolveReply(message); }
        return;
      }
      if (!hasId) {
        if (method === "session/update" && isRecord(message.params) && message.params.sessionId === sessionId && isRecord(message.params.update) && !finished) onUpdate(message.params.update);
        return;
      }
      if (method === "session/request_permission" && isRecord(message.params) && message.params.sessionId === sessionId) answer(message.id, message.params);
      else if (method === "session/request_permission") frame({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
      // fs, terminal and every other request: this client offers none of them.
      else frame({ id: message.id, error: { code: -32601, message: "Tomverse Desktop does not offer this method." } });
    },
    prompted: () => prompted,
    /** Cancels the questions nobody can answer any more. */
    cancelPending() { for (const controller of pendingApprovals) controller.abort(); },
    /** Resolves when every answer in flight has been sent. */
    idle: () => approvals.catch(() => undefined),
    dispose() { clearTimeout(timer); },
  };
}
