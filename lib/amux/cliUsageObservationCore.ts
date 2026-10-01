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
  models: Array<{ modelId: string; observed: AmuxCliTokenCounts }>;
};

const CODEX_LINE_MAX_BYTES = 1_048_576;
const MAX_TURNS = 128;
const MAX_MODELS = 16;
const MODEL_ID = /^[A-Za-z0-9._/-]{1,160}$/;
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
      !token(value.output_tokens) || !token(value.reasoning_output_tokens) ||
      value.cached_input_tokens > value.input_tokens) return null;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cacheReadInputTokens: value.cached_input_tokens,
    cacheCreationInputTokens: null,
    reasoningOutputTokens: value.reasoning_output_tokens,
  };
};

/** Feed stdout JSONL one line at a time. Unrecognised content is discarded;
 * malformed/oversized events make the result unknown, not a zero-cost run. */
export function createCodexCliUsageObserver() {
  let completedTurns = 0;
  let startedTurns = 0;
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
      if (event.type === "turn.started") {
        startedTurns += 1;
        if (startedTurns > MAX_TURNS) malformed = true;
      } else if (event.type === "turn.failed" || event.type === "error") {
        failed = true;
      } else if (event.type === "turn.completed") {
        completedTurns += 1;
        const usage = codexUsage(event.usage);
        if (completedTurns > MAX_TURNS || !usage) { malformed = true; return; }
        const next = observed ? sumCounts(observed, usage) : usage;
        if (!next) { malformed = true; return; }
        observed = next;
      }
    },
    finish(exitCode: number | null): AmuxCliUsageObservation {
      if (finished) return finished;
      // Missing turn.started or a dangling turn means the event stream cannot
      // establish a complete invocation, even if the process exited cleanly.
      const complete = !malformed && !failed && exitCode === 0 &&
        completedTurns > 0 && startedTurns === completedTurns;
      finished = {
        version: 1,
        cli: "codex",
        completeness: complete ? "reported_complete" :
          !malformed && observed ? "reported_partial" : "unknown",
        observed: malformed ? null : observed,
        completedTurns,
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
 * and is never added to aggregate usage a second time. */
export function inspectClaudeCliResultUsage(raw: unknown, exitCode: number | null): AmuxCliUsageObservation {
  const unknown: AmuxCliUsageObservation = {
    version: 1, cli: "claude", completeness: "unknown",
    observed: null, completedTurns: 0, models: [],
  };
  const result = record(raw);
  if (!result || result.type !== "result") return unknown;
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
  return {
    version: 1,
    cli: "claude",
    completeness: exitCode === 0 && result.subtype === "success" && result.is_error !== true
      ? "reported_complete" : "reported_partial",
    observed,
    // One CLI result may contain several assistant turns. This is a result
    // count, not a claim that all internal provider calls were observed.
    completedTurns: token(result.num_turns) && result.num_turns > 0
      ? result.num_turns : 0,
    models,
  };
}
