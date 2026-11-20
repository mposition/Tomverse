/**
 * Which backlog Tasks the automatic promotion could not move for a reason the
 * operator has to act on, and the one notice that names them.
 *
 * Owner direction 2026-11-14: "등급에 맞는 워커가 없으면 안됩니다. 운영자가 이유를
 * 알아야 겠죠?" On 2026-11-14 three advanced Tasks with every dependency done
 * sat in backlog while the tick answered only `no_ready_candidate`; nothing
 * said why. A Task still waiting on its dependencies is ordinary and is not
 * reported; the other refusals of `lib/amux/v4TaskReadyCore.ts` are.
 *
 * Pure and dependency-free.
 */

/** Readiness refusals a person (or a worker/price change) has to clear. */
export const AMUX_V22_PROMOTION_OPERATOR_REASONS = [
  "no_worker_for_grade",
  "worker_unavailable",
  "cost_reconfirmation_required",
  "cost_unavailable",
  "role_or_grade_missing",
  "brief_or_scope_missing",
  "source_approval_invalid",
  "dependency_set_changed",
  "parent_path_changed",
] as const;

/**
 * Refusals that only mean "not yet" or "not this path": the Task moves once
 * they clear by themselves, a halt has its own alert, and a Task already moved
 * or claimed is no longer the tick's to promote.
 */
const WAITING_REASONS = new Set([
  "dependency_incomplete", "dependency_unpublished", "orchestrator_halted",
  "not_backlog", "already_assigned", "not_v4_task",
]);

const OPERATOR_REASONS = new Set<string>(AMUX_V22_PROMOTION_OPERATOR_REASONS);


export type AmuxV22PromotionNotReady = {
  readonly taskId: string;
  readonly displayKey: string | null;
  readonly reasons: readonly string[];
};

export type AmuxV22PromotionBlockedNotice = {
  readonly count: number;
  readonly reasons: Readonly<Record<string, number>>;
  /** `AMUX-KEY: reason+reason` for every Task (owner decision 2026-11-15: no display cap). */
  readonly tasks: string;
};

/**
 * The Tasks held only by operator reasons. A Task that also waits on a
 * dependency is left out: it would not move today even with the reason
 * cleared, and it is named once its dependencies are done.
 */
export function amuxV22PromotionBlockedByOperator(
  notReady: readonly AmuxV22PromotionNotReady[],
): AmuxV22PromotionNotReady[] {
  return notReady
    .map((task) => ({ ...task, reasons: [...new Set(task.reasons)].sort() }))
    .filter((task) => !task.reasons.some((reason) => WAITING_REASONS.has(reason)) &&
      task.reasons.some((reason) => OPERATOR_REASONS.has(reason)));
}

export function amuxV22PromotionBlockedNotice(
  notReady: readonly AmuxV22PromotionNotReady[],
): AmuxV22PromotionBlockedNotice | null {
  const blocked = amuxV22PromotionBlockedByOperator(notReady)
    .sort((a, b) => (a.displayKey ?? a.taskId).localeCompare(b.displayKey ?? b.taskId));
  if (blocked.length === 0) return null;
  const reasons: Record<string, number> = {};
  for (const task of blocked) {
    for (const reason of task.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    count: blocked.length,
    reasons,
    tasks: blocked
      .map((task) => `${task.displayKey ?? task.taskId}: ${task.reasons.join("+")}`)
      .join("; "),
  };
}
