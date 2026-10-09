/** A15 ships dark. The legacy execution API switch never opens v22 Tasks. */
export const AMUX_V22_TASK_EXECUTION_CODE_LATCH = false;
export const AMUX_V22_TASK_EXECUTION_ENV = "TOMVERSE_AMUX_V22_TASK_EXECUTION";

export function amuxV22TaskExecutionEnabled(value: string | undefined) {
  return AMUX_V22_TASK_EXECUTION_CODE_LATCH && value === "enabled";
}

/** Opening Task execution never opens its optional public PR path. The
 * separate publication latch remains closed until a verified image proof and
 * a separately approved activation. Policy v4 approval alone does not open it. */
export const AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH = false;
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

export function v22ExecutionCostWithinAssignment(input: {
  assignedMicroUsd: bigint;
  currentMicroUsd: bigint;
  approvedCeilingMicroUsd: bigint;
  priorReservedMicroUsd: bigint;
}) {
  return input.assignedMicroUsd > BigInt(0) &&
    input.currentMicroUsd >= BigInt(0) &&
    input.priorReservedMicroUsd >= BigInt(0) &&
    input.approvedCeilingMicroUsd > BigInt(0) &&
    input.currentMicroUsd <= input.assignedMicroUsd &&
    input.priorReservedMicroUsd + input.assignedMicroUsd <=
      input.approvedCeilingMicroUsd;
}

/** One supervised CLI process is the whole v22 attempt. Its invocation ID is
 * the durable attempt ID, allocated before dispatch. A caller-supplied subset
 * of receipts cannot turn an unobserved second call into a successful run. */
export function v22ExecutionReceiptVerified(input: {
  attemptId: string;
  invocationIds: string[];
  events: Array<{ invocationId: string; status: string;
    completeness: string; projectedApiCostMicrousd: bigint | null;
    source: string; actualModelId: string | null;
    selectedModelId: string }>;
  outcome: "succeeded" | "failed" | "blocked";
  reservedCostMicrousd: bigint;
  resultStored: boolean;
}) {
  if (input.invocationIds.length !== 1 ||
      input.invocationIds[0] !== input.attemptId ||
      input.events.length !== 1 ||
      input.reservedCostMicrousd <= BigInt(0)) return false;
  const event = input.events[0];
  return (input.outcome !== "succeeded" || input.resultStored) &&
    event.invocationId === input.attemptId &&
    event.completeness === "reported_complete" &&
    // Codex JSONL currently reports the configured model, not an attested
    // provider-served model. Keep its usage for telemetry but never settle a
    // v22 Task until independent served-model evidence exists.
    event.source === "claude_result" &&
    event.actualModelId !== null &&
    event.actualModelId === event.selectedModelId &&
    event.projectedApiCostMicrousd !== null &&
    event.projectedApiCostMicrousd <= input.reservedCostMicrousd &&
    (input.outcome === "succeeded" ? event.status === "succeeded" :
      event.status === "succeeded" || event.status === "failed");
}
