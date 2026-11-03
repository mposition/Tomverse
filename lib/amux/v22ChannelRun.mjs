import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { amuxSubscriptionCliUsageObservation, createCodexCliUsageObserver } from
  "./cliUsageObservationCore.ts";
import { AMUX_V19_COPILOT_TOKEN, inspectAmuxV19ChannelAuth } from
  "./ideaV19CliChannelHost.mjs";

/**
 * The v22 one-shot run for a non-Claude provider (owner decision 2026-10-26).
 * The sidecar spawns the CLI as it spawns Claude: the prompt on stdin, the
 * worker's own checkout as cwd, and the role's tools fixed by flags. The
 * output is then checked against the same list, so a tool outside it makes
 * the run unknown rather than trusted.
 *
 * - Copilot: an explicit tool list, as Claude's --tools (no shell).
 * - Cursor: read roles only, in --mode ask. Its print mode has shell access
 *   once it may write, so implement is not offered (AMUX_V22_PROVIDERS).
 * - Codex reads files only through its shell. Owner decision 2026-10-26:
 *   that shell runs inside Codex's own OS sandbox -- read-only for a read
 *   role (measured: no write, no network), the checkout only and no network
 *   for implement -- with the
 *   browser, computer-use, app and web-search tools turned off and no MCP
 *   server. This is wider than Claude's no-shell boundary, on purpose.
 *   Measured on the runner (Codex 0.160, no model call): with the overrides
 *   below a workspace-write shell writes the checkout and nothing else --
 *   not /tmp, not a writable_roots entry from CODEX_HOME, not CODEX_HOME --
 *   and reaches no network; without them /tmp and those roots were open.
 *
 * The flags and output shapes are the ones measured for the v19 channels
 * (lib/amux/ideaV19CliChannels.mjs, ideaV19CliChannelOutput.mjs).
 */

const READ_ONLY_ROLES = new Set(["design", "investigate", "review"]);
const COPILOT_READ_TOOLS = ["view", "glob", "grep"];
const COPILOT_WRITE_TOOLS = ["edit", "create"];
// Cursor's read-only file tools in --mode ask (measured for v19).
const CURSOR_READ_TOOLS = new Set(["readToolCall", "globToolCall", "grepToolCall",
  "lsToolCall"]);
const CODEX_ITEMS = new Set(["agent_message", "reasoning", "command_execution",
  "file_change", "todo_list"]);
