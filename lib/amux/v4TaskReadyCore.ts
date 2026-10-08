/** Read-only v22 qualification. It never changes a lifecycle status or grants
 * claim, promotion, budget, or worker authority. Every missing proof is a hold. */
export const AMUX_V4_TASK_READY_VERSION = "amux-v4-task-ready-v1";

export type AmuxV4TaskReadyReason =
  | "not_v4_task" | "not_backlog" | "already_assigned"
  | "source_approval_invalid" | "brief_or_scope_missing"
  | "role_or_grade_missing" | "parent_path_changed"
  | "dependency_set_changed" | "dependency_incomplete"
  | "cost_reconfirmation_required" | "cost_unavailable"
  | "worker_unavailable" | "orchestrator_halted";

export type AmuxV4TaskReadyFacts = {
  card: { sourceSystem: string | null; cardType: string | null;
    status: string; archived: boolean; owner: string | null;
    claimed: boolean; role: string | null; grade: string | null;
    briefAndScopeVerified: boolean };
  sourceApprovalValid: boolean;
  parentPathCurrent: boolean;
  approvedDependencyIds: readonly string[] | null;
  dependencies: readonly { id: string; approvedTask: boolean;
    status: string; terminal: boolean }[];
  cost: "allow" | "reconfirm" | "hold";
  compatibleWorkerCount: number;
  orchestratorHalted: boolean;
};

export function evaluateAmuxV4TaskReady(facts: AmuxV4TaskReadyFacts,
  expectedStatus: "backlog" | "todo" = "backlog") {
  const reasons: AmuxV4TaskReadyReason[] = [];
  const { card } = facts;
  if (card.sourceSystem !== "admin-idea-v4" || card.cardType !== "task") {
    reasons.push("not_v4_task");
  }
  if (card.status !== expectedStatus || card.archived) reasons.push("not_backlog");
  if (card.owner !== null || card.claimed) reasons.push("already_assigned");
  if (!facts.sourceApprovalValid) reasons.push("source_approval_invalid");
  if (!card.briefAndScopeVerified) reasons.push("brief_or_scope_missing");
  if (!card.role || !card.grade) reasons.push("role_or_grade_missing");
  if (!facts.parentPathCurrent) reasons.push("parent_path_changed");

  const approved = facts.approvedDependencyIds;
  const actualIds = facts.dependencies.map((item) => item.id);
  if (approved === null || new Set(approved).size !== approved.length ||
      new Set(actualIds).size !== actualIds.length ||
      [...approved].sort().join("\0") !== [...actualIds].sort().join("\0") ||
      facts.dependencies.some((item) => !item.approvedTask)) {
    reasons.push("dependency_set_changed");
  } else if (facts.dependencies.some((item) =>
    item.status !== "done" || !item.terminal)) {
    reasons.push("dependency_incomplete");
  }
  if (facts.cost === "reconfirm") reasons.push("cost_reconfirmation_required");
  if (facts.cost === "hold") reasons.push("cost_unavailable");
  if (!Number.isSafeInteger(facts.compatibleWorkerCount) ||
      facts.compatibleWorkerCount < 1) reasons.push("worker_unavailable");
  if (facts.orchestratorHalted) reasons.push("orchestrator_halted");
  return { version: AMUX_V4_TASK_READY_VERSION, ready: reasons.length === 0,
    reasons, dependencyCount: facts.dependencies.length,
    completedDependencyCount: facts.dependencies.filter((item) =>
      item.approvedTask && item.status === "done" && item.terminal).length,
    compatibleWorkerCount: facts.compatibleWorkerCount,
    promotionAuthorized: false as const, claimAuthorized: false as const };
}
