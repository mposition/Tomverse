/** V22 Tasks need their own environment gate, not the legacy execution switch. */
export const AMUX_V22_TASK_EXECUTION_CODE_LATCH = true;
export const AMUX_V22_TASK_EXECUTION_ENV = "TOMVERSE_AMUX_V22_TASK_EXECUTION";

export function amuxV22TaskExecutionEnabled(value: string | undefined) {
  return AMUX_V22_TASK_EXECUTION_CODE_LATCH && value === "enabled";
}

/** Orchestration policy v49 opens the code latch for the public PR path. The
 * path still needs its own runtime switch, engineering mode t1 and a verified
 * image proof; opening this latch alone publishes nothing. */
export const AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH = true;
export const AMUX_V22_ENGINEERING_PUBLICATION_ENV =
  "TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION";

export function amuxV22EngineeringPublicationEnabled(value: string | undefined) {
  return AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH && value === "enabled";
}

export const AMUX_V22_SEALED_DELIVERY_MARKER = "amux-v22:sealed-brief";

/** Settlement must use the same sealed patch it read before the transaction.
 * A patch arriving or being purged between those reads is not a private
 * result and cannot be silently ignored. */
export function v22SettlementPatchMatches(input: {
  taskId: string;
  readPatch: { taskId: string; sha256: string; baseSha: string } | null;
  storedPatch: { taskId: string; patchSha256: string; baseSha: string;
    bodyPurgedAt: Date | null } | null;
}) {
  const { readPatch, storedPatch } = input;
  if (readPatch === null || storedPatch === null)
    return readPatch === null && storedPatch === null;
  return readPatch.taskId === input.taskId &&
    storedPatch.taskId === input.taskId &&
    readPatch.sha256 === storedPatch.patchSha256 &&
    readPatch.baseSha === storedPatch.baseSha &&
    storedPatch.bodyPurgedAt === null;
}

/** apps/tomverse-orchestrator send_v22 refuses a larger budget field. */
export const AMUX_V22_BRIDGE_BUDGET_MAX_MICROUSD = 5_000_000;

/** The budget field a v22 delivery carries. An ordinary run is not budget
 * bound (owner decision 2026-10-25), so its field only has to stay within the
 * box bridge's wire range; the read-only retry carries its exact signed
 * amount. */
export function amuxV22DeliveryBudgetMicrousd(reservedMicrousd: number,
  readOnlyRetry: boolean) {
  return readOnlyRetry ? reservedMicrousd :
    Math.min(reservedMicrousd, AMUX_V22_BRIDGE_BUDGET_MAX_MICROUSD);
}

/** One supervised CLI process is the whole v22 attempt. Its invocation ID is
 * the durable attempt ID, allocated before dispatch. A caller-supplied subset
 * of receipts cannot turn an unobserved second call into a successful run. */
/** The usage source each one-shot executor writes, by assignment provider. */
export type V22ExecutionSource = "claude_result" | "anthropic_messages_api" |
  "codex_jsonl" | "copilot_json" | "cursor_stream";
const V22_EXECUTOR_BY_SOURCE: Record<V22ExecutionSource, string> = {
  claude_result: "claude", anthropic_messages_api: "anthropic_api",
  codex_jsonl: "codex", copilot_json: "copilot", cursor_stream: "cursor",
};
const V22_UNATTESTED_SOURCES = new Set<V22ExecutionSource>(["codex_jsonl", "cursor_stream"]);
export const v22ExecutionSourceForProvider = (provider: string): V22ExecutionSource | null =>
  ({ anthropic: "claude_result", openai: "codex_jsonl",
    "github-copilot": "copilot_json", cursor: "cursor_stream" } as const)[
    provider as "anthropic" | "openai" | "github-copilot" | "cursor"] ?? null;

