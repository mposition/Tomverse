/**
 * The AMUX Decision Maker room's state, from the switch state and two
 * aggregates of its ledger (docs/policy/amux-decision-maker.md §8, §10).
 *
 * Only the operating state leaves here: the kill switch, each instance's mode,
 * how many questions were routed to it or to the operator in the last 24
 * hours, and when the latest one was routed and judged. No card, question,
 * proposal, digest or person's id is read, so none can be shown.
 */

import type { AgentOfficeDecisionState } from "@/lib/agentOffice/live";
import { DM_VENDOR_FOR_INSTANCE } from "@/lib/amux/decisionMakerRequestCore";
import { DM_INSTANCE_SCOPES, type DecisionMakerSwitchState } from "@/lib/amux/decisionMakerSwitchCore";

/** How far back the room counts routed questions. */
export const AGENT_OFFICE_DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A (route, instance) group of the request ledger. */
type RequestGroup = { route: string; instance: string | null };

export function agentOfficeDecisionState(input: {
  switches: DecisionMakerSwitchState;
  /** Questions per group in the window. */
  recent: readonly (RequestGroup & { count: number })[];
  /** The newest question per group, ever. */
  latest: readonly (RequestGroup & { lastAt: Date | null })[];
  /** The newest judgment by a person per instance, ever. */
  judgments: readonly { instance: string; lastAt: Date | null }[];
}): AgentOfficeDecisionState {
  const routedTo = (instance: string) => (group: RequestGroup) =>
    group.route === "dm_proposal" && group.instance === instance;
  const count = (groups: readonly { count: number }[]) => groups.reduce((sum, group) => sum + group.count, 0);
  const newest = (dates: (Date | null)[]) =>
    dates.reduce<Date | null>((best, at) => (at && (!best || at > best) ? at : best), null);
  const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);
  return {
    kind: "observed",
    killSwitch: input.switches.killSwitch,
    instances: DM_INSTANCE_SCOPES.map((instance) => ({
      instance,
      vendor: DM_VENDOR_FOR_INSTANCE[instance],
      mode: input.switches.instances[instance],
      recent: count(input.recent.filter(routedTo(instance))),
      lastRoutedAt: iso(newest(input.latest.filter(routedTo(instance)).map((group) => group.lastAt))),
      lastJudgedAt: iso(newest(input.judgments.filter((group) => group.instance === instance).map((group) => group.lastAt))),
    })),
    toOperator: count(input.recent.filter((group) => group.route === "operator")),
  };
}
