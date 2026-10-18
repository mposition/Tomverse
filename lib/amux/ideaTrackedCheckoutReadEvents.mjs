import { posix } from "node:path";
import { inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { S0_SYSTEM_SUBTYPES, inertClaudeMetadata } from "./ideaLocalCliContract.mjs";

const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
const TOOL_ID = /^[A-Za-z0-9_-]{1,160}$/;
const PASSIVE_EVENTS = new Set(["system", "rate_limit_event", "auth_status"]);
// Assistant error codes the Claude CLI emits (measured on 2.1.288 for an
// unauthenticated run: `authentication_failed`). Anything else is "other".
const CLI_ASSISTANT_ERRORS = new Set(["authentication_failed", "billing_error",
  "rate_limit", "invalid_request", "server_error", "max_output_tokens", "unknown"]);
// The complete terminal_reason list compiled into the pinned CLI 2.1.288
// (an unauthenticated run reports `api_error`). Anything else is "other".
const CLI_TERMINAL_REASONS = new Set(["blocking_limit", "rapid_refill_breaker",
  "prompt_too_long", "image_error", "model_error", "api_error",
  "malformed_tool_use_exhausted", "aborted_streaming", "aborted_tools",
  "stop_hook_prevented", "hook_stopped", "tool_deferred", "max_turns",
  "background_requested", "completed", "budget_exhausted",
  "structured_output_retry_exhausted", "tool_deferred_unavailable",
  "turn_setup_failed"]);
const MAX_DIAGNOSTIC_LINE = 64 * 1024 * 1024;
const USAGE_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
// The init descriptors of the pinned CLI 2.1.288 under the v19 flags,
// measured on the runner without credentials (2026-10-19): three bundled
// plugin descriptors and four agent names, none of them a callable tool
// (--tools allows only Read, Grep and Glob). Any other shape fails closed.
const V19_INIT_PLUGINS = Object.freeze(["cc-plugin-agents-md",
  "cc-plugin-plugin-authoring", "cc-plugin-telemetry"]);
const V19_INIT_AGENTS = Object.freeze(["Explore", "Plan", "claude",
  "general-purpose"]);
const pinnedV19InitDescriptors = (event) => {
  const plugins = event.plugins;
  const agents = event.agents;
  return Array.isArray(plugins) && Array.isArray(agents) &&
    plugins.length === V19_INIT_PLUGINS.length &&
    plugins.every((plugin) => plugin && typeof plugin === "object" &&
      !Array.isArray(plugin) &&
      Object.keys(plugin).sort().join(",") === "name,path,source" &&
      plugin.path === "builtin" && plugin.source === `${plugin.name}@builtin`) &&
    plugins.map((plugin) => plugin.name).sort().join(",") === V19_INIT_PLUGINS.join(",") &&
    agents.length === V19_INIT_AGENTS.length &&
    agents.every((agent) => typeof agent === "string") &&
    [...agents].sort().join(",") === V19_INIT_AGENTS.join(",");
};
const V19_CLI_FLAGS = Object.freeze({ command: Object.freeze([
  "--safe-mode", "--restricted", "--disable-slash-commands",
]) });

/** Observe files touched by successful Read calls, including partial reads,
 * without retaining CLI text or tool results. Search and listing can traverse
 * files that their responses do not name, so their CLI events alone cannot
 * establish a complete manifest. */
export function createAmuxTrackedCheckoutReadObserver({ directory, files,
  onParsedEvent }) {
  if (typeof directory !== "string" || !CHECKOUT.test(directory) ||
      (onParsedEvent !== undefined && typeof onParsedEvent !== "function") ||
      !Array.isArray(files) || files.some((file) =>
        typeof file !== "string" || !file || file.startsWith("/") ||
        file.includes("\\") || posix.normalize(file) !== file ||
        file.split("/").some((part) => part === ".." || part === "."))) {
    throw new TypeError("invalid tracked checkout read observer");
  }
  const allowed = new Set(files);
  if (allowed.size !== files.length) {
    throw new TypeError("invalid tracked checkout read observer");
  }
  const pending = new Map();
  const seenIds = new Set();
  const observed = new Set();
  let invalid = false;
  let reason = null;
  let unenumeratedToolUsed = false;
  let resultSeen = false;
  // A fixed code for the first refusal, for count-only diagnostics.
  const fail = (code) => { invalid = true; reason ??= code; };
  const unverified = (code) => { reason ??= code; return { kind: "unverified" }; };
  return Object.freeze({
    /** The first refusal's fixed code, or null. Never a path or CLI text. */
    rejectReason() { return reason; },
    observeLine(line) {
      if (invalid || resultSeen) { fail("event_after_result"); return; }
      let event;
      try { event = JSON.parse(line); } catch { fail("invalid_json"); return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        fail("non_object_event"); return;
      }
      try { onParsedEvent?.(event); } catch { fail("event_callback"); return; }
      if (PASSIVE_EVENTS.has(event.type)) return;
      if (event.type === "assistant") {
        if (!Array.isArray(event.message?.content)) { fail("assistant_shape"); return; }
        for (const block of event.message.content) {
          if (["text", "thinking", "redacted_thinking"].includes(block?.type)) continue;
          if (block?.type !== "tool_use" || typeof block.id !== "string" ||
              !TOOL_ID.test(block.id) || seenIds.has(block.id) ||
              !["Read", "Grep", "Glob"].includes(block.name)) {
            fail("tool_use_refused"); return;
          }
          seenIds.add(block.id);
          if (block.name === "Read") {
            const path = block.input?.file_path;
            const relative = typeof path === "string" &&
              path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : null;
            if (!relative || !allowed.has(relative)) { fail("read_path_refused"); return; }
            pending.set(block.id, { kind: "Read", path: relative });
          } else {
            pending.set(block.id, { kind: block.name });
          }
        }
        return;
      }
      if (event.type === "user") {
        if (!Array.isArray(event.message?.content)) { fail("user_shape"); return; }
        for (const block of event.message.content) {
          if (block?.type === "text") continue;
          if (block?.type !== "tool_result" ||
              typeof block.tool_use_id !== "string") {
            fail("user_shape"); return;
          }
          const tool = pending.get(block.tool_use_id);
          if (!tool) { fail("tool_result_unmatched"); return; }
          pending.delete(block.tool_use_id);
          // The pinned CLI omits is_error on a successful result (measured in
          // CLI 2.1.288); only an explicit false or an omission is success.
          if (block.is_error !== undefined && block.is_error !== false) {
            fail("tool_result_error"); return;
          }
          if (tool.kind === "Read") observed.add(tool.path);
          if (tool.kind !== "Read") unenumeratedToolUsed = true;
        }
        return;
      }
      if (event.type === "result") {
        if (event.is_error !== false || event.subtype !== "success") {
          fail("result_error"); return;
        }
        resultSeen = true;
        return;
      }
      fail("unexpected_event");
    },
    finish({ openTrace } = {}) {
      if (invalid) return { kind: "unverified" };
      if (!resultSeen) return unverified("result_missing");
      if (pending.size > 0) return unverified("tool_result_pending");
      if (openTrace !== undefined) {
        const traced = openTrace?.files;
        if (openTrace?.kind !== "complete") return unverified("trace_unverified");
        if (!Array.isArray(traced) ||
            traced.some((file) => typeof file !== "string" ||
              !allowed.has(file)) || new Set(traced).size !== traced.length)
          return unverified("trace_shape");
        if ([...observed].some((file) => !traced.includes(file)))
          return unverified("read_not_traced");
        return { kind: "complete", files: [...traced].sort() };
      }
      return unenumeratedToolUsed ? unverified("search_unenumerated") :
        { kind: "complete", files: [...observed].sort() };
    },
  });
}

/** Consume stdout as it arrives. CLI chunks do not align with JSON lines or
 * UTF-8 characters, and raw tool results are released after each line.
 * Call finish only after stdout closes; an earlier result is not authoritative. */
export function createAmuxTrackedCheckoutReadStreamObserver(input) {
  const lines = createAmuxTrackedCheckoutReadObserver(input);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let parts = [];
  let invalid = false;
  let finished = false;
  const feed = (text) => {
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0;
      end = text.indexOf("\n", start)) {
      parts.push(text.slice(start, end));
      lines.observeLine(parts.join(""));
      parts = [];
      start = end + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
  };
  return Object.freeze({
    rejectReason() { return invalid ? "invalid_stream" : lines.rejectReason(); },
    observeChunk(chunk) {
      if (finished || invalid || !(chunk instanceof Uint8Array)) {
        invalid = true;
        return;
      }
      try { feed(decoder.decode(chunk, { stream: true })); }
      catch { invalid = true; parts = []; }
    },
    finish(options) {
      if (!finished) {
        finished = true;
        if (!invalid) {
          try { feed(decoder.decode()); }
          catch { invalid = true; }
          if (parts.length > 0) lines.observeLine(parts.join(""));
        }
        parts = [];
      }
      return invalid ? { kind: "unverified" } : lines.finish(options);
    },
  });
}

/** Count-only CLI failure signals for diagnostic runs. The CLI reports why a
 * turn failed in its own stream, not on stderr: an assistant `error` code and
 * the result's status fields. This parser is independent of the validator, so
 * a stream the validator already rejected still yields its result codes. Each
 * line is parsed and dropped; message, tool-result and result text are never
 * kept, and only allowlisted codes and counts leave this function. */
export function createAmuxTrackedCheckoutCliDiagnosticObserver({
  maxLine = MAX_DIAGNOSTIC_LINE } = {}) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const cliError = { assistantError: null, resultIsError: null,
    apiErrorStatus: null, terminalReason: null, permissionDenials: null,
    turns: null };
  const toolUses = { Read: 0, Grep: 0, Glob: 0 };
  let parts = [];
  let size = 0;
  let skipping = false;
  let finished = false;
  const note = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    try { count(event); } catch { /* A malformed event counts for nothing. */ }
  };
  const count = (event) => {
    if (event.type === "assistant") {
      if (Array.isArray(event.message?.content))
        for (const block of event.message.content)
          if (block?.type === "tool_use" && typeof block.name === "string" &&
              Object.hasOwn(toolUses, block.name) &&
              toolUses[block.name] < 1_000_000) toolUses[block.name] += 1;
      if (typeof event.error === "string")
        cliError.assistantError = CLI_ASSISTANT_ERRORS.has(event.error)
          ? event.error : "other";
      return;
    }
    if (event.type !== "result") return;
    if (typeof event.is_error === "boolean") cliError.resultIsError = event.is_error;
    if (Number.isSafeInteger(event.api_error_status) &&
        event.api_error_status >= 100 && event.api_error_status <= 599)
      cliError.apiErrorStatus = event.api_error_status;
    if (typeof event.terminal_reason === "string")
      cliError.terminalReason = CLI_TERMINAL_REASONS.has(event.terminal_reason)
        ? event.terminal_reason : "other";
    if (Array.isArray(event.permission_denials))
      cliError.permissionDenials = Math.min(event.permission_denials.length, 1000);
    if (Number.isSafeInteger(event.num_turns) && event.num_turns >= 0)
      cliError.turns = Math.min(event.num_turns, 1_000_000);
  };
  const feed = (text) => {
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0;
      end = text.indexOf("\n", start)) {
      if (!skipping && size + (end - start) <= maxLine) {
        parts.push(text.slice(start, end));
        note(parts.join(""));
      }
      parts = []; size = 0; skipping = false;
      start = end + 1;
    }
    if (start < text.length && !skipping) {
      size += text.length - start;
      // An oversized line is skipped to its newline rather than buffered.
      if (size > maxLine) { parts = []; skipping = true; }
      else parts.push(text.slice(start));
    }
  };
  const snapshot = () => Object.freeze({ ...cliError,
    toolUses: Object.freeze({ ...toolUses }) });
  return Object.freeze({
    // Diagnostics never throw into the stdout handler: any unexpected input
    // shape leaves the counts as they were.
    observeChunk(chunk) {
      if (finished || !(chunk instanceof Uint8Array)) return;
      try { feed(decoder.decode(chunk, { stream: true })); }
      catch { parts = []; size = 0; skipping = true; }
    },
    /** Idempotent; parses a final line that lacked its newline. */
    finish() {
      if (!finished) {
        finished = true;
        try {
          feed(decoder.decode());
          if (!skipping && parts.length > 0) note(parts.join(""));
        } catch { /* Counts stay as observed. */ }
        parts = [];
      }
      return snapshot();
    },
  });
}