export function v22ExecutionReceiptVerified(input: {
  attemptId: string;
  invocationIds: string[];
  events: Array<{ invocationId: string; status: string;
    completeness: string; projectedApiCostMicrousd: bigint | null;
    cli: string; source: string; actualModelId: string | null;
    selectedModelId: string }>;
  outcome: "succeeded" | "failed" | "blocked";
  reservedCostMicrousd: bigint;
  resultStored: boolean;
  /** Null (an assignment provider with no executor) never settles. */
  expectedExecutionSource?: V22ExecutionSource | null;
  /** The attempt ran under a dollar budget: only the one-off read-only
   * retry does, bound to its signed risk acceptance. */
  budgetBound: boolean;
}) {
  if (input.invocationIds.length !== 1 ||
      input.invocationIds[0] !== input.attemptId ||
      input.events.length !== 1 ||
      input.reservedCostMicrousd <= BigInt(0) ||
      input.expectedExecutionSource === null) return false;
  const event = input.events[0];
  const expectedSource = input.expectedExecutionSource ?? "claude_result";
  const expectedExecutor = V22_EXECUTOR_BY_SOURCE[expectedSource];
  return (input.outcome !== "succeeded" || input.resultStored) &&
    event.invocationId === input.attemptId &&
    event.completeness === "reported_complete" &&
    event.cli === expectedExecutor && event.source === expectedSource &&
    // Codex and Cursor never name the model that answered (v19's "requested"
    // attestation). Owner decision 2026-10-26: their v22 runs settle on the
    // selected model; a CLI that does name one must name the selected one.
    (event.actualModelId === null ? V22_UNATTESTED_SOURCES.has(expectedSource) :
      event.actualModelId === event.selectedModelId) &&
    // Owner decision 2026-10-25: a run without a dollar budget settles on its
    // observed usage; comparing it with the reservation would only strand a
    // run already paid for. The one-off read-only retry ran under its signed
    // budget, so its projection must still fit.
    (!input.budgetBound ||
      (event.projectedApiCostMicrousd !== null &&
       event.projectedApiCostMicrousd <= input.reservedCostMicrousd)) &&
    (input.outcome === "succeeded" ? event.status === "succeeded" :
      event.status === "succeeded" || event.status === "failed");
}

/** The native API receipt and the immutable usage-ledger projection must say
 * exactly the same thing before the ordinary v22 settlement may proceed. */
export function v22ReadOnlyApiReceiptMatchesUsage(input: {
  attemptId: string;
  outcome: "succeeded" | "failed" | "blocked";
  pricingVersion: string;
  receipt: {
    attemptId: string; invocationId: string; selectedModelId: string;
    actualModelId: string; providerTurnCount: number;
    uncachedInputTokens: number; cacheReadTokens: number;
    cacheWriteTokens: number; outputTokens: number;
    terminalStatus: "succeeded" | "failed"; projectedCostMicroUsd: number;
    digest: string;
  };
  event: {
    invocationId: string; receiptDigest: string; cli: string; source: string;
    provider: string; authentication: string;
    selectedModelId: string; actualModelId: string | null;
    completedTurns: number; inputTokens: bigint | null;
    cacheReadInputTokens: bigint | null;
    cacheCreationInputTokens: bigint | null; outputTokens: bigint | null;
    inputTokensIncludeCacheRead: boolean;
    inputTokensIncludeCacheWrite: boolean | null;
    pricingVersion: string | null; projectedApiCostMicrousd: bigint | null;
  };
}) {
  const { receipt, event } = input;
  return input.outcome !== "blocked" &&
    receipt.attemptId === input.attemptId &&
    receipt.invocationId === input.attemptId &&
    receipt.terminalStatus === input.outcome &&
    event.invocationId === input.attemptId &&
    event.receiptDigest === receipt.digest &&
    event.cli === "anthropic_api" &&
    event.source === "anthropic_messages_api" &&
    event.provider === "anthropic" && event.authentication === "api_key" &&
    event.selectedModelId === receipt.selectedModelId &&
    event.actualModelId === receipt.actualModelId &&
    event.completedTurns === receipt.providerTurnCount &&
    event.inputTokens === BigInt(receipt.uncachedInputTokens) &&
    event.cacheReadInputTokens === BigInt(receipt.cacheReadTokens) &&
    event.cacheCreationInputTokens === BigInt(receipt.cacheWriteTokens) &&
    event.outputTokens === BigInt(receipt.outputTokens) &&
    event.inputTokensIncludeCacheRead === false &&
    event.inputTokensIncludeCacheWrite === false &&
    event.pricingVersion === input.pricingVersion &&
    event.projectedApiCostMicrousd === BigInt(receipt.projectedCostMicroUsd);
}
