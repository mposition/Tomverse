/**
 * The Chat routing improvement room's state, from what the server read.
 *
 * Status only. The newest optimizer cycle's target, status, failure code and
 * times, the spend of this UTC day and month against the optimizer's caps,
 * and when a cycle was last promoted. The guidance, evaluation cases and
 * summary of a cycle are never read: they stay on the routing screen.
 *
 * The spend is summed the way `readAutoRouterOptimizerState()` sums it: every
 * cycle of either target since the start of the UTC month, with today being
 * the part since the start of the UTC day.
 */

import type { AgentOfficeRoutingState } from "@/lib/agentOffice/live";
import {
  AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
} from "@/lib/autoRouterOptimizerCore";

const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const agentOfficeRoutingMonthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const TARGETS = new Set(["routing", "rewrite"]);
const STATUSES = new Set(["running", "passed", "failed", "error"]);

export function agentOfficeRoutingState(input: {
  last: { target: string; status: string; failure: string | null; createdAt: Date; finishedAt: Date | null } | null;
  /** The cycles since the start of this UTC month. */
  monthCycles: readonly { createdAt: Date; spentMicroUsd: number }[];
  lastPromotedAt: Date | null;
  now: Date;
}): AgentOfficeRoutingState {
  const dayStart = utcDayStart(input.now);
  const monthStart = agentOfficeRoutingMonthStart(input.now);
  const spentSince = (from: Date) =>
    input.monthCycles.filter((cycle) => cycle.createdAt >= from).reduce((sum, cycle) => sum + cycle.spentMicroUsd, 0);
  const { last } = input;
  // A row outside the two enums is not a status the room can name: unread, not a guess.
  if (last && (!TARGETS.has(last.target) || !STATUSES.has(last.status))) return { kind: "unread" };
  return {
    kind: "observed",
    last: last
      ? {
          target: last.target as "routing" | "rewrite",
          status: last.status as "running" | "passed" | "failed" | "error",
          failure: last.failure,
          createdAt: last.createdAt.toISOString(),
          finishedAt: last.finishedAt?.toISOString() ?? null,
        }
      : null,
    spentTodayMicroUsd: spentSince(dayStart),
    spentMonthMicroUsd: spentSince(monthStart),
    dayCapMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
    monthCapMicroUsd: AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
    lastPromotedAt: input.lastPromotedAt?.toISOString() ?? null,
  };
}