/** Validate a complete Claude print-mode stream without retaining tool-result
 * bodies. Grep/Glob require a complete, independently traced open manifest;
 * their CLI events alone cannot enumerate files. The caller invokes finish
 * after stdout and the trace stream both close. */
export function createAmuxTrackedCheckoutAnalysisStreamObserver(input) {
  if (!input || typeof input !== "object" ||
      typeof input.modelId !== "string" ||
      !/^claude-[A-Za-z0-9._-]{1,120}$/.test(input.modelId)) {
    throw new TypeError("invalid tracked checkout analysis observer");
  }
  const modelId = input.modelId;
  const emptyCapability = (event, key) => event[key] === undefined ||
    (Array.isArray(event[key]) && event[key].length === 0);
  let initSeen = false;
  let assistantSeen = false;
  let invalid = false;
  let reason = null;
  let usageModels = null;
  let result = null;
  let final = null;
  // A fixed code for the first refusal, for count-only diagnostics.
  const fail = (code) => { invalid = true; reason ??= code; };
  const unknown = (code) => {
    reason ??= code;
    result = null;
    final = { kind: "outcome_unknown" };
    return final;
  };
  const stream = createAmuxTrackedCheckoutReadStreamObserver({
    directory: input.directory, files: input.files,
    onParsedEvent(event) {
      if (event.type === "system") {
        if (event.subtype === "init") {
          if (initSeen || assistantSeen) fail("init_order");
          else if (!Array.isArray(event.tools) || event.tools.length !== 3 ||
              !["Read", "Grep", "Glob"].every((tool) => event.tools.includes(tool)))
            fail("init_tools");
          else if (!["mcp_servers", "skills"].every((key) => emptyCapability(event, key)))
            fail("init_capabilities");
          else if (!inertClaudeMetadata(event, V19_CLI_FLAGS) &&
              !pinnedV19InitDescriptors(event)) fail("init_descriptors");
          else if (event.permissionMode !== "dontAsk" ||
              (event.permission_mode !== undefined &&
                event.permission_mode !== "dontAsk")) fail("init_permission");
          else initSeen = true;
        } else if (event.subtype !== "status" ||
            ["tools", "mcp_servers", "skills", "plugins", "agents",
              "permissionMode", "permission_mode"].some((key) =>
              Object.hasOwn(event, key))) {
          // A subtype from the CLI's known system vocabulary, else "other".
          fail(`system_event_${S0_SYSTEM_SUBTYPES.has(event.subtype)
            ? event.subtype : "other"}`);
        }
      } else if (event.type === "assistant") {
        if (!initSeen || event.message?.role !== "assistant") fail("assistant_order");
        else assistantSeen = true;
      } else if (event.type === "user") {
        if (!initSeen || !assistantSeen || event.message?.role !== "user") fail("user_order");
      } else if (event.type === "result") {
        if (!initSeen || !assistantSeen || result !== null) fail("result_order");
        else result = event;
      }
    },
  });
  return Object.freeze({
    /** The first refusal's fixed code (stream refusals prefixed `stream_`),
     * and the reported usage model names when usage was the refusal. */
    rejectReason() {
      return Object.freeze({ code: reason, usageModels });
    },
    observeChunk(chunk) {
      if (final) final = { kind: "outcome_unknown" };
      stream.observeChunk(chunk);
    },
    finish({ exitCode, stdoutComplete, openTrace } = {}) {
      if (final) return final;
      const manifest = stream.finish({ openTrace });
      if (invalid) return unknown("stream_invalid");
      if (manifest.kind !== "complete")
        return unknown(`stream_${stream.rejectReason() ?? "unverified"}`);
      if (exitCode !== 0 || stdoutComplete !== true) return unknown("exit_or_stdout");
      if (!result || typeof result.result !== "string" || result.result.length === 0)
        return unknown("result_text_missing");
      const usage = inspectClaudeCliResultUsage(result, {
        exitCode, stdoutComplete, freshPrintInvocation: true,
      });
      const observed = usage.observed;
      const inputTokens = observed && observed.inputTokens +
        observed.cacheReadInputTokens + (observed.cacheCreationInputTokens ?? 0);
      if (usage.completeness !== "reported_complete" ||
          usage.models.length !== 1 || usage.models[0].modelId !== modelId) {
        // Model names only (never other result fields): the pinned shape for
        // a name, anything else "other".
        usageModels = Object.freeze(usage.models.slice(0, 8).map((model) =>
          typeof model?.modelId === "string" && USAGE_MODEL.test(model.modelId)
            ? model.modelId : "other"));
        return unknown(usage.completeness !== "reported_complete"
          ? "usage_incomplete" : usage.models.length !== 1
            ? "usage_model_count" : "usage_model_mismatch");
      }
      if (!Number.isSafeInteger(inputTokens) ||
          !Number.isSafeInteger(observed?.outputTokens) ||
          !Number.isSafeInteger(inputTokens + observed.outputTokens) ||
          inputTokens + observed.outputTokens <= 0) return unknown("usage_tokens");
      final = { kind: "verified_success", rawModelOutput: result.result,
        readFiles: manifest.files, inputTokens,
        outputTokens: observed.outputTokens };
      result = null;
      return final;
    },
  });
}
