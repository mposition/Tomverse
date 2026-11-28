import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { amuxSubscriptionCliUsageObservation, createCodexCliUsageObserver } from
  "./cliUsageObservationCore.ts";
import { AMUX_V19_COPILOT_TOKEN, inspectAmuxV19ChannelAuth } from
  "./ideaV19CliChannelHost.mjs";
import { fileURLToPath } from "node:url";

import { AMUX_V22_QWEN_CODING_PLAN_KEY, inspectAmuxV22AntigravityAuth, inspectAmuxV22KimiAuth } from
  "./v22WorkerAuthStage.mjs";
import { amuxV22KimiToolInputRefusal } from "./v22KimiToolGuard.mjs";
import { amuxCliUnknownKindActs, createAmuxCliUnknownKindLog } from
  "./cliStreamUnknownKind.mjs";

/**
 * The v22 one-shot run for a non-Claude provider (owner decision 2026-10-26).
 * The sidecar spawns the CLI as it spawns Claude: the prompt on stdin, the
 * worker's own checkout as cwd, and the role's tools fixed by flags. The
 * output is then checked against the same list, so a tool outside it makes
 * the run unknown rather than trusted.
 *
 * - Copilot: an explicit tool list, as Claude's --tools. Implement also has
 *   its shell tools (owner request 2026-11-09); the sidecar runs that shell
 *   in the no-network, checkout-only jail of v22ShellJail.mjs, found first on
 *   PATH, and the shell receives none of the CLI's environment.
 * - Cursor: read roles only, in --mode ask. Its print mode has shell access
 *   once it may write, so implement is not offered (AMUX_V22_PROVIDERS).
 * - Antigravity (owner decision 2026-11-10): the role's tools are a custom
 *   agent the run home holds (amuxV22AntigravityAgent), the only list agy
 *   applies before a tool runs (a permission deny did not stop `search_web`,
 *   measured on agy 1.5.4). The session settings deny commands and writes to
 *   a read role and every URL and MCP action to all roles; implement may run
 *   any command and write the checkout, and the sidecar runs that shell in
 *   the same jail as Copilot's: agy finds `bash` on PATH and ignores SHELL.
 * - Kimi Code CLI (owner request 2026-11-28): read roles only, like Cursor.
 *   `--print` approves every tool call, its file tools read any absolute path
 *   and its Shell runs unsandboxed, so implement is not offered. The role's
 *   tools are a custom agent file in the run home that lists ReadFile, Glob
 *   and Grep only (`tools` replaces the default agent's list). Before a tool
 *   runs, a PreToolUse hook (v22KimiToolGuard.mjs) blocks any other tool and
 *   any path that resolves outside the checkout, symlinks included, and logs
 *   each decision; the parser refuses the same calls again and a run with a
 *   tool call the hook did not decide (Kimi's hooks fail open). The
 *   configuration comes from `--config`, so no user config.toml (and no hook
 *   in it) is read, and the stream's own usage is absent, so the tokens come
 *   from the session's wire.jsonl in the run home (readAmuxV22KimiSessionUsage).
 * - Qwen Code CLI (the same request): read roles only. Its read tools check
 *   the workspace through realpath and ask for a path outside it, and a
 *   headless run refuses every ask; its write tools' boundary is not
 *   documented, and an allowed shell or write in headless mode has no check
 *   left, so implement is not offered. A read role runs in --approval-mode
 *   plan with --core-tools read_file, glob and grep_search, --safe-mode (no
 *   context file, hook, extension, skill, MCP server or permission rule) and
 *   no extension; the parser refuses a stream whose init is not in plan mode,
 *   any other tool, a subagent's message, and any path outside the checkout.
 * - Codex reads files only through its shell. Owner decision 2026-10-26:
 *   that shell runs inside Codex's own OS sandbox -- read-only for a read
 *   role (measured: no write, no network), the checkout only and no network
 *   for implement -- with the
 *   browser, computer-use, app and web-search tools turned off and no MCP
 *   server. Claude's and Copilot's implement shell has the same boundary.
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
// The shell tools Copilot 1.0.94 lists (measured 2026-11-09; there is no
// write_bash in prompt mode). Implement also has the file tools that write.
const COPILOT_SHELL_TOOLS = ["bash", "read_bash", "stop_bash", "list_bash"];
const COPILOT_WRITE_TOOLS = ["edit", "create", ...COPILOT_SHELL_TOOLS];
/**
 * The local CLI flow (owner decision 2026-11-15, v22LocalCliFlowCore.ts):
 * a read role has the same jailed shell as implement, so it can run tests,
 * but none of the file tools that write. Cursor's shell cannot be jailed, so
 * Cursor keeps its read-only ask mode.
 */
const copilotTools = (role, readRoleShell) => [...COPILOT_READ_TOOLS,
  ...(!READ_ONLY_ROLES.has(role) ? COPILOT_WRITE_TOOLS :
    readRoleShell ? COPILOT_SHELL_TOOLS : [])];
// Antigravity's tools by role: the names a custom agent lists, and the
// canonical names its stream reports for them (agy 1.5.4, measured
// 2026-11-10). grep_search, list_dir and find_by_name are not registered in
// this version, so a read role reads files only; implement searches and
// lists through its jailed shell.
const ANTIGRAVITY_READ_AGENT_TOOLS = ["view_file"];
const ANTIGRAVITY_WRITE_AGENT_TOOLS = ["write_to_file", "replace_file_content",
  "multi_replace_file_content", "run_command"];
const ANTIGRAVITY_READ_TOOLS = ["read_file"];
const ANTIGRAVITY_WRITE_TOOLS = ["write_file", "edit_file", "run_command"];
const ANTIGRAVITY_STEPS = new Set(["user_input", "agent_response", "tool", "checkpoint"]);
const ANTIGRAVITY_EVENTS = new Set(["init", "step_update", "result"]);
// Kimi Code CLI's read tools: the agent file's entries (kimi_cli
// agents/default/agent.yaml names them so) and the names its stream reports.
const KIMI_AGENT_TOOLS = ["kimi_cli.tools.file:ReadFile", "kimi_cli.tools.file:Glob",
  "kimi_cli.tools.file:Grep"];
