import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { AmuxCliTokenCounts, AmuxCliUsageObservation } from "./cliUsageObservationCore.ts";

/** A bounded, content-free wire receipt. This is not a provider invoice or an
 * execution authority. A future DB writer must still bind every identifier to
 * a leased attempt/chunk and reserve budget before a CLI invocation. */
export type AmuxCliUsageLedgerEvent = {
  version: 1;
  invocationId: string;
  context:
    | { kind: "worker"; cardId: string; taskId: string; runId: string; attemptId: string; workerId: string }
    | { kind: "idea_analysis"; ideaId: string; chunkIndex: number; agentId: "amux-intake" };
  cli: "codex" | "claude";
  cliVersion: string;
  authKind: "subscription" | "api_key";
  /** Requested model only. Codex CLI usage does not attest the served model. */
  selectedModelId: string;
  startedAt: string;
  endedAt: string;
  status: "succeeded" | "failed" | "timeout" | "outcome_unknown";
  observation: AmuxCliUsageObservation;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9:_-]{1,160}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9._/\[\]-]{1,160}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** A route passes JSON data, not live objects. Reject proxies, accessors and
 * cycles before reading the same property twice for validation and receipt. */
const plainDataTree = (value: unknown, depth = 0, ancestors = new Set<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 8 || nodeTypes.isProxy(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 16 ||
          Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
            !plainDataTree(descriptor.value, depth + 1, ancestors)) return false;
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length > 24) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
          !plainDataTree(descriptor.value, depth + 1, ancestors)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (!Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
};
const keys = (value: Record<string, unknown>, names: string[]): boolean =>
  Object.keys(value).sort().join("\0") === names.sort().join("\0");
const modelId = (value: unknown): value is string =>
  typeof value === "string" && MODEL_ID.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const parseCounts = (value: unknown): AmuxCliTokenCounts | null => {
  const row = record(value);
  if (!row || !keys(row, ["inputTokens", "outputTokens", "cacheReadInputTokens",
    "cacheCreationInputTokens", "reasoningOutputTokens"]) ||
      !count(row.inputTokens) || !count(row.outputTokens) ||
      !count(row.cacheReadInputTokens) ||
      (row.cacheCreationInputTokens !== null && !count(row.cacheCreationInputTokens)) ||
      (row.reasoningOutputTokens !== null && !count(row.reasoningOutputTokens))) return null;
  return {
    inputTokens: row.inputTokens === 0 ? 0 : row.inputTokens,
    outputTokens: row.outputTokens === 0 ? 0 : row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens === 0 ? 0 : row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens === 0 ? 0 : row.cacheCreationInputTokens,
    reasoningOutputTokens: row.reasoningOutputTokens === 0 ? 0 : row.reasoningOutputTokens,
  } as AmuxCliTokenCounts;
};

const countsFitCli = (cli: "codex" | "claude", value: AmuxCliTokenCounts): boolean =>
  cli === "codex"
    ? value.cacheReadInputTokens <= value.inputTokens &&
      (value.reasoningOutputTokens === null || value.reasoningOutputTokens <= value.outputTokens)
    : value.cacheCreationInputTokens !== null && value.reasoningOutputTokens === null;

const sum = (left: number, right: number): number | null =>
  Number.isSafeInteger(left + right) ? left + right : null;

/** Returns null for any unknown field or inconsistent observation. No raw CLI
 * result, prompt, transcript, error text or credential can enter the receipt. */
