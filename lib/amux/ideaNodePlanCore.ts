/** Pure ordering for the plan approval batch (amux-intake.md v18 item 3). */

export const AMUX_V4_NODE_LEVELS = ["initiative", "epic", "feature"] as const;
/** A plan larger than this is approved in more than one round. */
export const AMUX_V4_NODE_PLAN_MAX_UNITS = 12;

export class AmuxV4NodePlanError extends Error {
  constructor(readonly code: "nothing_to_approve" | "too_many_units" | "parent_unresolved" |
    "reason_invalid", readonly draftUnitIds: string[] = []) {
    super(code);
    this.name = "AmuxV4NodePlanError";
  }
}

/** Order a plan's node units so every parent is created before its children. */
export function orderAmuxV4NodePlan<T extends { draftUnitId: string; localRef: string;
  level: (typeof AMUX_V4_NODE_LEVELS)[number]; parentRef: string | null }>(
  units: readonly T[], existing: ReadonlyMap<string, string>,
): Array<T & { parent: { kind: "none" } | { kind: "existing"; nodeId: string } | { kind: "batch"; localRef: string } }> {
  const byRef = new Map(units.map((unit) => [unit.localRef, unit]));
  const ordered = [...units].sort((a, b) =>
    AMUX_V4_NODE_LEVELS.indexOf(a.level) - AMUX_V4_NODE_LEVELS.indexOf(b.level) || a.draftUnitId.localeCompare(b.draftUnitId));
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

