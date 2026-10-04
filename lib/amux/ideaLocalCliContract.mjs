import { createCodexCliUsageObserver,
  inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { amuxV4CodexNoToolsConfigArgs } from "./ideaLocalCodexNoToolsCore.mjs";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

/** A provider is never inferred from a model name. These are proposed exact
 * argv contracts, not live admission: the installed CLI flags and selected
 * model still need the Ubuntu S0 proof and an approved host catalog. */
export function planAmuxV4AnalysisCliInvocation(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection) ||
      Object.keys(selection).sort().join("\0") !==
        ["modelId", "provider", "reasoningEffort"].sort().join("\0") ||
      !["openai", "anthropic"].includes(selection.provider) ||
      typeof selection.modelId !== "string" || !MODEL_ID.test(selection.modelId) ||
      !EFFORTS.has(selection.reasoningEffort)) return null;
  const { provider, modelId, reasoningEffort } = selection;
  const command = provider === "openai"
    ? ["/run/amux-cli/codex", "--ask-for-approval", "never",
      ...amuxV4CodexNoToolsConfigArgs(),
      "-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      "-c", "shell_environment_policy.inherit=\"none\"",
      "exec", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--sandbox", "read-only",
      "--json", "--skip-git-repo-check", "-m", modelId, "-"]
    : ["/run/amux-cli/claude", "--print", "--safe-mode", "--restricted",
      "--no-session-persistence", "--output-format",
      "stream-json", "--verbose", "--strict-mcp-config",
      "--tools", "", "--allowedTools", "",
      "--model", modelId, "--effort", reasoningEffort];
  return Object.freeze({ provider, modelId, reasoningEffort,
    command: Object.freeze(command) });
}

const safeCounts = (observation) => {
  if (observation.completeness !== "reported_complete" ||
      !observation.observed) return null;
  const usage = observation.observed;
  const inputTokens = observation.cli === "codex" ? usage.inputTokens :
    usage.inputTokens + usage.cacheReadInputTokens +
      (usage.cacheCreationInputTokens ?? 0);
  const outputTokens = usage.outputTokens;
  return Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) &&
    inputTokens + outputTokens > 0 &&
    Number.isSafeInteger(inputTokens + outputTokens)
    ? { inputTokens, outputTokens } : null;
};

/** Parse only a complete one-shot CLI response. No transcript, tool output or
 * provider error is returned. Codex JSONL currently does not attest the
 * served model, so even a valid turn cannot be submitted as verified success. */
export function inspectAmuxV4AnalysisCliResult(plan, stdout, exitCode) {
  if (!plan || !["openai", "anthropic"].includes(plan.provider) ||
      !Buffer.isBuffer(stdout) || stdout.length < 1 ||
      stdout.length > MAX_STDOUT_BYTES || exitCode !== 0) {
    return { kind: "outcome_unknown" };
  }
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout); }
  catch { return { kind: "outcome_unknown" }; }
  if (plan.provider === "openai") {
    const observer = createCodexCliUsageObserver();
    let answer = null;
    for (const line of decoded.split("\n")) {
      if (!line.trim()) continue;
      observer.observeLine(line);
      let event;
      try { event = JSON.parse(line); } catch { return { kind: "outcome_unknown" }; }
      if (["item.started", "item.updated", "item.completed"].includes(event?.type)) {
        // A successful answer is not proof of a no-tool invocation. Any shell,
        // patch, browser or other item fails this transport observation.
        if (!["agent_message", "reasoning"].includes(event.item?.type)) {
          return { kind: "outcome_unknown" };
        }
      } else if (!["thread.started", "turn.started", "turn.completed"].includes(event?.type)) {
        return { kind: "outcome_unknown" };
      }
      if (event?.type === "item.completed" &&
          event.item?.type === "agent_message") {
        if (answer !== null || typeof event.item.text !== "string" ||
            Buffer.byteLength(event.item.text, "utf8") > MAX_RESULT_BYTES) {
          return { kind: "outcome_unknown" };
        }
        answer = event.item.text;
      }
    }
    const observation = observer.finish({ exitCode, stdoutComplete: true,
      freshEphemeralSession: true });
    const counts = safeCounts(observation);
    return answer !== null && counts
      ? { kind: "model_unverified", ...counts } : { kind: "outcome_unknown" };
  }
  let envelope = null;
  let initSeen = false;
  let assistantCount = 0;
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { return { kind: "outcome_unknown" }; }
    if (event?.type === "system" && event.subtype === "init") {
      if (initSeen || !Array.isArray(event.tools) || event.tools.length !== 0 ||
          (event.mcp_servers !== undefined &&
            (!Array.isArray(event.mcp_servers) || event.mcp_servers.length !== 0)) ||
          ["skills", "plugins", "agents"].some((key) =>
            event[key] !== undefined &&
            (!Array.isArray(event[key]) || event[key].length !== 0)) ||
          (event.permissionMode !== undefined &&
            event.permissionMode !== "default") ||
          (event.permission_mode !== undefined &&
            event.permission_mode !== "default") ||
          envelope !== null) return { kind: "outcome_unknown" };
      initSeen = true;
    } else if (event?.type === "assistant") {
      if (!initSeen || envelope !== null || !Array.isArray(event.message?.content) ||
          (event.message.stop_reason !== undefined &&
            event.message.stop_reason !== null &&
            event.message.stop_reason !== "end_turn") ||
          event.message.content.some((block) =>
            !block || !["text", "thinking", "redacted_thinking"].includes(block.type))) {
        return { kind: "outcome_unknown" };
      }
      assistantCount += 1;
      if (assistantCount > 8 || event.message.role !== "assistant") {
        return { kind: "outcome_unknown" };
      }
    } else if (event?.type === "result") {
      if (!initSeen || assistantCount < 1 || envelope !== null) {
        return { kind: "outcome_unknown" };
      }
      envelope = event;
    } else {
      return { kind: "outcome_unknown" };
    }
  }
  if (!envelope || !initSeen || assistantCount < 1) {
    return { kind: "outcome_unknown" };
  }
  const observation = inspectClaudeCliResultUsage(envelope, {
    exitCode, stdoutComplete: true, freshPrintInvocation: true });
  const counts = safeCounts(observation);
  if (!counts || envelope?.num_turns !== 1 ||
      observation.models.length !== 1 ||
      observation.models[0].modelId !== plan.modelId ||
      typeof envelope.result !== "string" ||
      Buffer.byteLength(envelope.result, "utf8") > MAX_RESULT_BYTES) {
    return { kind: "outcome_unknown" };
  }
  return { kind: "verified_success", rawModelOutput: envelope.result,
    ...counts };
}