// The Kimi Code platform as kimi_cli writes it after /login: platform
// "kimi-code", managed provider "managed:kimi-code", OAuth key
// "oauth/kimi-code", base URL https://api.kimi.com/coding/v1.
const KIMI_PROVIDER_KEY = "managed:kimi-code";
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_MAX_CONTEXT = 262_144;
const KIMI_AGENT_FILE = [".amux-v22", "kimi-read.yaml"];
const KIMI_SKILLS_DIR = [".amux-v22", "skills"];
const KIMI_GUARD_LOG = [".amux-v22", "kimi-guard.log"];
const KIMI_GUARD_SCRIPT = fileURLToPath(new URL("./v22KimiToolGuard.mjs", import.meta.url));
// The hook is small; a slow one times out, and Kimi then allows the call,
// which the decision count refuses afterwards.
const KIMI_GUARD_TIMEOUT_SECONDS = 15;
// Qwen Code CLI's read tools (core/src/tools/tool-names.ts) and the tools a
// read role excludes besides (`--core-tools` alone already keeps them out).
const QWEN_READ_TOOLS = ["read_file", "glob", "grep_search"];
const QWEN_EXCLUDED_TOOLS = ["run_shell_command", "edit", "write_file", "web_fetch",
  "web_search", "agent", "skill", "save_memory", "todo_write", "notebook_edit", "monitor",
  "lsp", "list_directory"];
// The Coding Plan's international OpenAI-compatible endpoint (Qwen Code docs;
// the China (Beijing) endpoint is outside this company's scope).
const QWEN_CODING_PLAN_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const QWEN_EVENTS = new Set(["system", "assistant", "user", "result"]);
// Cursor's read-only file tools in --mode ask (measured for v19).
const CURSOR_READ_TOOLS = new Set(["readToolCall", "globToolCall", "grepToolCall",
  "lsToolCall"]);
const CODEX_ITEMS = new Set(["agent_message", "reasoning", "command_execution",
  "file_change", "todo_list"]);
// Codex's top-level events (measured on the box's worker transcripts,
// 2026-11-21: thread.started, turn.started, turn.completed; the failure ones
// are Codex's documented terminal events).
const CODEX_EVENTS = new Set(["thread.started", "turn.started", "turn.completed",
  "turn.failed", "error"]);
// Copilot's events seen on the box's worker transcripts (Copilot 1.0.94,
// 2026-11-21). Copilot runs a tool only as tool.execution_start with
// data.toolName (81 starts, every one named). A tool named on any event is
// held to the role's list; an event outside this list is counted, and refused
// when its name or a key names an action (cliStreamUnknownKind.mjs).
const COPILOT_EVENTS = new Set(["assistant.idle", "assistant.message",
  "assistant.message_delta", "assistant.message_start", "assistant.reasoning",
  "assistant.reasoning_delta", "assistant.tool_call_delta", "assistant.turn_end",
  "assistant.turn_start", "model.call_final_result", "model.call_finished",
  "model.call_start", "prompt_cache_break", "result", "session.background_tasks_changed",
  "session.info", "session.mcp_servers_loaded", "session.tools_updated",
  "session.usage_checkpoint", "tool.execution_complete", "tool.execution_partial_result",
  "tool.execution_start", "tool.shell_output", "user.message"]);
// Cursor's events (measured for v19, ideaV19CliChannelOutput.mjs). Cursor
// names a tool only as a `<name>ToolCall` key.
const CURSOR_EVENTS = new Set(["system", "user", "assistant", "thinking", "tool_call",
  "result"]);
const CODEX_DISABLED = ["browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "in_app_browser", "apps"];

/** Stream output carries tool events; bounded well above any useful run. */
export const AMUX_V22_CHANNEL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function amuxV22ChannelArgs(provider, request, worktreePath,
  { readRoleShell = false, runHomePath = null, kimiGuard = null } = {}) {
  const write = !READ_ONLY_ROLES.has(request.role);
  // Codex's shell is its sandbox: a read role in the local CLI flow runs it
  // workspace-write (no network, the checkout only) so tests can write their
  // caches; the sidecar reports a read role's change instead of publishing it.
  const codexWrite = write || readRoleShell;
  switch (provider) {
    // The global flags and the two ignores are the Decision Maker launcher's
    // (docs/policy/amux-decision-maker.md): never ask for approval, no daemon,
    // and neither CODEX_HOME/config.toml (its MCP servers and writable roots)
    // nor user or project execpolicy .rules (an allow rule there would run a
    // command outside the sandbox) is read. Sign-in still comes from CODEX_HOME.
    case "openai": return ["-a", "never", "--no-daemon", "exec", "--json",
      "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--sandbox", codexWrite ? "workspace-write" : "read-only",
      ...CODEX_DISABLED.flatMap((feature) => ["--disable", feature]),
      "-c", "sandbox_workspace_write.writable_roots=[]",
      "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c", "sandbox_workspace_write.network_access=false",
      "-c", 'web_search="disabled"',
      "-m", request.modelId, "-"];
    case "github-copilot": return ["--output-format", "json",
      "--model", request.modelId, "--available-tools",
      ...copilotTools(request.role, readRoleShell),
      "--allow-all-tools", "--no-ask-user", "--no-custom-instructions",
      "--no-auto-update", "--no-color", "--disable-builtin-mcps"];
    case "cursor":
      if (write) throw new TypeError("cursor takes read roles only");
      return ["-p", "--output-format", "stream-json", "--mode", "ask", "--trust",
        "--workspace", worktreePath, "--model", request.modelId];
    // The prompt is the one NDJSON line on stdin (amuxV22ChannelStdin): a
    // prompt on the command line would sit in /proc and in argv's size limit.
    // `-p ""` turns print mode on without one.
    // The prompt is stdin's text; `--print` reads it to EOF. The skills
    // directory is an empty one in the run home: it replaces the project's
    // .claude/skills and the like, which name tools this role does not have.
    case "kimi": {
      if (write) throw new TypeError("kimi takes read roles only");
      const home = amuxV22SafeAbsolutePath(runHomePath);
      const checkout = amuxV22SafeAbsolutePath(worktreePath);
      const hookCommand = amuxV22KimiHookCommand({
        nodePath: kimiGuard?.nodePath ?? process.execPath,
        guardPath: kimiGuard?.guardPath ?? KIMI_GUARD_SCRIPT,
        worktreePath: checkout, logPath: posix.join(home, ...KIMI_GUARD_LOG) });
      return ["--print", "--input-format", "text", "--output-format", "stream-json",
        "--work-dir", checkout,
        "--agent-file", posix.join(home, ...KIMI_AGENT_FILE),
        "--skills-dir", posix.join(home, ...KIMI_SKILLS_DIR),
        "--config", JSON.stringify(amuxV22KimiConfig(request.modelId, { hookCommand }))];
    }
    // The prompt is stdin's text: with no positional prompt and a piped
    // stdin the CLI runs once (utils/interactive-mode.ts). The array options
    // come last; each takes the words after it.
    case "qwen":
      if (write) throw new TypeError("qwen takes read roles only");
      return ["--output-format", "stream-json", "--input-format", "text",
        "--approval-mode", "plan", "--auth-type", "openai", "--safe-mode",
        "--model", request.modelId, "--extensions", "none",
        "--core-tools", ...QWEN_READ_TOOLS, "--exclude-tools", ...QWEN_EXCLUDED_TOOLS];
    case "antigravity": return ["-p", "", "--input-format", "stream-json",
      "--output-format", "stream-json", "--model", request.modelId,
      "--agent", amuxV22AntigravityAgentName(request.role), "--disable-slash-commands",
      "--settings", JSON.stringify(amuxV22AntigravitySettings(write, worktreePath,
        { shell: write || readRoleShell }))];
    default: throw new TypeError("unsupported v22 provider");
  }
}

const amuxV22SafeAbsolutePath = (path) => {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(path) ||
      path.split("/").includes(".."))
    throw new TypeError("unsafe path");
  return path;
};

