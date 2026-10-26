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
  expectedExecutionSource?: "claude_result" | "anthropic_messages_api";
  /** The attempt ran under a dollar budget: only the one-off read-only
   * retry does, bound to its signed risk acceptance. */
  budgetBound: boolean;
}) {
  if (input.invocationIds.length !== 1 ||
      input.invocationIds[0] !== input.attemptId ||
      input.events.length !== 1 ||
      input.reservedCostMicrousd <= BigInt(0)) return false;
  const event = input.events[0];
  const expectedSource = input.expectedExecutionSource ?? "claude_result";
  const expectedExecutor = expectedSource === "anthropic_messages_api" ?
    "anthropic_api" : "claude";
  return (input.outcome !== "succeeded" || input.resultStored) &&
    event.invocationId === input.attemptId &&
    event.completeness === "reported_complete" &&
    // Codex JSONL currently reports the configured model, not an attested
    // provider-served model. Keep its usage for telemetry but never settle a
    // v22 Task until independent served-model evidence exists.
    event.cli === expectedExecutor && event.source === expectedSource &&
    event.actualModelId !== null &&
    event.actualModelId === event.selectedModelId &&
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
