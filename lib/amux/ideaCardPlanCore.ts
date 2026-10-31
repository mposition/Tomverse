import { amuxV22TaskWritesPatch } from "./v22WorkerClaimCore.ts";

/** Pure ordering for the card part of the plan approval batch
 * (amux-intake.md v18 item 3). */

/** One approval commits at most this many cards; a larger plan takes more
 * rounds, each a dependency-closed prefix of the ordered plan. */
export const AMUX_V4_CARD_PLAN_MAX_UNITS = 24;
/** The most proposed cards one idea may hold for a plan approval at all. */
export const AMUX_V4_CARD_PLAN_MAX_PROPOSED = 200;

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

/** This round: the first cards of the ordered plan. Every Task in the plan
 * follows the plan's own cards it depends on, so any prefix carries its
 * dependencies with it; the rest wait for the next round. */
export function amuxV4CardPlanRound<T>(ordered: readonly T[]): { round: T[]; remaining: number } {
  const round = ordered.slice(0, AMUX_V4_CARD_PLAN_MAX_UNITS);
  return { round, remaining: ordered.length - round.length };
}

/** v18: an implement (or test) Task's public PR consent is on unless the owner turned it off. */
export function amuxV4PlanPublicPrConsent(unit: { draftUnitId: string; cardType: "story" | "task";
  taskRole: string | null }, consentOff: ReadonlySet<string>): boolean {
  return unit.cardType === "task" && amuxV22TaskWritesPatch(unit.taskRole) &&
    !consentOff.has(unit.draftUnitId);
}
