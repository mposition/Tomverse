/** Closed wire for the orchestrator's admitted tick. A v22 receipt is never
 * represented as a legacy v8 grant consumption. */
export function v22PromotionTickWire(result:
  | { promoted: true; taskId: string; receiptId: string }
  | { promoted: false; reason: string; taskId?: string; receiptId?: string }) {
  if (result.promoted) return { promoted: true as const,
    policy_version: 22 as const, task_id: result.taskId,
    receipt_id: result.receiptId };
  return { promoted: false as const, policy_version: 22 as const,
    reason: result.reason };
}

export function v22WorkerClaimTickWire(result:
  | { claimed: true; taskId: string; assignmentId: string; workerName: string }
  | { claimed: false; reason: string }) {
  if (result.claimed) return { promoted: false as const,
    claimed: true as const, policy_version: 22 as const,
    task_id: result.taskId, assignment_id: result.assignmentId,
    worker_name: result.workerName };
  return { promoted: false as const, policy_version: 22 as const,
    reason: result.reason };
}
