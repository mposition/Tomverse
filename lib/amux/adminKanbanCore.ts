/** Read-only projection of canonical AMUX card state. This never moves cards. */
export const AMUX_ADMIN_KANBAN_LANES = [
  "tomverse_backlog", "amux_backlog", "todo", "in_progress",
  "in_review", "owner_attention",
] as const;

export type AmuxAdminKanbanLane = typeof AMUX_ADMIN_KANBAN_LANES[number];

/** Legacy AMUX claim evidence. v22 needs its own assignment receipt before
 * it can use the assigned lane; a free-form owner string is never enough. */
export function amuxLegacyTodoClaimVerified(card: {
  status: string; owner: string | null; claimedAt: Date | null; revision: number;
}, route: { worker: string; taskRevision: number } | null): boolean {
  return card.status === "todo" && card.owner !== null &&
    card.claimedAt instanceof Date && Number.isFinite(card.claimedAt.getTime()) &&
    Number.isSafeInteger(card.revision) && card.revision > 0 &&
    route?.worker === card.owner && route.taskRevision === card.revision - 1;
}

type CardState = {
  status: string;
  owner: string | null;
  claimVerified: boolean;
  hasOwnerAttentionEscalation: boolean;
};

/** Terminal cards remain available in the full list. An unexpected active
 * status goes to owner attention so it cannot disappear from the board. */
export function amuxAdminKanbanLane(row: CardState): AmuxAdminKanbanLane | null {
  if (row.status === "done" || row.status === "cancelled") return null;
  if (row.status === "blocked" || row.hasOwnerAttentionEscalation) return "owner_attention";
  if (row.status === "backlog") return "tomverse_backlog";
  if (row.status === "todo") {
    if (row.owner === null && !row.claimVerified) return "amux_backlog";
    return row.owner !== null && row.claimVerified ? "todo" : "owner_attention";
  }
  if (row.status === "doing") return "in_progress";
  if (row.status === "review") return "in_review";
  return "owner_attention";
}

export function projectAmuxAdminKanban<T extends CardState>(rows: readonly T[]): {
  lanes: Record<AmuxAdminKanbanLane, T[]>;
  terminalCount: number;
} {
  const lanes: Record<AmuxAdminKanbanLane, T[]> = {
    tomverse_backlog: [], amux_backlog: [], todo: [],
    in_progress: [], in_review: [], owner_attention: [],
  };
  let terminalCount = 0;
  for (const row of rows) {
    const lane = amuxAdminKanbanLane(row);
    if (lane === null) terminalCount += 1;
    else lanes[lane].push(row);
  }
  return { lanes, terminalCount };
}