const CODEX_DISABLED = ["browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "in_app_browser", "apps"];

/** Stream output carries tool events; bounded well above any useful run. */
export const AMUX_V22_CHANNEL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function amuxV22ChannelArgs(provider, request, worktreePath) {
  const write = !READ_ONLY_ROLES.has(request.role);
  switch (provider) {
    // The global flags and the two ignores are the Decision Maker launcher's
    // (docs/policy/amux-decision-maker.md): never ask for approval, no daemon,
    // and neither CODEX_HOME/config.toml (its MCP servers and writable roots)
    // nor user or project execpolicy .rules (an allow rule there would run a
    // command outside the sandbox) is read. Sign-in still comes from CODEX_HOME.
    case "openai": return ["-a", "never", "--no-daemon", "exec", "--json",
      "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--sandbox", write ? "workspace-write" : "read-only",
      ...CODEX_DISABLED.flatMap((feature) => ["--disable", feature]),
      "-c", "sandbox_workspace_write.writable_roots=[]",
      "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c", "sandbox_workspace_write.network_access=false",
      "-c", 'web_search="disabled"',
      "-m", request.modelId, "-"];
    case "github-copilot": return ["--output-format", "json",
      "--model", request.modelId, "--available-tools",
      ...COPILOT_READ_TOOLS, ...(write ? COPILOT_WRITE_TOOLS : []),
      "--allow-all-tools", "--no-ask-user", "--no-custom-instructions",
      "--no-auto-update", "--no-color", "--disable-builtin-mcps"];
    case "cursor":
      if (write) throw new TypeError("cursor takes read roles only");
      return ["-p", "--output-format", "stream-json", "--mode", "ask", "--trust",
        "--workspace", worktreePath, "--model", request.modelId];
    default: throw new TypeError("unsupported v22 provider");
  }
}

/**
 * A CLI acts on more than its flags: MCP servers, hooks, execpolicy rules and
 * plugins named in its user or project configuration run before any tool
 * event could be refused. So a non-Claude run never sees a user
 * configuration -- it gets a fresh home holding only its sign-in
 * (createAmuxV22ChannelRunHome) -- and is refused before the CLI starts
 * while the checkout carries that CLI's project configuration. Copilot's
 * project sources are the ones `copilot mcp --help` lists (measured
 * 2026-10-26, Copilot 1.0.94) and its hooks directory; Cursor's is all of
 * .cursor/. Null when the run may start.
 */
const PROJECT_CONFIGS = {
  openai: [[".codex", "config.toml"]],
  "github-copilot": [[".mcp.json"], [".github", "mcp.json"], [".github", "hooks"]],
  cursor: [[".cursor"]],
};
export function amuxV22ChannelPreflight(provider, config, { exists = existsSync } = {}) {
  const paths = PROJECT_CONFIGS[provider];
  if (!paths) return "unsupported_provider";
  return paths.some((parts) => exists(join(config.worktreePath, ...parts))) ?
    "project_cli_config_present" : null;
}

/** The sign-in a CLI needs, read from the sidecar's config dir. Copilot's
 * GitHub token (`auth-token`, the one the v19 channel measured working)
 * travels in its environment instead of the run home. */
const AUTH_FILES = {
  openai: ["auth.json", "codex/auth.json"],
  "github-copilot": ["auth-token", null],
  cursor: ["cursor/auth.json", ".config/cursor/auth.json"],
};
const MAX_AUTH_BYTES = 64 * 1024;

/** A sign-in the run must not use; the sidecar refuses before the CLI starts. */
export class AmuxV22ChannelAuthRefused extends Error {}

/**
 * A fresh home under the sidecar's own, removed after the run: the CLI reads
 * no user configuration, hook or plugin that was there before. Its sign-in is
 * the v19 channel's cut-down copy (inspectAmuxV19ChannelAuth), never the
 * file as found: no refresh secret, and refused when the access token expires
 * within six hours or a Codex login was last refreshed over seven days ago.
 * A run that refreshed with the operator's refresh token would rotate it and
 * sign out every other use of the same login on the box (the v19 channels,
 * the operator's shell).
 */
export async function createAmuxV22ChannelRunHome(provider, config,
  { now = Date.now(), fsOps = { mkdtemp, mkdir, readFile, writeFile, rm } } = {}) {
  const auth = AUTH_FILES[provider];
  if (!auth) throw new TypeError("unsupported v22 provider");
  const [from, to] = auth;
  const bytes = await fsOps.readFile(join(config.claudeConfigDir, from));
  let copy = null;
  let copilotToken = null;
  try {
    if (bytes.length > MAX_AUTH_BYTES) throw new AmuxV22ChannelAuthRefused();
    if (provider === "github-copilot") {
      copilotToken = bytes.toString("utf8").trim();
      if (!AMUX_V19_COPILOT_TOKEN.test(copilotToken)) throw new AmuxV22ChannelAuthRefused();
    } else {
      try { copy = inspectAmuxV19ChannelAuth(provider, bytes, now).copy; }
      catch { throw new AmuxV22ChannelAuthRefused(); }
    }
  } finally { bytes.fill(0); }
  try {
    const root = await fsOps.mkdtemp(join(config.homePath, "run-"));
    const cleanup = () => fsOps.rm(root, { recursive: true, force: true });
    try {
      if (copy) {
        await fsOps.mkdir(dirname(join(root, to)), { recursive: true, mode: 0o700 });
        await fsOps.writeFile(join(root, to), copy, { flag: "wx", mode: 0o600 });
      }
      return { config: { ...config, homePath: root,
        claudeConfigDir: provider === "openai" ? join(root, "codex") : join(root, ".config") },
      cleanup, copilotToken };
    } catch (error) { await cleanup().catch(() => {}); throw error; }
  } finally { copy?.fill(0); }
}

/** The CLI's own config directory comes from the run home; Copilot's token,
 * checked by createAmuxV22ChannelRunHome, goes in COPILOT_GITHUB_TOKEN only. */
export function amuxV22ChannelEnv(provider, config, { copilotToken = null } = {}) {
  const env = { HOME: config.homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  if (provider === "openai") env.CODEX_HOME = config.claudeConfigDir;
  else env.XDG_CONFIG_HOME = config.claudeConfigDir;
  if (provider === "github-copilot" && copilotToken) env.COPILOT_GITHUB_TOKEN = copilotToken;
  return env;
}

const lines = (output) => output.split("\n").filter((line) => line.trim() !== "")
  .map((line) => { try { return JSON.parse(line); } catch { return null; } });
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * What one finished run says: whether it succeeded, the final answer, and its
 * usage observation. Any line that is not a JSON object, a tool outside the
 * role's list, or a stream without the CLI's terminal event makes the run
 * unknown rather than guessed (as an unparsable Claude result is).
 */
export function parseAmuxV22ChannelOutput(provider, output, { exitCode, role }) {
  const events = lines(output);
  if (events.length === 0 || events.some((event) => !object(event)))
    return { valid: false };
  if (provider === "openai") {
    const usage = createCodexCliUsageObserver();
    let answer = null;
    let failed = false;
    for (const line of output.split("\n")) if (line.trim() !== "") usage.observeLine(line);
    for (const event of events) {
      if (typeof event.type === "string" && event.type.startsWith("item.") &&
          !CODEX_ITEMS.has(event.item?.type)) return { valid: false };
      if (event.type === "turn.failed" || event.type === "error") failed = true;
      if (event.type === "item.completed" && event.item?.type === "agent_message" &&
          typeof event.item.text === "string") answer = event.item.text;
    }
    if (!events.some((event) => event.type === "turn.completed" ||
      event.type === "turn.failed")) return { valid: false };
    const observation = usage.finish({ exitCode, stdoutComplete: true,
      freshEphemeralSession: true });
    return { valid: true, success: exitCode === 0 && !failed && answer !== null,
      resultText: answer, observation };
  }
  if (provider === "github-copilot") {
    const tools = new Set([...COPILOT_READ_TOOLS,
      ...(READ_ONLY_ROLES.has(role) ? [] : COPILOT_WRITE_TOOLS)]);
    let answer = null;
    let result = null;
    let counts = null;
    let calls = 0;
    const served = new Set();
    for (const event of events) {
      const data = event.data;
      if (event.type === "tool.execution_start" && !tools.has(data?.toolName))
        return { valid: false };
      if (event.type === "assistant.message" && Array.isArray(data?.toolRequests) &&
          data.toolRequests.some((request) => !tools.has(request?.name)))
        return { valid: false };
      for (const model of [data?.model, ...(Array.isArray(data?.providerModelMetrics) ?
        data.providerModelMetrics.map((metric) => metric?.modelId) : [])])
        if (typeof model === "string") served.add(model);
      if (event.type === "result") result = event;
      if (event.type === "model.call_final_result" && data?.result === "success") calls += 1;
      if (event.type === "assistant.message" && Array.isArray(data?.toolRequests))
        answer = data.toolRequests.length === 0 && typeof data.content === "string" ?
          data.content : answer;
      if (event.type === "session.usage_checkpoint" && Array.isArray(data?.providerModelMetrics)) {
        // Checkpoints are cumulative for the session; the last one counts.
        counts = data.providerModelMetrics.reduce((sum, metric) => {
          const usage = metric?.metrics?.usage;
          return sum && usage ? { inputTokens: sum.inputTokens + usage.inputTokens,
            outputTokens: sum.outputTokens + usage.outputTokens, cacheReadTokens: 0,
            cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWriteTokens } : null;
        }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      }
    }
    if (result === null) return { valid: false };
    const success = exitCode === 0 && result.exitCode === 0 &&
      typeof answer === "string" && answer.trim() !== "";
    // Copilot names the model on every call. The served one is recorded as
    // reported, so a fallback to another model cannot settle (v22 settlement
    // compares it with the selected model).
    const servedModelId = served.size === 1 ? [...served][0] :
      served.size > 1 ? "multi_model" : null;
    return { valid: true, success, resultText: answer,
      observation: amuxSubscriptionCliUsageObservation("copilot", { counts,
        servedModelId, completedTurns: calls, complete: success }) };
  }
  if (provider === "cursor") {
    let finalText = [];
    let result = null;
    let turns = 0;
    for (const event of events) {
      if (event.type === "tool_call") {
        const names = object(event.tool_call) ? Object.keys(event.tool_call)
          .filter((key) => key.endsWith("ToolCall")) : [];
        if (names.length !== 1 || !CURSOR_READ_TOOLS.has(names[0])) return { valid: false };
        finalText = [];
      }
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        turns += 1;
        for (const block of event.message.content)
          if (block?.type === "text" && typeof block.text === "string") finalText.push(block.text);
      }
      if (event.type === "result") result = event;
    }
    if (result === null) return { valid: false };
    const success = exitCode === 0 && result.subtype === "success" &&
      result.is_error === false;
    // `result` joins every assistant text of the run; the answer is the text
    // after the last tool call (measured for v19).
    const answer = success ? finalText.join("") : null;
    const usage = result.usage;
    return { valid: true, success: success && answer.trim() !== "", resultText: answer,
      observation: amuxSubscriptionCliUsageObservation("cursor", {
        counts: object(usage) ? { inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens } : null,
        servedModelId: null, completedTurns: turns, complete: success }) };
  }
  return { valid: false };
}
