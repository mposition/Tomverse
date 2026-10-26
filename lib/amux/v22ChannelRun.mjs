import { readFileSync } from "node:fs";
import { join } from "node:path";

import { amuxSubscriptionCliUsageObservation, createCodexCliUsageObserver } from
  "./cliUsageObservationCore.ts";

/**
 * The v22 one-shot run for a non-Claude provider (owner decision 2026-10-26).
 * The sidecar spawns the CLI exactly as it spawns Claude: the prompt on stdin,
 * the worker's own checkout as cwd, and the role's tools fixed by flags --
 * never by reading what the model asked for. A read role gets no write tool;
 * implement may edit files in the checkout but runs no shell (Codex's
 * workspace-write sandbox has no network). The flags and output shapes are the
 * ones measured for the v19 channels (lib/amux/ideaV19CliChannels.mjs and
 * ideaV19CliChannelOutput.mjs) on the same runner.
 */

const READ_ONLY_ROLES = new Set(["design", "investigate", "review"]);
const COPILOT_READ_TOOLS = ["view", "glob", "grep"];
const COPILOT_WRITE_TOOLS = ["edit", "create"];

/** Stream output carries tool events; bounded well above any useful run. */
export const AMUX_V22_CHANNEL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function amuxV22ChannelArgs(provider, request, worktreePath) {
  const write = !READ_ONLY_ROLES.has(request.role);
  switch (provider) {
    case "openai": return ["exec", "--json", "--skip-git-repo-check", "--ephemeral",
      "--sandbox", write ? "workspace-write" : "read-only",
      "-m", request.modelId, "-"];
    case "github-copilot": return ["--output-format", "json",
      "--model", request.modelId, "--available-tools",
      ...COPILOT_READ_TOOLS, ...(write ? COPILOT_WRITE_TOOLS : []),
      "--allow-all-tools", "--no-ask-user", "--no-custom-instructions",
      "--no-auto-update", "--no-color", "--disable-builtin-mcps"];
    case "cursor": return ["-p", "--output-format", "stream-json",
      ...(write ? [] : ["--mode", "ask"]), "--trust",
      "--workspace", worktreePath, "--model", request.modelId];
    default: throw new TypeError("unsupported v22 provider");
  }
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

const lines = (text) => text.split("\n").filter((line) => line.trim() !== "")
  .map((line) => { try { return JSON.parse(line); } catch { return null; } });
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * What one finished run says: whether it succeeded, the final answer, and its
 * usage observation. Any line that is not a JSON object, or a stream without
 * the CLI's terminal event, makes the run unknown rather than guessed (as an
 * unparsable Claude result is).
 */
export function parseAmuxV22ChannelOutput(provider, text, { exitCode, modelId }) {
  const events = lines(text);
  if (events.length === 0 || events.some((event) => !object(event)))
    return { valid: false };
  if (provider === "openai") {
    const usage = createCodexCliUsageObserver();
    let answer = null;
    let failed = false;
    for (const line of text.split("\n")) if (line.trim() !== "") usage.observeLine(line);
    for (const event of events) {
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
    let answer = null;
    let result = null;
    let counts = null;
    let calls = 0;
    const served = new Set();
    for (const event of events) {
      const data = event.data;
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
        servedModelId,
        completedTurns: calls, complete: success }) };
  }
  if (provider === "cursor") {
    let text = [];
    let result = null;
    let turns = 0;
    for (const event of events) {
      if (event.type === "tool_call") text = [];
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        turns += 1;
        for (const block of event.message.content)
          if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
      }
      if (event.type === "result") result = event;
    }
    if (result === null) return { valid: false };
    const success = exitCode === 0 && result.subtype === "success" &&
      result.is_error === false;
    // `result` joins every assistant text of the run; the answer is the text
    // after the last tool call (measured for v19).
    const answer = success ? text.join("") : null;
    const usage = result?.usage;
    return { valid: true, success: success && answer.trim() !== "", resultText: answer,
      observation: amuxSubscriptionCliUsageObservation("cursor", {
        counts: object(usage) ? { inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens } : null,
        servedModelId: null, completedTurns: turns, complete: success }) };
  }
  return { valid: false };
}