/** Where the box keeps the root-owned CLI installs (v22-worker-catalog.md). */
export const AMUX_V22_CLI_INSTALL_ROOT = "/opt/tomverse-amux-v22";
export const AMUX_V22_BWRAP = "/usr/bin/bwrap";

/**
 * The bubblewrap view a Kimi run gets: the fail-closed boundary its tool
 * guard (a hook Kimi treats as "allow" when it fails) cannot be. The CLI keeps
 * the network (it calls Kimi Code) but sees only the system's /usr and /etc,
 * the root-owned CLI installs, the guard's node and script, the checkout
 * read-only and its own run home; the sidecar's sign-in directory, journal,
 * other workers' state and everything else on the box are not in it, so a
 * read outside the checkout finds nothing even when the hook did not run.
 * There is no Shell tool in a read role, so no jail has to nest inside this
 * one (v22ShellJail.mjs: bwrap cannot nest on the box). No /proc: the unit
 * refuses a fresh one, and the unit's own would show the CLI's environment.
 * Throws on any path that is not a fixed absolute one, or a CLI outside the
 * install root.
 */
export function amuxV22KimiSandboxArgs({ worktreePath, runHomePath, binaryPath,
  nodePath = process.execPath, guardPath = KIMI_GUARD_SCRIPT }) {
  for (const path of [worktreePath, runHomePath, binaryPath, nodePath, guardPath])
    amuxV22SafeAbsolutePath(path);
  if (!binaryPath.startsWith(`${AMUX_V22_CLI_INSTALL_ROOT}/`))
    throw new TypeError("kimi must run from the root-owned install");
  const outside = (path, root) => path !== root && !path.startsWith(`${root}/`) &&
    !root.startsWith(`${path}/`);
  if (!outside(worktreePath, runHomePath)) throw new TypeError("checkout and run home overlap");
  return ["--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-uts",
    "--unshare-cgroup", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/sbin", "/sbin", "--ro-bind", "/etc", "/etc",
    "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", AMUX_V22_CLI_INSTALL_ROOT, AMUX_V22_CLI_INSTALL_ROOT,
    "--ro-bind", nodePath, nodePath, "--ro-bind", guardPath, guardPath,
    "--ro-bind", worktreePath, worktreePath,
    "--bind", runHomePath, runHomePath,
    "--remount-ro", "/", "--chdir", worktreePath, "--"];
}

/** The hook's shell command (kimi_cli runs it through a shell): every part a
 * fixed absolute path, single-quoted. */
export function amuxV22KimiHookCommand({ nodePath, guardPath, worktreePath, logPath }) {
  return [nodePath, guardPath, worktreePath, logPath]
    .map((part) => `'${amuxV22SafeAbsolutePath(part)}'`).join(" ");
}

/** Kimi's whole configuration for one run (`--config`, so ~/.kimi/config.toml
 * and any hook in it is never read): the Kimi Code platform signed in by the
 * copied OAuth token, the route's model, and the tool guard as the one hook. */
export function amuxV22KimiConfig(modelId, { hookCommand } = {}) {
  if (typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(modelId))
    throw new TypeError("unsafe model");
  if (typeof hookCommand !== "string" || hookCommand === "")
    throw new TypeError("kimi needs its tool guard");
  const modelKey = `kimi-code/${modelId}`;
  return { default_model: modelKey,
    providers: { [KIMI_PROVIDER_KEY]: { type: "kimi", base_url: KIMI_BASE_URL, api_key: "",
      oauth: { storage: "file", key: "oauth/kimi-code" } } },
    models: { [modelKey]: { provider: KIMI_PROVIDER_KEY, model: modelId,
      max_context_size: KIMI_MAX_CONTEXT } },
    hooks: [{ event: "PreToolUse", command: hookCommand,
      timeout: KIMI_GUARD_TIMEOUT_SECONDS }] };
}

/** The read role's agent file: the default agent with only the read tools
 * (`tools` replaces the inherited list; no Agent tool, so no subagent). */
export function amuxV22KimiAgent() {
  return { path: KIMI_AGENT_FILE, text: ["version: 1", "agent:", "  extend: default",
    "  tools:", ...KIMI_AGENT_TOOLS.map((tool) => `    - "${tool}"`), ""].join("\n") };
}

/** The session-only settings (`--settings` is never saved). Deny wins over
 * allow in agy's rules. A read role with the local CLI flow's shell may run
 * commands (in the sidecar's jail) but never write a file with the file tool. */
