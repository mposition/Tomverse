/**
 * The AMUX Decision Maker room's state: its switches, read through the
 * Decision Maker's own switch reader (docs/policy/amux-decision-maker.md §8).
 *
 * Only the switches leave here. Its ledgers -- questions, proposals,
 * judgments -- are read and written by its own store modules and nothing
 * else (§10), so the office reads none of them, not even a count.
 */

import type { AgentOfficeDecisionState } from "@/lib/agentOffice/live";
import { DM_VENDOR_FOR_INSTANCE } from "@/lib/amux/decisionMakerRequestCore";
import { DM_INSTANCE_SCOPES, type DecisionMakerSwitchState } from "@/lib/amux/decisionMakerSwitchCore";

export function agentOfficeDecisionState(input: { switches: DecisionMakerSwitchState }): AgentOfficeDecisionState {
  return {
    kind: "observed",
    killSwitch: input.switches.killSwitch,
    instances: DM_INSTANCE_SCOPES.map((instance) => ({
      instance,
      vendor: DM_VENDOR_FOR_INSTANCE[instance],
      mode: input.switches.instances[instance],
    })),
  };
}
