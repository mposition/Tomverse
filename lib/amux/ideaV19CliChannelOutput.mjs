import { posix } from "node:path";

import { createCodexCliUsageObserver } from "./cliUsageObservationCore.ts";
import { amuxV19CliChannel } from "./ideaV19CliChannels.mjs";

const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
const MAX_LINE = 64 * 1024 * 1024;
const COPILOT_TOOLS = new Set(["view", "glob", "grep"]);
// Cursor's read-only file tools in --mode ask (measured: readToolCall).
const CURSOR_TOOLS = new Set(["readToolCall", "globToolCall", "grepToolCall",
  "lsToolCall"]);
const CODEX_ITEMS = new Set(["agent_message", "reasoning", "command_execution"]);
const CURSOR_EVENTS = new Set(["system", "user", "assistant", "thinking",
  "tool_call", "result"]);
const token = (value) => Number.isSafeInteger(value) && value >= 0 &&
  value <= 2_147_483_647;

/** Validate one non-Claude channel's complete stdout as it streams, without
 * keeping tool results. The checkout's read manifest comes from the
 * independent open trace; tool events only refuse writes, shells, other tools
 * and paths outside the checkout. Codex and Cursor do not report the model
 * that answered, so the requested model is the recorded one (attestation
 * "requested"); Copilot names it on every call and must match ("served"). */
