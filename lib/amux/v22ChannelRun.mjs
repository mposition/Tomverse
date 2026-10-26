import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { amuxSubscriptionCliUsageObservation, createCodexCliUsageObserver } from
  "./cliUsageObservationCore.ts";

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
 *   role, the checkout only and no network for implement -- with the
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
 * Before spawning: a CLI starts the MCP servers its configuration names, and
 * refusing an MCP tool call afterwards cannot undo what the server did. So a
 * run is refused before the CLI starts while any configuration that could
 * name one is present. Codex's user config is not read at all
 * (--ignore-user-config); its project config would be. Copilot's sources are
 * the ones `copilot mcp --help` lists (measured 2026-10-26, Copilot 1.0.94).
 * Null when the run may start.
 */
const MCP_CONFIGS = {
  openai: (config) => [join(config.worktreePath, ".codex", "config.toml")],
  "github-copilot": (config) => [join(config.homePath, ".copilot", "mcp-config.json"),
    join(config.worktreePath, ".mcp.json"), join(config.worktreePath, ".github", "mcp.json")],
  cursor: (config) => [join(config.worktreePath, ".cursor", "mcp.json"),
    join(config.homePath, ".cursor", "mcp.json"),
    join(config.claudeConfigDir, "cursor", "mcp.json")],
};
export function amuxV22ChannelPreflight(provider, config, { exists = existsSync } = {}) {
  const files = MCP_CONFIGS[provider]?.(config);
  if (!files) return "unsupported_provider";
  return files.some((file) => exists(file)) ? "mcp_config_present" : null;
}

/** The CLI's own config directory comes from the sidecar's config dir.
 * Copilot signs in with the GitHub token the v19 channel measured working
 * (`auth-token` there, handed over in COPILOT_GITHUB_TOKEN only). */
export function amuxV22ChannelEnv(provider, config, { readToken = readFileSync } = {}) {
  const env = { HOME: config.homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  if (provider === "openai") env.CODEX_HOME = config.claudeConfigDir;
  else env.XDG_CONFIG_HOME = config.claudeConfigDir;
  if (provider === "github-copilot") {
    let bytes = null;
    try {
      bytes = readToken(join(config.claudeConfigDir, "auth-token"));
      const token = bytes.toString("utf8").trim();
      if (/^gho_[A-Za-z0-9]{20,255}$/.test(token)) env.COPILOT_GITHUB_TOKEN = token;
    } catch { /* No token file: Copilot reads its own config, or refuses. */ }
    finally { bytes?.fill?.(0); }
  }
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
    const success = exitCode === 0 && result.exitCode === 0 && answer !== null;
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
