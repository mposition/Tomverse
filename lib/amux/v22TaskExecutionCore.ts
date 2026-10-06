/** A15 ships dark. The legacy execution API switch never opens v22 Tasks. */
export const AMUX_V22_TASK_EXECUTION_CODE_LATCH = false;
export const AMUX_V22_TASK_EXECUTION_ENV = "TOMVERSE_AMUX_V22_TASK_EXECUTION";

export function amuxV22TaskExecutionEnabled(value: string | undefined) {
  return AMUX_V22_TASK_EXECUTION_CODE_LATCH && value === "enabled";
}

export const AMUX_V22_SEALED_DELIVERY_MARKER = "amux-v22:sealed-brief";

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