export function amuxV22AntigravitySettings(write, worktreePath, { shell = write } = {}) {
  if (typeof worktreePath !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(worktreePath) ||
      worktreePath.split("/").includes(".."))
    throw new TypeError("unsafe worktree path");
  const offline = ["read_url(*)", "execute_url(*)", "mcp(*)"];
  return { permissions: write ?
    { allow: ["command(*)", `write_file(${worktreePath})`], deny: offline } :
    shell ? { allow: ["command(*)"], deny: ["write_file(*)", ...offline] } :
    { deny: ["command(*)", "write_file(*)", ...offline] } };
}

const ANTIGRAVITY_AGENT_PREFIX = "amux-v22-";
// Only a known role names an agent: an unknown one must not fall to implement.
export function amuxV22AntigravityAgentName(role) {
  if (role === "implement") return `${ANTIGRAVITY_AGENT_PREFIX}implement`;
  if (READ_ONLY_ROLES.has(role)) return `${ANTIGRAVITY_AGENT_PREFIX}read`;
  throw new TypeError("unknown v22 role");
}

/** The custom agent file for a role: where it goes under the run home, and
 * its text. `mainAgent` makes it selectable with --agent. */
export function amuxV22AntigravityAgent(role, { readRoleShell = false } = {}) {
  const name = amuxV22AntigravityAgentName(role);
  const tools = [...ANTIGRAVITY_READ_AGENT_TOOLS,
    ...(!READ_ONLY_ROLES.has(role) ? ANTIGRAVITY_WRITE_AGENT_TOOLS :
      readRoleShell ? ["run_command"] : [])];
  return { path: [".gemini", "config", "agents", name, "agent.md"],
    text: ["---", `name: ${name}`, "description: AMUX v22 one-shot worker",
      "mainAgent: true", "tools:", ...tools.map((tool) => `  - ${tool}`), "---",
      "Work only in the current workspace and only with the tools you have.", ""].join("\n") };
}

/** What the CLI reads on stdin: Antigravity takes one NDJSON user event,
 * every other CLI the prompt itself. */
