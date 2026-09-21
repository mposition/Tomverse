import { calculateAmuxUrgency, type AmuxDeadlineParse } from "@/lib/amux/planningCore";

export type AmuxSchedulerFacts = {
  pinned: boolean;
  createdAt: Date;
  kind: string;
  priority: string;
  dependentCount: number;
  drag: number;
};

export type AmuxSchedulerScore = {
  pin: number;
  age_hours: number;
  type_weight: number;
  priority_weight: number;
  dependents: number;
  dependent_weight: number;
  drag: number;
  urgency: number;
  capacity_weight: number;
  incident_bonus: number;
  total: number;
};

export const amuxTypeWeight = (kind: string) => {
  switch (kind.trim().toLowerCase()) {
    case "blocker":
    case "escalation":
      return 30;
    case "bug":
      return 24;
    case "code":
    case "ops":
      return 12;
    case "investigation":
      return 6;
    case "research":
    case "chore":
    case "doc":
      return 0;
    default:
      return 6;
  }
};

export const amuxPriorityWeight = (priority: string) => {
  switch (priority.trim().toLowerCase()) {
    case "p0":
      return 40;
    case "p1":
      return 20;
    case "p2":
      return 10;
    default:
      return 0;
  }
};

/**
 * The one scheduler scorer used by both the queue DTO and the claim authority.
 * V1 callers pass no advanced evidence, so the three V2 terms remain zero.
 */
export const scoreAmuxScheduler = (input: {
  facts: AmuxSchedulerFacts;
  now: Date;
  deadline?: AmuxDeadlineParse;
  capacityWeight?: number;
  incidentBonus?: number;
}): AmuxSchedulerScore => {
  const dependents = Math.max(0, Math.trunc(input.facts.dependentCount));
  const urgency = input.deadline
    ? calculateAmuxUrgency(input.deadline.due_at, input.now).score
    : 0;
  const score = {
    pin: input.facts.pinned ? 10_000 : 0,
    age_hours: Math.max(
      0,
      Math.floor((input.now.getTime() - input.facts.createdAt.getTime()) / 3_600_000),
    ),
    type_weight: amuxTypeWeight(input.facts.kind),
    priority_weight: amuxPriorityWeight(input.facts.priority),
    dependents,
    dependent_weight: dependents * 5,
    drag: Math.max(0, Math.min(8, Math.trunc(input.facts.drag))),
    urgency,
    capacity_weight: Math.max(0, Math.min(20, Math.trunc(input.capacityWeight ?? 0))),
    incident_bonus: Math.max(0, Math.min(80, Math.trunc(input.incidentBonus ?? 0))),
  };
  return {
    ...score,
    total:
      score.pin +
      score.age_hours +
      score.type_weight +
      score.priority_weight +
      score.dependent_weight +
      score.drag +
      score.urgency +
      score.capacity_weight +
      score.incident_bonus,
  };
};