export function createAmuxV19ChannelStreamObserver(input) {
  const channel = amuxV19CliChannel(input?.provider);
  if (!channel || channel.pinned || typeof input.modelId !== "string" ||
      typeof input.directory !== "string" || !CHECKOUT.test(input.directory) ||
      !Array.isArray(input.files) || input.files.some((file) =>
        typeof file !== "string" || !file || file.startsWith("/") ||
        posix.normalize(file) !== file || file.split("/").includes(".."))) {
    throw new TypeError("invalid v19 channel observer");
  }
  const { directory, modelId } = input;
  const files = new Set(input.files);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const codexUsage = channel.provider === "openai" ? createCodexCliUsageObserver() : null;
  const reads = new Set();
  const servedModels = new Set();
  let parts = [];
  let size = 0;
  let reason = null;
  let answer = null;
  let usage = null;
  let resultSeen = false;
  let initSeen = false;
  let finalText = [];
  let lines = 0;
  let final = null;
  const fail = (code) => { reason ??= code; };

  /** The checkout-relative path a tool names, or null when it is outside. */
  const relativePath = (path) => {
    if (typeof path !== "string" || path.includes("\0")) return null;
    if (path === directory) return "";
    const relative = path.startsWith(`${directory}/`)
      ? path.slice(directory.length + 1) : path.startsWith("/") ? null : path;
    if (relative === null) return null;
    const normalized = posix.normalize(relative);
    return normalized === "." ? "" : normalized === ".." ||
      normalized.startsWith("../") || normalized.startsWith("/") ? null : normalized;
  };
  const checkPath = (path, read) => {
    if (path === undefined) return;
    const relative = relativePath(path);
    if (relative === null) { fail("tool_path_outside"); return; }
    if (read && files.has(relative)) reads.add(relative);
  };
  const served = (model) => {
    if (model === undefined) return;
    if (model !== modelId) fail("served_model_mismatch");
    else servedModels.add(model);
  };

  const codex = (event, line) => {
    codexUsage.observeLine(line);
    if (event.type === "turn.failed" || event.type === "error") { fail("cli_error"); return; }
    if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const item = event.item;
      if (!item || !CODEX_ITEMS.has(item.type)) { fail("tool_refused"); return; }
      if (event.type === "item.completed" && item.type === "agent_message") {
        answer = typeof item.text === "string" ? item.text : null;
      }
      return;
    }
    if (!["thread.started", "turn.started", "turn.completed"].includes(event.type))
      fail("unexpected_event");
  };

  const copilot = (event) => {
    const data = event.data;
    if (typeof event.type !== "string") { fail("unexpected_event"); return; }
    if (/(?:^|\.)error$/.test(event.type)) { fail("cli_error"); return; }
    if (event.type === "result") {
      if (resultSeen || event.exitCode !== 0) fail("result_error");
      resultSeen = true;
      return;
    }
    if (resultSeen) { fail("event_after_result"); return; }
    if (event.type === "tool.execution_start") {
      if (!COPILOT_TOOLS.has(data?.toolName)) { fail("tool_refused"); return; }
      checkPath(data.arguments?.path, data.toolName === "view");
      served(data.model);
      return;
    }
    if (event.type === "assistant.message") {
      const requests = data?.toolRequests;
      if (!Array.isArray(requests) ||
          requests.some((request) => !COPILOT_TOOLS.has(request?.name))) {
        fail("tool_refused"); return;
      }
      for (const request of requests) checkPath(request.arguments?.path, false);
      served(data.model);
      answer = requests.length === 0 && typeof data.content === "string"
        ? data.content : null;
      return;
    }
    if (event.type === "model.call_final_result") {
      served(data?.model);
      if (data?.result !== "success") fail("model_call_failed");
      return;
    }
    if (event.type === "session.usage_checkpoint") {
      const metrics = data?.providerModelMetrics;
      if (!Array.isArray(metrics) || metrics.length < 1) { fail("usage_shape"); return; }
      let inputTokens = 0;
      let outputTokens = 0;
      for (const metric of metrics) {
        served(metric?.modelId);
        const counts = metric?.metrics?.usage;
        // Measured (2026-10-20, Copilot 1.0.91, gpt-5-mini): inputTokens 5,071
        // = tokenDetails input 2,511 + cache_read 2,560, so it includes cache
        // reads. Cache writes were 0, so their inclusion is unmeasured and a
        // nonzero value is an unknown usage, never a guess.
        if (!token(counts?.inputTokens) || !token(counts?.outputTokens) ||
            !token(counts?.cacheWriteTokens)) {
          fail("usage_shape"); return;
        }
        if (counts.cacheWriteTokens !== 0) { fail("usage_semantics_unmeasured"); return; }
        inputTokens += counts.inputTokens;
        outputTokens += counts.outputTokens;
      }
      // Checkpoints are cumulative for the session; the last one counts.
      usage = { inputTokens, outputTokens };
    }
  };

  const cursor = (event) => {
    if (!CURSOR_EVENTS.has(event.type)) { fail("unexpected_event"); return; }
    if (resultSeen) { fail("event_after_result"); return; }
    if (event.type === "system") {
      if (event.subtype !== "init" || initSeen || lines !== 1) fail("init_order");
      initSeen = true;
      return;
    }
    if (!initSeen) { fail("init_order"); return; }
    if (event.type === "tool_call") {
      const call = event.tool_call;
      const names = call && typeof call === "object"
        ? Object.keys(call).filter((key) => key.endsWith("ToolCall")) : [];
      if (names.length !== 1 || !CURSOR_TOOLS.has(names[0])) { fail("tool_refused"); return; }
      const args = call[names[0]]?.args ?? {};
      for (const key of ["path", "targetDirectory", "directory"])
        checkPath(args[key], key === "path" && names[0] === "readToolCall");
      finalText = [];
      return;
    }
    if (event.type === "assistant") {
      const content = event.message?.content;
      if (!Array.isArray(content)) { fail("assistant_shape"); return; }
      for (const block of content)
        if (block?.type === "text" && typeof block.text === "string") finalText.push(block.text);
      return;
    }
    if (event.type === "result") {
      const counts = event.usage;
      if (event.subtype !== "success" || event.is_error !== false ||
          typeof event.result !== "string") { fail("result_error"); return; }
      if (![counts?.inputTokens, counts?.outputTokens, counts?.cacheReadTokens,
        counts?.cacheWriteTokens].every(token)) { fail("usage_shape"); return; }
      resultSeen = true;
      // Measured: `result` joins every assistant text of the run, including the
      // narration before a tool call. The answer is the text after the last
      // tool call only.
      answer = finalText.join("");
      // Measured inside the v19 sandbox (2026-10-20, Cursor 2026.10.01, model
      // auto, same synthetic prompt): six runs reported cacheReadTokens 19,968
      // with inputTokens 8,364-8,366, so inputTokens never includes cache
      // reads and the prompt is their sum. cacheWriteTokens was 0 in all seven
      // runs whose raw usage was recorded, so whether inputTokens includes
      // cache writes is unmeasured; a nonzero value is an unknown usage.
      if (counts.cacheWriteTokens !== 0) { fail("usage_semantics_unmeasured"); return; }
      usage = { inputTokens: counts.inputTokens + counts.cacheReadTokens,
        outputTokens: counts.outputTokens };
    }
  };

  const observeLine = (line) => {
    if (line.trim() === "") return;
    lines += 1;
    let event;
    try { event = JSON.parse(line); } catch { fail("invalid_json"); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      fail("non_object_event"); return;
    }
    try {
      if (channel.provider === "openai") codex(event, line);
      else if (channel.provider === "github-copilot") copilot(event);
      else cursor(event);
    } catch { fail("event_shape"); }
  };
  const feed = (text) => {
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      parts.push(text.slice(start, end));
      observeLine(parts.join(""));
      parts = []; size = 0;
      start = end + 1;
    }
    if (start < text.length) {
      size += text.length - start;
      if (size > MAX_LINE) { fail("oversized_line"); parts = []; size = 0; }
      else parts.push(text.slice(start));
    }
  };

  return Object.freeze({
    /** The first refusal's fixed code, or null. Never CLI text or a path. */
    rejectReason() { return Object.freeze({ code: reason, also: Object.freeze([]),
      usageModels: null }); },
    observeChunk(chunk) {
      if (final) { final = { kind: "outcome_unknown" }; return; }
      if (!(chunk instanceof Uint8Array)) { fail("invalid_stream"); return; }
      try { feed(decoder.decode(chunk, { stream: true })); }
      catch { fail("invalid_stream"); parts = []; }
    },
    finish({ exitCode, stdoutComplete, openTrace } = {}) {
      if (final) return final;
      try {
        feed(decoder.decode());
        if (parts.length > 0) observeLine(parts.join(""));
      } catch { fail("invalid_stream"); }
      parts = [];
      if (exitCode !== 0 || stdoutComplete !== true) fail("exit_or_stdout");
      if (channel.provider === "openai") {
        const observed = codexUsage.finish({ exitCode, stdoutComplete: stdoutComplete === true,
          freshEphemeralSession: true });
        // Codex input_tokens include cached input (OpenAI usage semantics).
        usage = observed.completeness === "reported_complete" && observed.observed
          ? { inputTokens: observed.observed.inputTokens,
            outputTokens: observed.observed.outputTokens } : null;
      } else if (!resultSeen) fail("result_missing");
      const traced = openTrace?.files;
      if (openTrace?.kind !== "complete" || !Array.isArray(traced) ||
          traced.some((file) => typeof file !== "string" || !files.has(file)) ||
          new Set(traced).size !== traced.length) fail("trace_unverified");
      else if ([...reads].some((file) => !traced.includes(file))) fail("read_not_traced");
      if (typeof answer !== "string" || answer.trim().length === 0) fail("result_text_missing");
      if (!usage || !token(usage.inputTokens) || !token(usage.outputTokens) ||
          usage.inputTokens + usage.outputTokens <= 0) fail("usage_tokens");
      if (channel.modelAttestation === "served" && servedModels.size !== 1)
        fail("served_model_unknown");
      if (reason !== null) {
        answer = null;
        final = { kind: "outcome_unknown" };
        return final;
      }
      final = { kind: "verified_success", rawModelOutput: answer,
        readFiles: [...traced].sort(), inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        modelAttestation: channel.modelAttestation };
      answer = null;
      return final;
    },
  });
}
