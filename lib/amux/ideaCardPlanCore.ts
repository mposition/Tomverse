/** Pure ordering for the card part of the plan approval batch
 * (amux-intake.md v18 item 3). */

/** A plan larger than this is approved in more than one round. */
export const AMUX_V4_CARD_PLAN_MAX_UNITS = 24;

export class AmuxV4CardPlanError extends Error {
  constructor(readonly code: "nothing_to_approve" | "too_many_units" | "feature_unresolved" |
    "dependency_cycle" | "reason_invalid", readonly draftUnitIds: string[] = []) {
    super(code);
    this.name = "AmuxV4CardPlanError";
  }
}

/**
 * Stories first, then Tasks so that every Task comes after the plan's own
 * cards it names as parent Story or dependency. A reference outside the plan
 * is left to the reference resolver, which refuses one it cannot find. A
 * cycle among the plan's Tasks refuses the whole plan.
 */
export function orderAmuxV4CardPlan<T extends { draftUnitId: string; localRef: string;
  cardType: "story" | "task"; parentStoryRef: string | null; dependencyRefs: readonly string[] }>(
  units: readonly T[],
): T[] {
  const byId = (a: T, b: T) => a.draftUnitId.localeCompare(b.draftUnitId);
  const stories = units.filter((unit) => unit.cardType === "story").sort(byId);
  const tasks = units.filter((unit) => unit.cardType === "task").sort(byId);
  const taskRefs = new Set(tasks.map((task) => task.localRef));
  const placed = new Set<string>();
  const ordered: T[] = [];
  let remaining = tasks;
  while (remaining.length > 0) {
    const ready = remaining.filter((task) =>
      task.dependencyRefs.every((ref) => !taskRefs.has(ref) || placed.has(ref)));
    if (ready.length === 0) {
      throw new AmuxV4CardPlanError("dependency_cycle", remaining.map((task) => task.draftUnitId));
    }
    for (const task of ready) { ordered.push(task); placed.add(task.localRef); }
    remaining = remaining.filter((task) => !placed.has(task.localRef));
  }
  return [...stories, ...ordered];
}

/** v18: an implement Task's public PR consent is on unless the owner turned it off. */
export function amuxV4PlanPublicPrConsent(unit: { draftUnitId: string; cardType: "story" | "task";
  taskRole: string | null }, consentOff: ReadonlySet<string>): boolean {
  return unit.cardType === "task" && unit.taskRole === "implement" && !consentOff.has(unit.draftUnitId);
}