export function amuxV22ChannelStdin(provider, prompt) {
  return provider === "antigravity" ?
    `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` : prompt;
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
 * .cursor/; Antigravity's are .agents/ (workspace agents, skills, rules) and
 * .gemini/. Null when the run may start.
 */
const PROJECT_CONFIGS = {
  openai: [[".codex", "config.toml"]],
  "github-copilot": [[".mcp.json"], [".github", "mcp.json"], [".github", "hooks"]],
  cursor: [[".cursor"]],
  antigravity: [[".agents"], [".gemini"]],
  // Kimi's project layer is .kimi/ (skills, AGENTS.md); skills elsewhere are
  // replaced by --skills-dir.
  kimi: [[".kimi"]],
  // Qwen's project settings and context file; --safe-mode ignores the
  // context file, the settings still would be read.
  qwen: [[".qwen"]],
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
  antigravity: ["antigravity/antigravity-oauth-token",
    ".gemini/antigravity-cli/antigravity-oauth-token"],
  kimi: ["kimi/kimi-code.json", ".kimi/credentials/kimi-code.json"],
  // Qwen's Coding Plan key travels in the CLI's environment, as Copilot's token does.
  qwen: ["qwen/coding-plan-key", null],
};
const MAX_AUTH_BYTES = 64 * 1024;

/** A sign-in the run must not use; the sidecar refuses before the CLI starts. */
export class AmuxV22ChannelAuthRefused extends Error {}

/**
 * A fresh home under the sidecar's own, removed after the run: the CLI reads
 * no user configuration, hook or plugin that was there before. Its sign-in is
 * the v19 channel's cut-down copy (inspectAmuxV19ChannelAuth), never the
 * file as found: no refresh secret, and refused once the access token has
 * expired (no margin of ours, owner direction 2026-11-16).
 * A run that refreshed with the operator's refresh token would rotate it and
 * sign out every other use of the same login on the box (the v19 channels,
 * the operator's shell). Antigravity is the exception: Google's access token
 * lasts an hour and a refresh does not rotate the refresh token, so its copy
 * keeps it (owner decision 2026-11-10, inspectAmuxV22AntigravityAuth).
 */
export async function createAmuxV22ChannelRunHome(provider, config,
  { now = Date.now(), role = null, readRoleShell = false,
    fsOps = { mkdtemp, mkdir, readFile, writeFile, rm } } = {}) {
  const auth = AUTH_FILES[provider];
  if (!auth) throw new TypeError("unsupported v22 provider");
  const [from, to] = auth;
  const bytes = await fsOps.readFile(join(config.claudeConfigDir, from));
  let copy = null;
  let copilotToken = null;
  let qwenApiKey = null;
  try {
    if (bytes.length > MAX_AUTH_BYTES) throw new AmuxV22ChannelAuthRefused();
    if (provider === "github-copilot") {
      copilotToken = bytes.toString("utf8").trim();
      if (!AMUX_V19_COPILOT_TOKEN.test(copilotToken)) throw new AmuxV22ChannelAuthRefused();
    } else if (provider === "antigravity") {
      // The one copy that keeps its refresh token (v22WorkerAuthStage.mjs).
      try { copy = inspectAmuxV22AntigravityAuth(bytes).copy; }
      catch { throw new AmuxV22ChannelAuthRefused(); }
    } else if (provider === "qwen") {
      qwenApiKey = bytes.toString("utf8").trim();
      if (!AMUX_V22_QWEN_CODING_PLAN_KEY.test(qwenApiKey)) throw new AmuxV22ChannelAuthRefused();
    } else if (provider === "kimi") {
      // Access token only, refused once expired (v22WorkerAuthStage.mjs).
      try { copy = inspectAmuxV22KimiAuth(bytes, now).copy; }
      catch { throw new AmuxV22ChannelAuthRefused(); }
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
      if (provider === "antigravity") {
        const agent = amuxV22AntigravityAgent(role, { readRoleShell });
        await fsOps.mkdir(dirname(join(root, ...agent.path)), { recursive: true, mode: 0o700 });
        await fsOps.writeFile(join(root, ...agent.path), agent.text, { flag: "wx", mode: 0o600 });
      }
      if (provider === "kimi") {
        const agent = amuxV22KimiAgent();
        await fsOps.mkdir(join(root, ...KIMI_SKILLS_DIR), { recursive: true, mode: 0o700 });
        await fsOps.writeFile(join(root, ...agent.path), agent.text, { flag: "wx", mode: 0o600 });
        // Present and empty before the run, so a missing log is never zero decisions.
        await fsOps.writeFile(join(root, ...KIMI_GUARD_LOG), "", { flag: "wx", mode: 0o600 });
      }
      if (provider === "qwen") {
        // The run's only settings: the installed CLI stays the reviewed one.
        await fsOps.mkdir(join(root, ".qwen"), { recursive: true, mode: 0o700 });
        await fsOps.writeFile(join(root, ".qwen", "settings.json"),
          `${JSON.stringify({ general: { enableAutoUpdate: false } })}\n`, { flag: "wx", mode: 0o600 });
      }
      return { config: { ...config, homePath: root,
        claudeConfigDir: provider === "openai" ? join(root, "codex") : join(root, ".config") },
      cleanup, copilotToken, qwenApiKey };
    } catch (error) { await cleanup().catch(() => {}); throw error; }
  } finally { copy?.fill(0); }
}

/** The CLI's own config directory comes from the run home; Copilot's token,
 * checked by createAmuxV22ChannelRunHome, goes in COPILOT_GITHUB_TOKEN only. */
export function amuxV22ChannelEnv(provider, config, { copilotToken = null, qwenApiKey = null } = {}) {
  const env = { HOME: config.homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  if (provider === "openai") env.CODEX_HOME = config.claudeConfigDir;
  else env.XDG_CONFIG_HOME = config.claudeConfigDir;
  if (provider === "github-copilot" && copilotToken) env.COPILOT_GITHUB_TOKEN = copilotToken;
  // The installed CLI stays the reviewed one; agy honours only `true`
  // (measured: `1` still spawned its background updater).
  if (provider === "antigravity") env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  // Kimi keeps its share directory (sign-in, sessions, logs) in the run home
  // and never updates itself.
  if (provider === "kimi") {
    env.KIMI_SHARE_DIR = join(config.homePath, ".kimi");
    env.KIMI_CLI_NO_AUTO_UPDATE = "1";
  }
  // Qwen's home is the run home's; its provider is the Coding Plan endpoint
  // with the key the run home checked (docs: OPENAI_API_KEY selects
  // OpenAI-compatible auth from the environment alone).
  if (provider === "qwen") {
    env.QWEN_HOME = join(config.homePath, ".qwen");
    env.OPENAI_BASE_URL = QWEN_CODING_PLAN_BASE_URL;
    if (qwenApiKey) env.OPENAI_API_KEY = qwenApiKey;
  }
  return env;
}

const object = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * What one finished run says: whether it succeeded, the final answer, and its
 * usage observation. Any line that is not a JSON object, a tool outside the
 * role's list, a subagent, another permission mode, or a stream without the
 * CLI's terminal event makes the run unknown rather than guessed (as an
 * unparsable Claude result is). A kind of event the check has not seen passes
 * when nothing in it names an action, and a valid result lists those kinds in
 * `unrecognized` (names and counts, cliStreamUnknownKind.mjs).
 */
export function parseAmuxV22ChannelOutput(provider, output, { exitCode, role,
  readRoleShell = false, worktreePath = null, sessionUsage = null, guardDecisions = null }) {
  const parser = createAmuxV22ChannelOutputParser(provider, { role, readRoleShell,
    worktreePath });
  for (const line of output.split("\n")) parser.push(line);
  return parser.finish({ exitCode, sessionUsage, guardDecisions });
}

/**
 * The same reading, one stdout line at a time, so a long run's whole stream
 * is never held in memory (the local CLI flow reads it back from the run's
 * transcript file). Each provider's check is a single pass; a violation is
 * the first one in stream order, and a non-JSON line still wins over it, as
 * when the whole text was read at once.
 */
export function createAmuxV22ChannelOutputParser(provider, { role, readRoleShell = false,
  worktreePath = null }) {
  let count = 0;
  let nonObject = false;
  let violation = null;
  const fail = (reason) => { if (violation === null) violation = reason; };
  // The kinds this check has not seen and let pass (cliStreamUnknownKind.mjs):
  // names and counts only, returned with a valid result for the journal.
  const unseen = createAmuxCliUnknownKindLog();
  let step;
  let finish;
  if (provider === "openai") {
    const usage = createCodexCliUsageObserver();
    let answer = null;
    let failed = false;
    let terminal = false;
    step = (event, line) => {
      usage.observeLine(line);
      if (!event || violation !== null) return;
      // Codex runs a tool only as an item (measured: command_execution,
      // file_change; mcp_tool_call and web_search are the ones it may add).
      // An unseen item passes only when nothing in it names an action, as a
      // non-fatal `error` item ({id, type, message}) does.
      if (typeof event.type === "string" && event.type.startsWith("item.")) {
        const item = event.item;
        if (!CODEX_ITEMS.has(item?.type)) {
          if (!object(item) || amuxCliUnknownKindActs(item.type, item))
            return fail(`item:${amuxV22OutputName(item?.type)}`);
          unseen.note(`item:${item.type}`);
        }
      } else if (!CODEX_EVENTS.has(event.type)) {
        if (amuxCliUnknownKindActs(event.type, event))
          return fail(`event:${amuxV22OutputName(event.type)}`);
        unseen.note(`event:${event.type}`);
      }
      if (event.type === "turn.failed" || event.type === "error") failed = true;
      if (event.type === "turn.completed" || event.type === "turn.failed") terminal = true;
      if (event.type === "item.completed" && event.item?.type === "agent_message" &&
          typeof event.item.text === "string") answer = event.item.text;
    };
    finish = (exitCode) => {
      if (!terminal) return { valid: false, reason: "no_terminal_event" };
      const observation = usage.finish({ exitCode, stdoutComplete: true,
        freshEphemeralSession: true });
      return { valid: true, success: exitCode === 0 && !failed && answer !== null,
        resultText: answer, observation };
    };
  } else if (provider === "github-copilot") {
    const tools = new Set(copilotTools(role, readRoleShell));
    let answer = null;
    let result = null;
    let counts = null;
    let calls = 0;
    const served = new Set();
    step = (event) => {
      if (!event || violation !== null) return;
      const data = event.data;
      if (event.type === "tool.execution_start" && !tools.has(data?.toolName))
        return fail(`tool:${amuxV22OutputName(data?.toolName)}`);
      // A tool's name on any other event (a call delta, a new kind) is held
      // to the same list, and a subagent runs tools this stream does not list.
      if (typeof event.type === "string" && event.type.startsWith("subagent."))
        return fail("subagent");
      if (object(data) && data.toolName !== undefined && !tools.has(data.toolName))
        return fail(`tool:${amuxV22OutputName(data.toolName)}`);
      if (!COPILOT_EVENTS.has(event.type)) {
        if (amuxCliUnknownKindActs(event.type, event))
          return fail(`event:${amuxV22OutputName(event.type)}`);
        unseen.note(`event:${event.type}`);
      }
      if (event.type === "assistant.message" && Array.isArray(data?.toolRequests) &&
          data.toolRequests.some((request) => !tools.has(request?.name)))
        return fail("tool_request");
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
    };
    finish = (exitCode) => {
      if (result === null) return { valid: false, reason: "no_result" };
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
    };
  } else if (provider === "cursor") {
    let finalText = [];
    let result = null;
    let turns = 0;
    step = (event) => {
      if (!event || violation !== null) return;
      if (event.type === "tool_call") {
        const names = object(event.tool_call) ? Object.keys(event.tool_call)
          .filter((key) => key.endsWith("ToolCall")) : [];
        if (names.length !== 1 || !CURSOR_READ_TOOLS.has(names[0]))
          return fail(`tool:${amuxV22OutputName(names[0])}`);
        finalText = [];
      } else if (!CURSOR_EVENTS.has(event.type)) {
        // An unseen event is counted, and refused when it carries a tool call
        // or anything else that names an action.
        if (amuxCliUnknownKindActs(event.type, event))
          return fail(`event:${amuxV22OutputName(event.type)}`);
        unseen.note(`event:${event.type}`);
      }
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        turns += 1;
        for (const block of event.message.content)
          if (block?.type === "text" && typeof block.text === "string") finalText.push(block.text);
      }
      if (event.type === "result") result = event;
    };
    finish = (exitCode) => {
      if (result === null) return { valid: false, reason: "no_result" };
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
    };
  } else if (provider === "antigravity") {
    const tools = new Set([...ANTIGRAVITY_READ_TOOLS,
      ...(role === "implement" ? ANTIGRAVITY_WRITE_TOOLS :
        readRoleShell ? ["run_command"] : [])]);
    let result = null;
    let turns = 0;
    let first = true;
    step = (event) => {
      if (!event || violation !== null) return;
      // The file tools reach no path outside the workspace only in agy's
      // request-review mode: a read outside it (absolute, ../ or through a
      // symlink) asks, and print mode refuses the ask (measured on agy 1.5.4:
      // "Permission denied for read_file"; the run home's sign-in copy sits
      // outside the workspace). A run that started in any other mode is not
      // trusted. The first event must say so.
      if (first) {
        first = false;
        if (event.event !== "init" || !object(event.init) ||
            event.init.permission_mode !== "request-review") return fail("permission_mode");
      }
      if (!ANTIGRAVITY_EVENTS.has(event.event)) {
        if (amuxCliUnknownKindActs(event.event, event))
          return fail(`event:${amuxV22OutputName(event.event)}`);
        return unseen.note(`event:${event.event}`);
      }
      if (event.event === "result") result = event.result;
      if (event.event !== "step_update") return;
      const update = event.step_update;
      if (!object(update)) return fail("step:?");
      // A subagent runs tools this stream does not list.
      if (Object.hasOwn(update, "subagent_info")) return fail("subagent");
      // agy names a tool in tool_name and tool_info (measured on the box's
      // transcripts, 2026-11-21: every tool step has both). Whatever the
      // step's type, a named tool must be on the role's list.
      if ((update.step_type === "tool" || Object.hasOwn(update, "tool_name") ||
          Object.hasOwn(update, "tool_info")) && !tools.has(update.tool_name))
        return fail(`tool:${amuxV22OutputName(update.tool_name)}`);
      if (!ANTIGRAVITY_STEPS.has(update.step_type)) {
        // An unseen step (2026-11-21: `system_message`, with no field but
        // its ids, state and duration) passes when nothing in it names an
        // action; one that does -- a tool on the list included -- stays
        // refused.
        if (amuxCliUnknownKindActs(update.step_type, update))
          return fail(`step:${amuxV22OutputName(update.step_type)}`);
        unseen.note(`step:${update.step_type}`);
      }
      if (update.step_type === "agent_response" && update.state === "DONE") turns += 1;
    };
    finish = (exitCode) => {
      if (!object(result) || typeof result.status !== "string")
        return { valid: false, reason: "no_result" };
      const answer = typeof result.response === "string" ? result.response : null;
      const success = exitCode === 0 && result.status === "SUCCESS" &&
        answer !== null && answer.trim() !== "";
      const usage = result.usage;
      return { valid: true, success, resultText: success ? answer : null,
        observation: amuxSubscriptionCliUsageObservation("antigravity", {
          counts: object(usage) ? { inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_tokens,
            cacheWriteTokens: 0 } : null,
          servedModelId: null,
          completedTurns: Number.isSafeInteger(result.num_turns) ? result.num_turns : turns,
          complete: success }) };
    };
  } else if (provider === "qwen") {
    // Qwen Code's stream-json (cli/src/nonInteractive/types.ts): system init,
    // assistant and user messages with content blocks, then one result.
    const tools = new Set(QWEN_READ_TOOLS);
    let result = null;
    let first = true;
    step = (event) => {
      if (!event || violation !== null) return;
      // The read tools stay inside the workspace only while every ask is
      // refused: plan mode in a headless run. The first event must say so
      // (the source writes subtype "init", the docs "session_start").
      if (first) {
        first = false;
        if (event.type !== "system" || !["init", "session_start"].includes(event.subtype) ||
            event.permission_mode !== "plan") return fail("permission_mode");
        return;
      }
      if (!QWEN_EVENTS.has(event.type)) {
        if (amuxCliUnknownKindActs(event.type, event))
          return fail(`event:${amuxV22OutputName(event.type)}`);
        return unseen.note(`event:${event.type}`);
      }
      // A subagent's message carries its parent's tool call id.
      if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null)
        return fail("subagent");
      if (event.type === "result") { result = event; return; }
      if (event.type === "system") {
        if (amuxCliUnknownKindActs(`system_${event.subtype}`, event))
          return fail(`event:system:${amuxV22OutputName(event.subtype)}`);
        return unseen.note(`event:system:${event.subtype}`);
      }
      const content = event.message?.content;
      if (!Array.isArray(content)) return fail("message_shape");
      for (const block of content) {
        if (event.type === "assistant" && block?.type === "tool_use") {
          if (!tools.has(block.name)) return fail(`tool:${amuxV22OutputName(block.name)}`);
          if (!qwenToolInputInside(block.name, block.input, worktreePath)) return fail("tool_path");
        } else if (event.type === "assistant" && !["text", "thinking"].includes(block?.type)) {
          return fail(`block:${amuxV22OutputName(block?.type)}`);
        }
      }
    };
    finish = (exitCode) => {
      if (!object(result)) return { valid: false, reason: "no_result" };
      const answer = typeof result.result === "string" ? result.result : null;
      const success = exitCode === 0 && result.subtype === "success" &&
        result.is_error === false && answer !== null && answer.trim() !== "";
      const usage = result.usage;
      return { valid: true, success, resultText: success ? answer : null,
        observation: amuxSubscriptionCliUsageObservation("qwen", {
          counts: object(usage) ? { inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0 } : null,
          servedModelId: null,
          completedTurns: Number.isSafeInteger(result.num_turns) ? result.num_turns : 0,
          complete: success }) };
    };
  } else if (provider === "kimi") {
    // Kimi's stream-json is its messages, one per line (kimi_cli
    // ui/print/visualize.py JsonPrinter): an assistant message with its
    // content parts and tool calls, then each tool's result; no result event
    // and no usage. The answer is the last assistant message, which must carry
    // no tool call.
    let last = null;
    let turns = 0;
    let toolCalls = 0;
    step = (event) => {
      if (!event || violation !== null) return;
      if (event.role === "assistant") {
        if (!Array.isArray(event.content) && typeof event.content !== "string")
          return fail("message_shape");
        const calls = event.tool_calls ?? [];
        if (!Array.isArray(calls)) return fail("message_shape");
        for (const call of calls) {
          const reason = amuxV22KimiToolCallRefusal(call, worktreePath);
          if (reason) return fail(reason);
        }
        toolCalls += calls.length;
        turns += 1;
        last = { calls: calls.length, text: typeof event.content === "string" ? event.content :
          event.content.filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text).join("") };
      } else if (event.role === "tool") {
        last = { calls: -1, text: "" };
      } else {
        // A notification or a plan display. A role this check has not seen,
        // or a kind that names an action, is refused.
        if (event.role !== undefined) return fail(`role:${amuxV22OutputName(event.role)}`);
        const kind = typeof event.type === "string" ? event.type : "untyped";
        if (amuxCliUnknownKindActs(kind, event)) return fail(`event:${amuxV22OutputName(kind)}`);
        unseen.note(`event:${kind}`);
      }
    };
    finish = (exitCode, sessionUsage, guardDecisions) => {
      if (last === null || last.calls !== 0) return { valid: false, reason: "no_result" };
      // Every call the stream shows must have met the hook (it fails open).
      if (toolCalls > 0 && guardDecisions !== toolCalls)
        return { valid: false, reason: "tool_guard_unconfirmed" };
      const success = exitCode === 0 && last.text.trim() !== "";
      return { valid: true, success, resultText: success ? last.text : null,
        observation: amuxSubscriptionCliUsageObservation("kimi", {
          counts: sessionUsage === null ? null : { inputTokens: sessionUsage.inputTokens,
            outputTokens: sessionUsage.outputTokens,
            cacheReadTokens: sessionUsage.cacheReadTokens,
            cacheWriteTokens: sessionUsage.cacheWriteTokens },
          servedModelId: null, completedTurns: turns, complete: success }) };
    };
  } else {
    step = () => {};
    finish = () => ({ valid: false, reason: "provider" });
  }
  return {
    push(line) {
      if (line.trim() === "") return;
      count += 1;
      let event = null;
      try { event = JSON.parse(line); } catch { /* not JSON */ }
      if (!object(event)) { nonObject = true; event = null; }
      step(event, line);
    },
    finish({ exitCode, sessionUsage = null, guardDecisions = null }) {
      if (count === 0) return { valid: false, reason: "empty" };
      if (nonObject) return { valid: false, reason: "non_object_line" };
      if (provider === "antigravity" && role !== "implement" && !READ_ONLY_ROLES.has(role))
        return { valid: false, reason: "role" };
      if ((provider === "kimi" || provider === "qwen") && !READ_ONLY_ROLES.has(role))
        return { valid: false, reason: "role" };
      if (violation !== null) return { valid: false, reason: violation };
      const parsed = finish(exitCode, sessionUsage, guardDecisions);
      return parsed.valid && unseen.size() > 0 ?
        { ...parsed, unrecognized: unseen.snapshot() } : parsed;
    },
  };
}

