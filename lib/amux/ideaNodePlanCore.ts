/** Pure ordering for the plan approval batch (amux-intake.md v18 item 3). */

export const AMUX_V4_NODE_LEVELS = ["initiative", "epic", "feature"] as const;
/** One approval creates at most this many nodes; a larger plan takes more
 * rounds (amuxV4NodePlanRound). */
export const AMUX_V4_NODE_PLAN_MAX_UNITS = 12;

export class AmuxV4NodePlanError extends Error {
  constructor(readonly code: "nothing_to_approve" | "parent_unresolved" |
    "reason_invalid", readonly draftUnitIds: string[] = []) {
    super(code);
    this.name = "AmuxV4NodePlanError";
  }
}

/** Parents first: Initiatives, then Epics, then Features, each by unit id. The
 * plan screen orders the same way, so both name the same round. */
export const sortAmuxV4NodePlan = <T extends { draftUnitId: string;
  level: (typeof AMUX_V4_NODE_LEVELS)[number] }>(units: readonly T[]): T[] =>
  [...units].sort((a, b) =>
    AMUX_V4_NODE_LEVELS.indexOf(a.level) - AMUX_V4_NODE_LEVELS.indexOf(b.level) ||
    a.draftUnitId.localeCompare(b.draftUnitId));

/**
 * This round's nodes (owner direction 2026-11-15): a plan with more than
 * AMUX_V4_NODE_PLAN_MAX_UNITS nodes is approved over several rounds instead of
 * being refused. The order puts every level before the next, so any prefix
 * carries each of its nodes' parents with it, and a later round finds them
 * among the approved nodes.
 */
export function amuxV4NodePlanRound<T>(ordered: readonly T[]): { round: T[]; remaining: number } {
  const round = ordered.slice(0, AMUX_V4_NODE_PLAN_MAX_UNITS);
  return { round, remaining: ordered.length - round.length };
}

/** Order a plan's node units so every parent is created before its children. */
export function orderAmuxV4NodePlan<T extends { draftUnitId: string; localRef: string;
  level: (typeof AMUX_V4_NODE_LEVELS)[number]; parentRef: string | null }>(
  units: readonly T[], existing: ReadonlyMap<string, string>,
): Array<T & { parent: { kind: "none" } | { kind: "existing"; nodeId: string } | { kind: "batch"; localRef: string } }> {
  const byRef = new Map(units.map((unit) => [unit.localRef, unit]));
  const ordered = sortAmuxV4NodePlan(units);
  const unresolved: string[] = [];
  const planned = ordered.map((unit) => {
    if (unit.parentRef === null) {
      if (unit.level !== "initiative") unresolved.push(unit.draftUnitId);
      return { ...unit, parent: { kind: "none" as const } };
    }
    const sibling = byRef.get(unit.parentRef);
    if (sibling && AMUX_V4_NODE_LEVELS.indexOf(sibling.level) === AMUX_V4_NODE_LEVELS.indexOf(unit.level) - 1) {
      return { ...unit, parent: { kind: "batch" as const, localRef: sibling.localRef } };
    }
    const nodeId = existing.get(unit.parentRef);
    if (nodeId) return { ...unit, parent: { kind: "existing" as const, nodeId } };
    unresolved.push(unit.draftUnitId);
    return { ...unit, parent: { kind: "none" as const } };
  });
  if (unresolved.length > 0) throw new AmuxV4NodePlanError("parent_unresolved", unresolved);
  return planned;
}