export function inspectAmuxCliUsageLedgerEvent(raw: unknown):
  { event: AmuxCliUsageLedgerEvent; receiptDigest: string } | null {
  if (!plainDataTree(raw)) return null;
  const value = record(raw);
  if (!value || !keys(value, ["version", "invocationId", "context", "cli", "cliVersion",
    "authKind", "selectedModelId", "startedAt", "endedAt", "status", "observation"]) ||
      value.version !== 1 || typeof value.invocationId !== "string" ||
      !UUID_V4.test(value.invocationId) ||
      (value.cli !== "codex" && value.cli !== "claude") ||
      typeof value.cliVersion !== "string" || !VERSION.test(value.cliVersion) ||
      (value.authKind !== "subscription" && value.authKind !== "api_key") ||
      !modelId(value.selectedModelId) || !isoTime(value.startedAt) ||
      !isoTime(value.endedAt) || value.endedAt < value.startedAt ||
      !["succeeded", "failed", "timeout", "outcome_unknown"].includes(value.status as string)) return null;

  const context = record(value.context);
  if (!context) return null;
  if (context.kind === "worker") {
    if (!keys(context, ["kind", "cardId", "taskId", "runId", "attemptId", "workerId"]) ||
        ![context.cardId, context.taskId, context.runId, context.attemptId, context.workerId]
          .every((item) => typeof item === "string" && ID.test(item))) return null;
  } else if (context.kind === "idea_analysis") {
    if (!keys(context, ["kind", "ideaId", "chunkIndex", "agentId"]) ||
        typeof context.ideaId !== "string" || !ID.test(context.ideaId) ||
        !count(context.chunkIndex) || context.agentId !== "amux-intake") return null;
  } else return null;

  const observation = record(value.observation);
  if (!observation || !keys(observation, ["version", "cli", "completeness", "observed",
    "completedTurns", "inputTokensIncludeCacheRead", "inputTokensIncludeCacheWrite",
    "reasoningOutputIncludedInOutput", "models"]) ||
      observation.version !== 1 || observation.cli !== value.cli ||
      !["reported_complete", "reported_partial", "unknown"].includes(observation.completeness as string) ||
      !count(observation.completedTurns) || observation.completedTurns > 128 ||
      !Array.isArray(observation.models) || observation.models.length > 16) return null;
  const observed = observation.observed === null ? null : parseCounts(observation.observed);
  if ((observation.observed !== null && observed === null) ||
      (observation.completeness === "unknown" && observation.observed !== null) ||
      (observation.completeness !== "unknown" && observed === null) ||
      (observed !== null && (!countsFitCli(value.cli, observed) ||
        !(value.cli === "codex"
          ? observed.inputTokens > 0 || observed.outputTokens > 0
          : [observed.inputTokens, observed.outputTokens, observed.cacheReadInputTokens,
              observed.cacheCreationInputTokens ?? 0].some((item) => item > 0))))) return null;
  if (value.cli === "codex" ?
      observation.inputTokensIncludeCacheRead !== true ||
        observation.inputTokensIncludeCacheWrite !== null ||
        observation.reasoningOutputIncludedInOutput !== true ||
        observation.models.length !== 0 || observation.completedTurns > 1 :
      observation.inputTokensIncludeCacheRead !== false ||
        observation.inputTokensIncludeCacheWrite !== false ||
        observation.reasoningOutputIncludedInOutput !== null) return null;
  if (observation.completeness === "reported_complete" &&
      (value.status !== "succeeded" ||
       (value.cli === "codex" ? observation.completedTurns !== 1 :
        observation.completedTurns === 0 || observation.models.length === 0))) return null;
  if (value.cli === "codex" && observation.completeness === "reported_partial" &&
      observed !== null && observation.completedTurns !== 1) return null;
  if (value.cli === "claude" && observation.completeness === "unknown" &&
      observation.completedTurns !== 0) return null;
  if (observation.models.length > 0 && observed === null) return null;

  const models: AmuxCliUsageObservation["models"] = [];
  const seen = new Set<string>();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (let index = 0; index < observation.models.length; index += 1) {
    const rawModel = observation.models[index];
    const model = record(rawModel);
    if (!model || !keys(model, ["modelId", "observed"]) ||
        !modelId(model.modelId) || seen.has(model.modelId)) return null;
    const counts = parseCounts(model.observed);
    if (!counts || !countsFitCli(value.cli, counts)) return null;
    seen.add(model.modelId);
    input = sum(input, counts.inputTokens) ?? -1;
    output = sum(output, counts.outputTokens) ?? -1;
    cacheRead = sum(cacheRead, counts.cacheReadInputTokens) ?? -1;
    cacheWrite = sum(cacheWrite, counts.cacheCreationInputTokens ?? 0) ?? -1;
    if ([input, output, cacheRead, cacheWrite].some((item) => item < 0)) return null;
    models.push({ modelId: model.modelId, observed: counts });
  }
  if (models.length > 0 && observed &&
      (input !== observed.inputTokens || output !== observed.outputTokens ||
       cacheRead !== observed.cacheReadInputTokens ||
       cacheWrite !== (observed.cacheCreationInputTokens ?? 0))) return null;
  // Claude modelUsage is a map whose JSON property order is not a stable
  // identity. Model order must not alter the idempotency receipt digest.
  models.sort((left, right) => left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0);

  const event: AmuxCliUsageLedgerEvent = {
    version: 1, invocationId: value.invocationId,
    context: context.kind === "worker"
      ? { kind: "worker", cardId: context.cardId as string,
        taskId: context.taskId as string, runId: context.runId as string,
        attemptId: context.attemptId as string, workerId: context.workerId as string }
      : { kind: "idea_analysis", ideaId: context.ideaId as string,
        chunkIndex: context.chunkIndex === 0 ? 0 : context.chunkIndex as number,
        agentId: "amux-intake" },
    cli: value.cli, cliVersion: value.cliVersion, authKind: value.authKind,
    selectedModelId: value.selectedModelId,
    startedAt: value.startedAt, endedAt: value.endedAt,
    status: value.status as AmuxCliUsageLedgerEvent["status"],
    observation: {
      version: 1, cli: value.cli,
      completeness: observation.completeness as AmuxCliUsageObservation["completeness"],
      observed,
      completedTurns: observation.completedTurns === 0 ? 0 : observation.completedTurns,
      inputTokensIncludeCacheRead: observation.inputTokensIncludeCacheRead as boolean,
      inputTokensIncludeCacheWrite: observation.inputTokensIncludeCacheWrite as boolean | null,
      reasoningOutputIncludedInOutput: observation.reasoningOutputIncludedInOutput as boolean | null,
      models,
    },
  };
  const receiptDigest = createHash("sha256")
    .update("amux-cli-usage-ledger:v1\n")
    .update(JSON.stringify(event))
    .digest("hex");
  return { event, receiptDigest };
}
