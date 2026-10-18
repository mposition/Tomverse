import { posix } from "node:path";
import { inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { inertClaudeMetadata } from "./ideaLocalCliContract.mjs";

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
  let unenumeratedToolUsed = false;
  let resultSeen = false;
  return Object.freeze({
    observeLine(line) {
      if (invalid || resultSeen) { invalid = true; return; }
      let event;
      try { event = JSON.parse(line); } catch { invalid = true; return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        invalid = true; return;
      }
      try { onParsedEvent?.(event); } catch { invalid = true; return; }
      if (PASSIVE_EVENTS.has(event.type)) return;
      if (event.type === "assistant") {
        if (!Array.isArray(event.message?.content)) { invalid = true; return; }
        for (const block of event.message.content) {
          if (["text", "thinking", "redacted_thinking"].includes(block?.type)) continue;
          if (block?.type !== "tool_use" || typeof block.id !== "string" ||
              !TOOL_ID.test(block.id) || seenIds.has(block.id) ||
              !["Read", "Grep", "Glob"].includes(block.name)) {
            invalid = true; return;
          }
          seenIds.add(block.id);
          if (block.name === "Read") {
            const path = block.input?.file_path;
            const relative = typeof path === "string" &&
              path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : null;
            if (!relative || !allowed.has(relative)) { invalid = true; return; }
            pending.set(block.id, { kind: "Read", path: relative });
          } else {
            pending.set(block.id, { kind: block.name });
          }
        }
        return;
      }
      if (event.type === "user") {
        if (!Array.isArray(event.message?.content)) { invalid = true; return; }
        for (const block of event.message.content) {
          if (block?.type === "text") continue;
          if (block?.type !== "tool_result" ||
              typeof block.tool_use_id !== "string") {
            invalid = true; return;
          }
          const tool = pending.get(block.tool_use_id);
          if (!tool) { invalid = true; return; }
          pending.delete(block.tool_use_id);
          if (block.is_error !== false) { invalid = true; return; }
          if (tool.kind === "Read") observed.add(tool.path);
          if (tool.kind !== "Read") unenumeratedToolUsed = true;
        }
        return;
      }
      if (event.type === "result") {
        if (event.is_error !== false || event.subtype !== "success") {
          invalid = true; return;
        }
        resultSeen = true;
        return;
      }
      invalid = true;
    },
    finish({ openTrace } = {}) {
      if (invalid || !resultSeen || pending.size > 0)
        return { kind: "unverified" };
      if (openTrace !== undefined) {
        const traced = openTrace?.files;
        if (openTrace?.kind !== "complete" || !Array.isArray(traced) ||
            traced.some((file) => typeof file !== "string" ||
              !allowed.has(file)) || new Set(traced).size !== traced.length ||
            [...observed].some((file) => !traced.includes(file)))
          return { kind: "unverified" };
        return { kind: "complete", files: [...traced].sort() };
      }
      return unenumeratedToolUsed ? { kind: "unverified" } :
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
export function createAmuxTrackedCheckoutCliDiagnosticObserver() {
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
    if (event.type === "assistant") {
      if (Array.isArray(event.message?.content))
        for (const block of event.message.content)
          if (block?.type === "tool_use" && Object.hasOwn(toolUses, block.name) &&
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
      if (!skipping) { parts.push(text.slice(start, end)); note(parts.join("")); }
      parts = []; size = 0; skipping = false;
      start = end + 1;
    }
    if (start < text.length && !skipping) {
      size += text.length - start;
      // An oversized line is skipped to its newline rather than buffered.
      if (size > MAX_DIAGNOSTIC_LINE) { parts = []; skipping = true; }
      else parts.push(text.slice(start));
    }
  };
  const snapshot = () => Object.freeze({ ...cliError,
    toolUses: Object.freeze({ ...toolUses }) });
  return Object.freeze({
    observeChunk(chunk) {
      if (finished || !(chunk instanceof Uint8Array)) return;
      feed(decoder.decode(chunk, { stream: true }));
    },
    /** Idempotent; parses a final line that lacked its newline. */
    finish() {
      if (!finished) {
        finished = true;
        feed(decoder.decode());
        if (!skipping && parts.length > 0) note(parts.join(""));
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
  let result = null;
  let final = null;
  const stream = createAmuxTrackedCheckoutReadStreamObserver({
    directory: input.directory, files: input.files,
    onParsedEvent(event) {
      if (event.type === "system") {
        if (event.subtype === "init") {
          if (initSeen || assistantSeen || !Array.isArray(event.tools) ||
              event.tools.length !== 3 ||
              !["Read", "Grep", "Glob"].every((tool) => event.tools.includes(tool)) ||
              !["mcp_servers", "skills"].every((key) =>
                emptyCapability(event, key)) ||
              !inertClaudeMetadata(event, V19_CLI_FLAGS) ||
              event.permissionMode !== "dontAsk" ||
              (event.permission_mode !== undefined &&
                event.permission_mode !== "dontAsk")) invalid = true;
          else initSeen = true;
        } else if (event.subtype !== "status" ||
            ["tools", "mcp_servers", "skills", "plugins", "agents",
              "permissionMode", "permission_mode"].some((key) =>
              Object.hasOwn(event, key))) invalid = true;
      } else if (event.type === "assistant") {
        if (!initSeen || event.message?.role !== "assistant") invalid = true;
        else assistantSeen = true;
      } else if (event.type === "user") {
        if (!initSeen || !assistantSeen || event.message?.role !== "user") invalid = true;
      } else if (event.type === "result") {
        if (!initSeen || !assistantSeen || result !== null) invalid = true;
        else result = event;
      }
    },
  });
  return Object.freeze({
    observeChunk(chunk) {
      if (final) final = { kind: "outcome_unknown" };
      stream.observeChunk(chunk);
    },
    finish({ exitCode, stdoutComplete, openTrace } = {}) {
      if (final) return final;
      const manifest = stream.finish({ openTrace });
      if (invalid || manifest.kind !== "complete" ||
          exitCode !== 0 || stdoutComplete !== true || !result ||
          typeof result.result !== "string" || result.result.length === 0) {
        result = null;
        final = { kind: "outcome_unknown" };
        return final;
      }
      const usage = inspectClaudeCliResultUsage(result, {
        exitCode, stdoutComplete, freshPrintInvocation: true,
      });
      const observed = usage.observed;
      const inputTokens = observed && observed.inputTokens +
        observed.cacheReadInputTokens + (observed.cacheCreationInputTokens ?? 0);
      if (usage.completeness !== "reported_complete" ||
          usage.models.length !== 1 ||
          usage.models[0].modelId !== modelId ||
          !Number.isSafeInteger(inputTokens) ||
          !Number.isSafeInteger(observed?.outputTokens) ||
          !Number.isSafeInteger(inputTokens + observed.outputTokens) ||
          inputTokens + observed.outputTokens <= 0) {
        result = null;
        final = { kind: "outcome_unknown" };
        return final;
      }
      final = { kind: "verified_success", rawModelOutput: result.result,
        readFiles: manifest.files, inputTokens,
        outputTokens: observed.outputTokens };
      result = null;
      return final;
    },
  });
}