/** Why one Kimi tool call is refused, or null: a tool outside the read list,
 * an argument the tool does not document, or a path or path pattern that
 * could leave the checkout (absolute outside it, `..`, `~`, a backslash). */
export function amuxV22KimiToolCallRefusal(call, worktreePath) {
  const name = call?.function?.name;
  if (!object(call) || call.type !== "function" || !object(call.function))
    return `tool:${amuxV22OutputName(name)}`;
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { args = undefined; }
  const reason = amuxV22KimiToolInputRefusal(name, args, worktreePath);
  return reason === "tool" ? `tool:${amuxV22OutputName(name)}` : reason;
}

/** Whether a Qwen read tool's input stays in the checkout by its text: a
 * path or directory argument is relative without `..` or inside the checkout,
 * and a file pattern relative without `..`. The CLI resolves symlinks itself
 * (WorkspaceContext.isPathWithinWorkspace), so this is the second check. */
function qwenToolInputInside(name, input, worktreePath) {
  if (!object(input)) return false;
  for (const [key, value] of Object.entries(input)) {
    const pathKey = /path|dir/i.test(key);
    // glob's `pattern` is a file pattern; grep_search's is a regex.
    const patternKey = key === "glob" || key === "include" || (name === "glob" && key === "pattern");
    if (!pathKey && !patternKey) continue;
    if (typeof value !== "string" || value === "" || value.length > 4096 ||
        value.startsWith("~") || value.includes("\\") || value.includes("\0") ||
        value.split("/").includes("..")) return false;
    if (!value.startsWith("/")) continue;
    if (patternKey || typeof worktreePath !== "string" || !worktreePath.startsWith("/") ||
        !(value === worktreePath || value.startsWith(`${worktreePath}/`))) return false;
  }
  return true;
}

