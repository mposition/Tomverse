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
// System events after init that carry no capability: `ui_invalidate` was
// measured in the sixth Max S0 call (CLI 2.1.288). Others fail closed.
const CONTENT_FREE_SYSTEM_SUBTYPES = new Set(["status", "ui_invalidate"]);
// `thinking_tokens` reports only a running token estimate. It was measured on
// the first full v19 staging analysis (CLI 2.1.288, 2026-10-20) and passes only
// with exactly these keys and numeric estimates.
const THINKING_TOKENS_KEYS = Object.freeze(["estimated_tokens",
  "estimated_tokens_delta", "session_id", "subtype", "type", "uuid"]);
const thinkingTokensEvent = (event) => event.subtype === "thinking_tokens" &&
  Object.keys(event).sort().join("\0") === THINKING_TOKENS_KEYS.join("\0") &&
  Number.isFinite(event.estimated_tokens) &&
  Number.isFinite(event.estimated_tokens_delta);
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
// Local-only diagnostic detail (TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL): only
// names (an event subtype, a key, a tool or plugin name) and checkout-relative
// paths, each cut to a short token. Event bodies, tool results and model
// text are never read into a detail entry.
const MAX_DETAIL = 20;
const MAX_DETAIL_NAMES = 20;
const MAX_DETAIL_KEYS = 30;
const DETAIL_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const DETAIL_OUTSIDE = "<outside>";
const detailToken = (value) => {
  if (typeof value !== "string") return "<none>";
  const cut = value.slice(0, 64);
  return DETAIL_TOKEN.test(cut) ? cut : "<invalid>";
};
const detailPath = (value) => value.slice(0, 200)
  .replace(/[^\x20-\x7e]/g, "?");
const detailKeys = (event) => Object.keys(event).slice(0, MAX_DETAIL_KEYS)
  .map(detailToken);
const detailNames = (values, prefix = "") => Array.isArray(values)
  ? values.slice(0, MAX_DETAIL_NAMES).map((value) =>
    `${prefix}${detailToken(value)}`) : [];

/** Observe files touched by successful Read calls, including partial reads,
 * without retaining CLI text or tool results. Search and listing can traverse
 * files that their responses do not name, so their CLI events alone cannot
 * establish a complete manifest. */
