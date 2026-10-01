/** Read-only CLI usage observations for future AMUX worker telemetry. These
 * are not invoices, user credits or authority to spend. The caller must keep
 * stdout/transcripts out of logs and retain only this bounded projection. */

export type AmuxCliUsageCompleteness = "reported_complete" | "reported_partial" | "unknown";

export type AmuxCliTokenCounts = {
  /** Provider-reported input category; its cache semantics differ by CLI. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number | null;
  reasoningOutputTokens: number | null;
};

export type AmuxCliUsageObservation = {
  version: 1;
  cli: "codex" | "claude";
  completeness: AmuxCliUsageCompleteness;
  /** Null means no trustworthy numeric report, never zero spend. */
  observed: AmuxCliTokenCounts | null;
  completedTurns: number;
  /** Codex input includes cached input; Claude input excludes cache reads. */
  inputTokensIncludeCacheRead: boolean;
  /** Codex cache-write inclusion is not yet verified for pricing; never infer it. */
  inputTokensIncludeCacheWrite: boolean | null;
  /** Codex reasoning is a subset of output, never an additional charge. */
  reasoningOutputIncludedInOutput: boolean | null;
  models: Array<{ modelId: string; observed: AmuxCliTokenCounts }>;
};

const CODEX_LINE_MAX_BYTES = 1_048_576;
const MAX_TURNS = 128;
const MAX_MODELS = 16;
const MODEL_ID = /^[A-Za-z0-9._/\[\]-]{1,160}$/;
const validModelId = (value: string): boolean => MODEL_ID.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const record = (raw: unknown): Record<string, unknown> | null =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;

const token = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;

const add = (left: number, right: number): number | null => {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
};

const sumCounts = (left: AmuxCliTokenCounts, right: AmuxCliTokenCounts): AmuxCliTokenCounts | null => {
  const inputTokens = add(left.inputTokens, right.inputTokens);
  const outputTokens = add(left.outputTokens, right.outputTokens);
  const cacheReadInputTokens = add(left.cacheReadInputTokens, right.cacheReadInputTokens);
  const cacheCreationInputTokens = left.cacheCreationInputTokens === null ||
    right.cacheCreationInputTokens === null ? null :
    add(left.cacheCreationInputTokens, right.cacheCreationInputTokens);
  const reasoningOutputTokens = left.reasoningOutputTokens === null ||
    right.reasoningOutputTokens === null ? null :
    add(left.reasoningOutputTokens, right.reasoningOutputTokens);
  if (inputTokens === null || outputTokens === null || cacheReadInputTokens === null ||
      (left.cacheCreationInputTokens !== null && right.cacheCreationInputTokens !== null &&
       cacheCreationInputTokens === null) ||
      (left.reasoningOutputTokens !== null && right.reasoningOutputTokens !== null &&
       reasoningOutputTokens === null)) return null;
  return { inputTokens, outputTokens, cacheReadInputTokens,
    cacheCreationInputTokens, reasoningOutputTokens };
};

const codexUsage = (raw: unknown): AmuxCliTokenCounts | null => {
  const value = record(raw);
  if (!value || !token(value.input_tokens) || !token(value.cached_input_tokens) ||
      !token(value.output_tokens) ||
      (value.reasoning_output_tokens !== undefined && !token(value.reasoning_output_tokens)) ||
      (value.cache_write_input_tokens !== undefined && !token(value.cache_write_input_tokens)) ||
      value.cached_input_tokens > value.input_tokens ||
      (value.reasoning_output_tokens !== undefined &&
       value.reasoning_output_tokens > value.output_tokens)) return null;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cacheReadInputTokens: value.cached_input_tokens,
    cacheCreationInputTokens: value.cache_write_input_tokens === undefined
      ? null : value.cache_write_input_tokens,
    reasoningOutputTokens: value.reasoning_output_tokens === undefined
      ? null : value.reasoning_output_tokens,
  };
};

/** Feed stdout JSONL one line at a time. Unrecognised content is discarded;
 * malformed/oversized events make the result unknown, not a zero-cost run.
 * Codex 0.155.1 emits session-cumulative usage on turn.completed, so only one
 * fresh ephemeral turn can yield a per-invocation observation. Source:
 * https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs
 * (`usage_from_last_total` copies `usage.total`, or defaults to zero). */