/** How many calls the tool guard decided in this run home, or null when its
 * log is missing or holds a line the guard never writes. */
export async function readAmuxV22KimiGuardDecisions(homePath, { fsOps = { readFile } } = {}) {
  try {
    const lines = (await fsOps.readFile(join(homePath, ...KIMI_GUARD_LOG))).toString("utf8")
      .split("\n").filter((line) => line !== "");
    return lines.every((line) => /^(allow|block [a-z_]{1,32})$/.test(line)) ? lines.length : null;
  } catch { return null; }
}

const KIMI_WIRE_MAX_BYTES = 64 * 1024 * 1024;
const KIMI_USAGE_FIELDS = ["input_other", "output", "input_cache_read", "input_cache_creation"];
// Wire events after which a step's usage cannot be accounted for: a retried
// or interrupted step, a compaction's own model call, a subagent's steps.
const KIMI_WIRE_UNACCOUNTED = new Set(["StepRetry", "StepInterrupted", "CompactionBegin",
  "SubagentEvent"]);
/**
 * The run's tokens from the session's wire.jsonl in the run home
 * (`<share>/sessions/<work-dir hash>/<session id>/wire.jsonl`, kimi_cli
 * wire/file.py: a metadata line, then `{timestamp, message: {type, payload}}`).
 * A StatusUpdate's token_usage is its step's (documented for the wire
 * protocol): each one belongs to the StepBegin before it, the step's last
 * report kept. Null -- unknown usage, which does not settle -- unless there is
 * exactly one session with one turn that ended, every step reported whole
 * counts, and nothing made a model call outside a step.
 */