export function createAmuxTrackedCheckoutReadObserver({ directory, files,
  onParsedEvent, detail = false }) {
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
  const toolErrors = { Read: 0, Grep: 0, Glob: 0 };
  // A fixed code for the first refusal, for count-only diagnostics.
  const fail = (code) => { invalid = true; reason ??= code; };
  const unverified = (code) => { reason ??= code; return { kind: "unverified" }; };
  const details = [];
  const noteDetail = (entry) => {
    if (detail === true && details.length < MAX_DETAIL)
      details.push(Object.freeze(entry));
  };
  return Object.freeze({
    /** The first refusal's fixed code, or null. Never a path or CLI text. */
    rejectReason() { return reason; },
    /** Local-only names for a refused tool use or Read path (detail mode). */
    rejectDetail() { return Object.freeze([...details]); },
    /** Failed tool calls by tool, counts only. */
    toolErrors() { return Object.freeze({ ...toolErrors }); },
    observeLine(line) {
      if (resultSeen) fail("event_after_result");
      let event;
      try { event = JSON.parse(line); } catch { fail("invalid_json"); return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        fail("non_object_event"); return;
      }
      // The caller still sees later events after a refusal, so its own
      // checks can be reported; this manifest can never become complete.
      try { onParsedEvent?.(event); } catch { fail("event_callback"); return; }
      if (invalid) return;
      if (PASSIVE_EVENTS.has(event.type)) return;
      if (event.type === "assistant") {
        if (!Array.isArray(event.message?.content)) { fail("assistant_shape"); return; }
        for (const block of event.message.content) {
          if (["text", "thinking", "redacted_thinking"].includes(block?.type)) continue;
          if (block?.type !== "tool_use" || typeof block.id !== "string" ||
              !TOOL_ID.test(block.id) || seenIds.has(block.id) ||
              !["Read", "Grep", "Glob"].includes(block.name)) {
            fail("tool_use_refused");
            noteDetail({ code: "tool_use_refused",
              name: detailToken(block?.name) });
            return;
          }
          seenIds.add(block.id);
          if (block.name === "Read") {
            const path = block.input?.file_path;
            const relative = typeof path === "string" &&
              path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : null;
            if (!relative || !allowed.has(relative)) {
              fail("read_path_refused");
              noteDetail({ code: "read_path_refused",
                path: relative ? detailPath(relative) : DETAIL_OUTSIDE });
              return;
            }
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
          // A failed call (an oversized Read, a bad pattern; seen on staging
          // 2026-10-25) is not a read: it is counted by tool, never added to
          // the manifest, and the model's later calls are still checked.
          if (block.is_error === true) {
            toolErrors[tool.kind] += 1;
            noteDetail({ code: "tool_result_error", name: tool.kind });
            continue;
          }
          if (block.is_error !== undefined && block.is_error !== false) {
            fail("tool_result_shape"); return;
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
    rejectDetail() { return lines.rejectDetail(); },
    toolErrors() { return lines.toolErrors(); },
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
  const also = [];
  let usageModels = null;
  let result = null;
  let final = null;
  // Fixed codes for count-only diagnostics: the first refusal, then up to
  // eight further distinct ones, so one paid run names every failing check.
  const note = (code) => {
    if (reason === null) reason = code;
    else if (code !== reason && !also.includes(code) && also.length < 8) also.push(code);
  };
  const fail = (code) => { invalid = true; note(code); };
  // Local-only names behind a refusal (detail mode); never changes a verdict.
  const events = [];
  const failNamed = (code, event, entry) => {
    fail(code);
    if (input.detail === true && events.length < MAX_DETAIL)
      events.push(Object.freeze({ code, keys: detailKeys(event), ...entry }));
  };
  const stream = createAmuxTrackedCheckoutReadStreamObserver({
    directory: input.directory, files: input.files,
    detail: input.detail === true,
    onParsedEvent(event) {
      if (event.type === "system") {
        if (event.subtype === "init") {
          if (initSeen || assistantSeen) fail("init_order");
          else if (!Array.isArray(event.tools) || event.tools.length !== 3 ||
              !["Read", "Grep", "Glob"].every((tool) => event.tools.includes(tool)))
            failNamed("init_tools", event, { names: detailNames(event.tools, "tool:") });
          else if (!["mcp_servers", "skills"].every((key) => emptyCapability(event, key)))
            failNamed("init_capabilities", event, { names: ["mcp_servers", "skills"]
              .filter((key) => !emptyCapability(event, key)) });
          else if (!inertClaudeMetadata(event, V19_CLI_FLAGS) &&
              !pinnedV19InitDescriptors(event)) failNamed("init_descriptors", event, {
            names: [...detailNames(Array.isArray(event.plugins)
              ? event.plugins.map((plugin) => plugin?.name) : [], "plugin:"),
            ...detailNames(event.agents, "agent:")].slice(0, MAX_DETAIL_NAMES) });
          else if (event.permissionMode !== "dontAsk" ||
              (event.permission_mode !== undefined &&
                event.permission_mode !== "dontAsk")) failNamed("init_permission", event, {
            names: [`permissionMode:${detailToken(event.permissionMode)}`,
              `permission_mode:${detailToken(event.permission_mode)}`] });
          else initSeen = true;
        } else if (thinkingTokensEvent(event)) {
          // A content-free progress estimate; nothing to verify.
        } else if (!CONTENT_FREE_SYSTEM_SUBTYPES.has(event.subtype) ||
            ["tools", "mcp_servers", "skills", "plugins", "agents",
              "permissionMode", "permission_mode"].some((key) =>
              Object.hasOwn(event, key))) {
          // A subtype from the CLI's known system vocabulary, else "other".
          failNamed(`system_event_${S0_SYSTEM_SUBTYPES.has(event.subtype)
            ? event.subtype : "other"}`, event,
          { subtype: detailToken(event.subtype) });
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
     * further distinct codes, and the reported usage model names when usage
     * refused. */
    rejectReason() {
      return Object.freeze({ code: reason, also: Object.freeze([...also]), usageModels });
    },
    /** Local-only names behind the refusals (detail mode), else empty: event
     * subtypes and key names, init tool/plugin names, refused tool names and
     * checkout-relative Read paths. Never event bodies or model text. */
    rejectDetail() {
      return Object.freeze([...events, ...stream.rejectDetail()]
        .slice(0, MAX_DETAIL));
    },
    observeChunk(chunk) {
      if (final) final = { kind: "outcome_unknown" };
      stream.observeChunk(chunk);
    },
    finish({ exitCode, stdoutComplete, openTrace } = {}) {
      if (final) return final;
      const manifest = stream.finish({ openTrace });
      // Every check runs, so diagnostics name each failure; any one refuses.
      let refused = invalid;
      const refuse = (code) => { refused = true; note(code); };
      if (manifest.kind !== "complete")
        refuse(`stream_${stream.rejectReason() ?? "unverified"}`);
      if (exitCode !== 0 || stdoutComplete !== true) refuse("exit_or_stdout");
      let observed = null;
      let inputTokens = null;
      if (!result || typeof result.result !== "string" || result.result.length === 0) {
        refuse("result_text_missing");
      } else {
        const usage = inspectClaudeCliResultUsage(result, {
          exitCode, stdoutComplete, freshPrintInvocation: true,
        });
        observed = usage.observed;
        inputTokens = observed && observed.inputTokens +
          observed.cacheReadInputTokens + (observed.cacheCreationInputTokens ?? 0);
        if (usage.completeness !== "reported_complete" ||
            usage.models.length !== 1 || usage.models[0].modelId !== modelId) {
          // Model names only (never other result fields): the pinned shape
          // for a name, anything else "other".
          usageModels = Object.freeze(usage.models.slice(0, 8).map((model) =>
            typeof model?.modelId === "string" && USAGE_MODEL.test(model.modelId)
              ? model.modelId : "other"));
          refuse(usage.completeness !== "reported_complete"
            ? "usage_incomplete" : usage.models.length !== 1
              ? "usage_model_count" : "usage_model_mismatch");
        } else if (!Number.isSafeInteger(inputTokens) ||
            !Number.isSafeInteger(observed?.outputTokens) ||
            !Number.isSafeInteger(inputTokens + observed.outputTokens) ||
            inputTokens + observed.outputTokens <= 0) refuse("usage_tokens");
      }
      if (refused) {
        result = null;
        final = { kind: "outcome_unknown" };
        return final;
      }
      const failedTools = stream.toolErrors();
      final = { kind: "verified_success", rawModelOutput: result.result,
        readFiles: manifest.files, inputTokens,
        outputTokens: observed.outputTokens,
        // Only when a call failed, so an ordinary result keeps its shape.
        ...(Object.values(failedTools).some((count) => count > 0)
          ? { toolErrors: failedTools } : {}) };
      result = null;
      return final;
    },
  });
}