export function createCodexCliUsageObserver() {
  let completedTurns = 0;
  let threadStarted = false;
  let inFlight = false;
  let failed = false;
  let malformed = false;
  let observed: AmuxCliTokenCounts | null = null;
  let finished: AmuxCliUsageObservation | null = null;
  return {
    observeLine(line: string): void {
      if (finished || malformed) return;
      if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > CODEX_LINE_MAX_BYTES) {
        malformed = true;
        return;
      }
      if (line.trim() === "") return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { malformed = true; return; }
      const event = record(parsed);
      if (!event || typeof event.type !== "string") { malformed = true; return; }
      if (event.type === "thread.started") {
        if (threadStarted || inFlight || completedTurns > 0) malformed = true;
        else threadStarted = true;
      } else if (event.type === "turn.started") {
        if (!threadStarted || inFlight || completedTurns > 0) malformed = true;
        else inFlight = true;
      } else if (event.type === "turn.failed" || event.type === "error") {
        failed = true;
        if (event.type === "turn.failed") inFlight = false;
      } else if (event.type === "turn.completed") {
        if (!inFlight || completedTurns > 0) { malformed = true; return; }
        inFlight = false;
        const usage = codexUsage(event.usage);
        if (!usage) { malformed = true; return; }
        completedTurns = 1;
        observed = usage;
      }
    },
    finish(options: {
      exitCode: number | null;
      stdoutComplete: boolean;
      freshEphemeralSession: boolean;
    }): AmuxCliUsageObservation {
      if (finished) return finished;
      // Without an exact fresh-session command and complete stdout capture,
      // cumulative totals may include earlier work or hide a trailing failure.
      const trusted = !malformed && options.stdoutComplete && options.freshEphemeralSession;
      const nonzero = observed && (observed.inputTokens > 0 || observed.outputTokens > 0);
      const complete = trusted && !failed && !inFlight && options.exitCode === 0 &&
        completedTurns === 1 && nonzero;
      finished = {
        version: 1,
        cli: "codex",
        completeness: complete ? "reported_complete" :
          trusted && nonzero ? "reported_partial" : "unknown",
        observed: trusted && nonzero ? observed : null,
        completedTurns,
        inputTokensIncludeCacheRead: true,
        inputTokensIncludeCacheWrite: null,
        reasoningOutputIncludedInOutput: true,
        models: [], // The caller binds its approved selected model separately.
      };
      return finished;
    },
  };
}

const claudeModelUsage = (raw: unknown): AmuxCliTokenCounts | null => {
  const value = record(raw);
  if (!value || !token(value.inputTokens) || !token(value.outputTokens) ||
      !token(value.cacheReadInputTokens) || !token(value.cacheCreationInputTokens)) return null;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadInputTokens: value.cacheReadInputTokens,
    cacheCreationInputTokens: value.cacheCreationInputTokens,
    reasoningOutputTokens: null,
  };
};

/** A parsed Claude Code print-mode result, not an assistant message. Claude
 * result usage can under-report on certain failures; modelUsage is preferred
 * and is never added to aggregate usage a second time. A resumed session's
 * aggregate is not a per-invocation measurement. */
export function inspectClaudeCliResultUsage(raw: unknown, options: {
  exitCode: number | null;
  stdoutComplete: boolean;
  freshPrintInvocation: boolean;
}): AmuxCliUsageObservation {
  const unknown: AmuxCliUsageObservation = {
    version: 1, cli: "claude", completeness: "unknown",
    observed: null, completedTurns: 0, models: [],
    inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false,
    reasoningOutputIncludedInOutput: null,
  };
  if (!options.stdoutComplete || !options.freshPrintInvocation) return unknown;
  const result = record(raw);
  if (!result || result.type !== "result") return unknown;
  if (result.modelUsage !== undefined && result.model_usage !== undefined) return unknown;
  const usageByModel = record(result.modelUsage ?? result.model_usage);
  let observed: AmuxCliTokenCounts | null = null;
  const models: AmuxCliUsageObservation["models"] = [];
  if (usageByModel) {
    const entries = Object.entries(usageByModel);
    if (entries.length < 1 || entries.length > MAX_MODELS) return unknown;
    for (const [modelId, value] of entries) {
      if (!validModelId(modelId)) return unknown;
      const parsed = claudeModelUsage(value);
      if (!parsed) return unknown;
      observed = observed ? sumCounts(observed, parsed) : parsed;
      if (!observed) return unknown;
      models.push({ modelId, observed: parsed });
    }
  } else if (result.modelUsage !== undefined || result.model_usage !== undefined) {
    return unknown;
  } else {
    const usage = record(result.usage);
    if (!usage || !token(usage.input_tokens) || !token(usage.output_tokens) ||
        !token(usage.cache_read_input_tokens) ||
        !token(usage.cache_creation_input_tokens)) return unknown;
    observed = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      reasoningOutputTokens: null,
    };
  }
  // A successful CLI result containing only default zeroes is not evidence of
  // zero spend. Cache-only usage still counts as a nonzero observation.
  if (!observed || ![
    observed.inputTokens,
    observed.outputTokens,
    observed.cacheReadInputTokens,
    observed.cacheCreationInputTokens ?? 0,
  ].some((count) => count > 0)) return unknown;
  const completedTurns = token(result.num_turns) && result.num_turns > 0 &&
    result.num_turns <= MAX_TURNS ? result.num_turns : 0;
  return {
    version: 1,
    cli: "claude",
    completeness: models.length > 0 && options.exitCode === 0 &&
      result.subtype === "success" && result.is_error !== true && completedTurns > 0
      ? "reported_complete" : "reported_partial",
    observed,
    // One CLI result may contain several assistant turns. This is a result
    // count, not a claim that all internal provider calls were observed.
    completedTurns,
    inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false,
    reasoningOutputIncludedInOutput: null,
    models,
  };
}