export async function readAmuxV22KimiSessionUsage(homePath,
  { fsOps = { readdir, readFile, stat } } = {}) {
  try {
    const sessions = join(homePath, ".kimi", "sessions");
    const files = [];
    for (const dir of await fsOps.readdir(sessions))
      for (const id of await fsOps.readdir(join(sessions, dir)))
        files.push(join(sessions, dir, id, "wire.jsonl"));
    if (files.length !== 1) return null;
    if ((await fsOps.stat(files[0])).size > KIMI_WIRE_MAX_BYTES) return null;
    const text = (await fsOps.readFile(files[0])).toString("utf8");
    const steps = [];
    let turns = 0;
    let ended = false;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line);
      if (record?.type === "metadata") continue;
      const message = record?.message;
      if (!object(message) || typeof message.type !== "string") return null;
      if (KIMI_WIRE_UNACCOUNTED.has(message.type)) return null;
      if (message.type === "TurnBegin") { turns += 1; ended = false; continue; }
      if (message.type === "TurnEnd") { ended = true; continue; }
      if (message.type === "StepBegin") {
        if (turns !== 1 || ended) return null;
        steps.push(null);
        continue;
      }
      if (message.type !== "StatusUpdate") continue;
      const usage = message.payload?.token_usage;
      if (usage === undefined || usage === null) continue;
      if (steps.length === 0 || !object(usage) || !KIMI_USAGE_FIELDS.every((field) =>
        Number.isSafeInteger(usage[field]) && usage[field] >= 0)) return null;
      steps[steps.length - 1] = usage;
    }
    if (turns !== 1 || !ended || steps.length === 0 || steps.includes(null)) return null;
    const sum = (field) => steps.reduce((total, usage) => total + usage[field], 0);
    return { inputTokens: sum("input_other"), outputTokens: sum("output"),
      cacheReadTokens: sum("input_cache_read"), cacheWriteTokens: sum("input_cache_creation"),
      steps: steps.length };
  } catch { return null; }
}

// A CLI-chosen name (an event, item or tool type) as it may be logged: only a
// short lowercase identifier, never free text the stream could carry.
export function amuxV22OutputName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_.]{0,47}$/i.test(value) ?
    value : "?";
}

/**
 * The shape of a CLI stream the sidecar refused: each line's event type (and
 * item type for Codex), repeats folded, at most 60 entries. Names only, never
 * text, a tool argument or an id, so it can go to the sidecar's journal and
 * say which event made a run "invalid_result" (2026-11-09: two Codex runs
 * ended so and the stream was gone).
 */
export function amuxV22OutputShape(output) {
  const shape = createAmuxV22OutputShapeCollector();
  for (const line of output.split("\n")) shape.push(line);
  return shape.value();
}

/** The same shape, one line at a time, so a long stream is never held: only
 * the first 60 folded names are kept, and after them a count of the rest. */
export function createAmuxV22OutputShapeCollector() {
  const folded = [];
  let lastName = null;
  let more = 0;
  return {
    push(line) {
      if (line.trim() === "") return;
      let event = null;
      try { event = JSON.parse(line); } catch { /* counted below */ }
      // Antigravity names its events in `event`, with a step's tool or type;
      // Kimi names a message by its `role`, with its first tool call's name.
      const step = object(event) && object(event.step_update) ? event.step_update : null;
      const kimiCall = object(event) && Array.isArray(event.tool_calls) ?
        event.tool_calls[0]?.function?.name : undefined;
      const name = !object(event) ? "non_json" :
        amuxV22OutputName(event.type ?? event.event ?? event.role) +
        (object(event.item) ? `:${amuxV22OutputName(event.item.type)}` : "") +
        (step ? `:${amuxV22OutputName(step.tool_name ?? step.step_type)}` : "") +
        (kimiCall !== undefined ? `:${amuxV22OutputName(kimiCall)}` : "");
      if (name === lastName) {
        if (more === 0) folded.at(-1).count += 1;
        return;
      }
      lastName = name;
      if (folded.length < 60) folded.push({ name, count: 1 });
      else more += 1;
    },
    value() {
      const shown = folded.map(({ name, count }) => count > 1 ? `${name}*${count}` : name);
      if (more > 0) shown.push(`+${more}`);
      return shown.join(" ");
    },
  };
}
