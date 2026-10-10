import { createHash } from "node:crypto";
import { createCodexCliUsageObserver,
  inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { amuxV4CodexNoToolsConfigArgs } from "./ideaLocalCodexNoToolsCore.mjs";
import { amuxV4UnexpectedEventDiagnostic } from "./ideaLocalAnalysisDiagnostics.mjs";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
// S0-only diagnostic labels. Never echo an arbitrary CLI event type, because
// a future CLI could put untrusted text in that field.
const SYNTHETIC_EVENT_TYPES = new Set(["user", "stream_event",
  "rate_limit_event", "system", "tool_use_summary", "auth_status",
  "control_request", "control_response", "hook_started",
  "hook_progress", "hook_response", "task_notification"]);
const S0_SYSTEM_SUBTYPES = new Set(["status", "hook_started",
  "hook_progress", "hook_response", "plugin_install", "compact_boundary",
  "api_retry", "informational", "mirror_error", "notification",
  "auth_status", "worker_shutting_down", "session_state_changed",
  "commands_changed", "memory_recall", "session_start", "setup",
  "startup_failure", "permission_denied", "files_persisted",
  "prompt_suggestion", "task_started", "task_progress", "task_updated",
  "background_tasks_changed", "elicitation_complete", "ui_invalidate"]);
const UI_INVALIDATE_KEYS = new Set(["type", "subtype", "event",
  "instances", "uuid", "session_id"]);
const RATE_LIMIT_KEYS = new Set(["type", "rate_limit_info", "uuid",
  "session_id"]);
const S0_TRACE_FIELDS = new Set(["type", "subtype", "uuid", "session_id",
  "surface", "surfaces", "component", "components", "component_id",
  "component_ids", "target", "scope", "id", "timestamp", "reason",
  "data", "event", "status", "version", "paths", "files"]);

const syntheticSubtypeDigest = (subtype) => typeof subtype === "string" &&
  subtype.length > 0 && subtype.length <= 128
  ? createHash("sha256").update(subtype, "utf8").digest("hex") : null;
const syntheticPluginPathClass = (path) => {
  if (typeof path !== "string") return "invalid";
  if (/^(builtin|internal):[A-Za-z0-9_.-]+$/.test(path)) return "embedded";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return "url";
  if (!path.startsWith("/")) return "relative";
  if (path.split("/").slice(1)
    .some((segment) => !segment || segment === "." || segment === "..")) return "other";
  if (path.startsWith("/$bunfs/")) return "embedded_bunfs";
  if (/^\/run\/amux-cli\/[^/]+$/.test(path)) return "staged_cli";
  if (path.startsWith("/tmp/.claude/")) return "sandbox_config";
  if (path.startsWith("/tmp/")) return "sandbox_tmp";
  if (path.startsWith("/usr/")) return "read_only_system";
  if (path.startsWith("/home/")) return "unmounted_home";
  return "other";
};
const syntheticPluginSourceClass = (source) => typeof source !== "string" ?
  "missing" : ["builtin", "built-in", "internal", "bundled"].includes(source)
    ? "embedded" : source.includes("@") ? "marketplace" : "other";

// The pinned Claude CLI still advertises bundled plugin/agent descriptors in
// --bare + --safe-mode. No user profile is mounted; neither descriptor is a
// callable tool. Fail closed if that observed shape changes.
const inertClaudeMetadata = (event, plan) => {
  const plugins = event.plugins ?? [];
  const agents = event.agents ?? [];
  if (plugins.length === 0 && agents.length === 0) return true;
  return plan.command?.includes("--bare") &&
    plan.command.includes("--safe-mode") &&
    plan.command.includes("--disable-slash-commands") &&
    plugins.length === 2 && agents.length === 4 &&
    plugins.every((plugin) => plugin && typeof plugin === "object" &&
      syntheticPluginPathClass(plugin.path) === "relative" &&
      plugin.path.split("/").every((part) => part && part !== "." && part !== "..") &&
      syntheticPluginSourceClass(plugin.source) === "marketplace");
};

/** S0-only schema trace; never include field values, assistant text or IDs. */
function syntheticClaudeEventTrace(decoded, includeInitCapabilities = false) {
  if (typeof decoded !== "string") return null;
  const events = [];
  let total = 0;
  let initSeen = false;
  let assistantSeen = false;
  let resultSeen = false;
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    total += 1;
    if (events.length >= 24) continue;
    let event;
    try { event = JSON.parse(line); }
    catch {
      events.push({ type: "other", phase: !initSeen ? "before_init" :
        resultSeen ? "after_result" : assistantSeen ? "after_assistant" :
          "after_init", invalidJson: true });
      continue;
    }
    const type = SYNTHETIC_EVENT_TYPES.has(event?.type) ? event.type :
      ["assistant", "result"].includes(event?.type) ? event.type : "other";
    const phase = !initSeen ? "before_init" : resultSeen ? "after_result" :
      assistantSeen ? "after_assistant" : "after_init";
    const descriptor = { type, phase };
    if (type === "system") {
      descriptor.subtype = S0_SYSTEM_SUBTYPES.has(event.subtype) ?
        event.subtype : event.subtype === "init" ? "init" : "other";
      if (descriptor.subtype === "init" && includeInitCapabilities) {
        descriptor.capabilityCounts = Object.fromEntries(
          ["tools", "mcp_servers", "skills", "plugins", "agents"].map((key) =>
            [key, Array.isArray(event[key]) ? event[key].length : null]));
        descriptor.pluginPathClasses = Array.isArray(event.plugins) &&
          event.plugins.length <= 8 ? event.plugins.map((plugin) =>
            syntheticPluginPathClass(plugin?.path)) : null;
        descriptor.pluginSourceClasses = Array.isArray(event.plugins) &&
          event.plugins.length <= 8 ? event.plugins.map((plugin) =>
            syntheticPluginSourceClass(plugin?.source)) : null;
        const modes = [event.permissionMode, event.permission_mode]
          .filter((mode) => mode !== undefined);
        const mode = modes.length === 1 ||
          (modes.length === 2 && modes[0] === modes[1]) ? modes[0] :
          modes.length === 2 ? "conflict" : "missing";
        descriptor.permissionMode = ["default", "plan", "acceptEdits",
          "dontAsk", "bypassPermissions", "restricted", "manual", "auto",
          "conflict", "missing"].includes(mode) ? mode : "other";
      }
      if (descriptor.subtype === "ui_invalidate") {
        const keys = Object.keys(event).sort();
        descriptor.fields = keys.slice(0, 24).map((key) =>
          S0_TRACE_FIELDS.has(key) ? key : createHash("sha256")
            .update(key, "utf8").digest("hex"));
        descriptor.fieldCount = keys.length;
      }
    }
    if (type === "assistant") {
      descriptor.hasToolUse = event.message?.stop_reason === "tool_use" ||
        event.message?.content?.some?.((block) => block?.type === "tool_use") === true;
    }
    if (type === "result") {
      descriptor.subtype = ["success", "error_max_turns",
        "error_during_execution", "error_max_budget_usd"].includes(event.subtype)
        ? event.subtype : "other";
      descriptor.isError = event.is_error === true;
      descriptor.modelCount = event.modelUsage &&
        typeof event.modelUsage === "object" && !Array.isArray(event.modelUsage)
        ? Object.keys(event.modelUsage).length : null;
    }
    events.push(descriptor);
    if (event?.type === "system" && event.subtype === "init") initSeen = true;
    if (event?.type === "assistant") assistantSeen = true;
    if (event?.type === "result") resultSeen = true;
  }
  return { total, truncated: total > events.length, events };
}

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
    : ["/run/amux-cli/claude", "--print", "--bare", "--safe-mode", "--restricted",
      "--disable-slash-commands",
      "--no-session-persistence", "--output-format",
      "stream-json", "--verbose", "--strict-mcp-config",
      "--max-turns", "1", "--max-budget-usd", "10.56",
      "--permission-mode", "manual", "--permission-prompts", "none",
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
export function inspectAmuxV4AnalysisCliResult(plan, stdout, exitCode,
  { diagnostic = false, syntheticEventType = false } = {}) {
  let decoded;
  const unknown = (failureReason, rejectionPoint = null, event = null,
    eventPhase = null) => ({
    kind: "outcome_unknown",
    ...(diagnostic ? { failureReason,
      ...(rejectionPoint ? { rejectionPoint } : {}) } : {}),
    ...(diagnostic && rejectionPoint === "unexpected_event"
      ? amuxV4UnexpectedEventDiagnostic(event?.type, eventPhase) : null),
    ...(diagnostic && syntheticEventType &&
      rejectionPoint === "unexpected_event" ? {
        unexpectedEventType: SYNTHETIC_EVENT_TYPES.has(event?.type)
          ? event.type : "other",
        unexpectedEventPhase: eventPhase,
        ...(event?.type === "system" && eventPhase === "before_init" ? {
          unexpectedSystemSubtype: S0_SYSTEM_SUBTYPES.has(event.subtype)
            ? event.subtype : "other",
          ...(S0_SYSTEM_SUBTYPES.has(event.subtype) ? {} : {
            unexpectedSystemSubtypeDigest: syntheticSubtypeDigest(event.subtype),
          }),
          unexpectedSystemHasCapabilities: ["tools", "mcp_servers", "skills",
            "plugins", "agents", "permissionMode", "permission_mode"]
            .some((key) => Object.hasOwn(event, key)),
          unexpectedSystemHasFreeText: ["message", "content", "result",
            "error", "text", "reason", "description", "details"]
            .some((key) => Object.hasOwn(event, key)),
        } : {}),
      } : {}),
    ...(plan?.provider === "anthropic" && diagnostic && syntheticEventType &&
      (["unexpected_event", "ui_invalidate_shape"].includes(rejectionPoint) ||
        failureReason === "security_no_tools_violation") ? {
        syntheticTrace: syntheticClaudeEventTrace(decoded,
          failureReason === "security_no_tools_violation"),
      } : {}),
  });
  if (!plan || !["openai", "anthropic"].includes(plan.provider) ||
      !Buffer.isBuffer(stdout) || stdout.length < 1 ||
      stdout.length > MAX_STDOUT_BYTES || exitCode !== 0) {
    return unknown("incomplete_output");
  }
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout); }
  catch { return unknown("incomplete_output"); }
  if (plan.provider === "openai") {
    const observer = createCodexCliUsageObserver();
    let answer = null;
    for (const line of decoded.split("\n")) {
      if (!line.trim()) continue;
      observer.observeLine(line);
      let event;
      try { event = JSON.parse(line); } catch { return unknown("incomplete_output"); }
      if (["item.started", "item.updated", "item.completed"].includes(event?.type)) {
        // A successful answer is not proof of a no-tool invocation. Any shell,
        // patch, browser or other item fails this transport observation.
        if (!["agent_message", "reasoning"].includes(event.item?.type)) {
          return unknown("security_no_tools_violation");
        }
      } else if (!["thread.started", "turn.started", "turn.completed"].includes(event?.type)) {
        return unknown("output_contract_mismatch");
      }
      if (event?.type === "item.completed" &&
          event.item?.type === "agent_message") {
        if (answer !== null || typeof event.item.text !== "string" ||
            Buffer.byteLength(event.item.text, "utf8") > MAX_RESULT_BYTES) {
          return unknown("output_contract_mismatch");
        }
        answer = event.item.text;
      }
    }
    const observation = observer.finish({ exitCode, stdoutComplete: true,
      freshEphemeralSession: true });
    const counts = safeCounts(observation);
    if (answer === null) return unknown("incomplete_output");
    if (!counts) return unknown("usage_unverified");
    return { kind: "model_unverified", ...counts };
  }
  let envelope = null;
  let initSeen = false;
  let assistantCount = 0;
  let startupNoticeCount = 0;
  let rateLimitCount = 0;
  for (const line of decoded.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { return unknown("incomplete_output"); }
    if (event?.type === "system" && event.subtype === "ui_invalidate" &&
        !initSeen && envelope === null) {
      startupNoticeCount += 1;
      if (startupNoticeCount > 8 ||
          event.event !== "ui.render" ||
          (event.instances !== undefined &&
            (!Array.isArray(event.instances) || event.instances.length !== 0)) ||
          !Object.keys(event).every((key) => UI_INVALIDATE_KEYS.has(key)) ||
          ["uuid", "session_id"].some((key) => event[key] !== undefined &&
            (typeof event[key] !== "string" || event[key].length > 128))) {
        return unknown("output_contract_mismatch", "ui_invalidate_shape");
      }
    } else if (event?.type === "rate_limit_event" && initSeen &&
        assistantCount > 0 && envelope === null) {
      rateLimitCount += 1;
      if (rateLimitCount > 8 ||
          !Object.keys(event).every((key) => RATE_LIMIT_KEYS.has(key)) ||
          !event.rate_limit_info || typeof event.rate_limit_info !== "object" ||
          Array.isArray(event.rate_limit_info) ||
          ["uuid", "session_id"].some((key) => event[key] !== undefined &&
            (typeof event[key] !== "string" || event[key].length > 128))) {
        return unknown("output_contract_mismatch", "rate_limit_shape");
      }
    } else if (event?.type === "system" && event.subtype === "init") {
      if (initSeen || envelope !== null || !Array.isArray(event.tools) ||
          (event.mcp_servers !== undefined && !Array.isArray(event.mcp_servers)) ||
          ["skills", "plugins", "agents"].some((key) =>
            event[key] !== undefined && !Array.isArray(event[key]))) {
        return unknown("output_contract_mismatch", "init_shape");
      }
      if (event.tools.length !== 0 ||
          (event.mcp_servers?.length ?? 0) !== 0 ||
          (event.skills?.length ?? 0) !== 0 ||
          !inertClaudeMetadata(event, plan) ||
          (event.permissionMode !== undefined &&
            !["default", "manual"].includes(event.permissionMode)) ||
          (event.permission_mode !== undefined &&
            !["default", "manual"].includes(event.permission_mode))) {
        return unknown("security_no_tools_violation");
      }
      initSeen = true;
    } else if (event?.type === "assistant") {
      if (!initSeen || envelope !== null || !Array.isArray(event.message?.content)) {
        return unknown("output_contract_mismatch", "assistant_shape");
      }
      if (event.message.stop_reason === "tool_use" ||
          event.message.content.some((block) => block?.type === "tool_use")) {
        return unknown("security_no_tools_violation");
      }
      if ((event.message.stop_reason !== undefined &&
            event.message.stop_reason !== null &&
            event.message.stop_reason !== "end_turn") ||
          event.message.content.some((block) =>
            !block || !["text", "thinking", "redacted_thinking"].includes(block.type))) {
        return unknown("output_contract_mismatch", "assistant_stop");
      }
      assistantCount += 1;
      if (assistantCount > 8 || event.message.role !== "assistant") {
        return unknown("output_contract_mismatch", "assistant_shape");
      }
    } else if (event?.type === "result") {
      if (!initSeen || assistantCount < 1 || envelope !== null) {
        return unknown("output_contract_mismatch", "result_order");
      }
      envelope = event;
    } else {
      const phase = !initSeen ? "before_init" : envelope !== null
        ? "after_result" : assistantCount > 0 ? "after_assistant" : "after_init";
      return unknown("output_contract_mismatch", "unexpected_event", event,
        phase);
    }
  }
  if (!envelope || !initSeen || assistantCount < 1) {
    return unknown("incomplete_output");
  }
  const observation = inspectClaudeCliResultUsage(envelope, {
    exitCode, stdoutComplete: true, freshPrintInvocation: true });
  const counts = safeCounts(observation);
  if (observation.models.length === 1 &&
      observation.models[0].modelId !== plan.modelId) {
    return unknown("served_model_mismatch");
  }
  if (!counts) return unknown("usage_unverified");
  if (envelope?.num_turns !== 1) {
    return unknown("output_contract_mismatch", "turn_count");
  }
  if (observation.models.length !== 1) {
    return unknown("output_contract_mismatch", "model_count");
  }
  if (typeof envelope.result !== "string" ||
      Buffer.byteLength(envelope.result, "utf8") > MAX_RESULT_BYTES) {
    return unknown("output_contract_mismatch", "result_shape");
  }
  return { kind: "verified_success", rawModelOutput: envelope.result,
    ...counts };
}
