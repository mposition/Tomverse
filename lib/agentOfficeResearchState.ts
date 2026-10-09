/**
 * The product-research room's state, from what the server read.
 *
 * Pure: the judgements are the product-research agent's own --
 * `slotForInstant`, `withinSlotWindow`, `observationSlotSeries` and
 * `observationSilenceVerdict` -- reused, never reimplemented, so the office
 * and the agent's section can never disagree about what today's slot is or
 * whether the agent has gone silent. Kept apart from the client modules
 * because those judgements import repository scripts.
 */

import type { AgentOfficeResearchState, AgentOfficeSlotState } from "@/lib/agentOffice/live";
import {
  observationSilenceVerdict,
  observationSlotSeries,
} from "@/lib/productResearchObservationCore.mjs";
import { slotForInstant, withinSlotWindow } from "@/lib/productResearchObservationRunnerCore.mjs";

export type AgentOfficeResearchRow = {
  slot: Date;
  outcome: string;
  failureStage: string | null;
};

export function agentOfficeResearchState(input: {
  enabled: boolean;
  /** Rows stored for the current slot: none, one, or (if the table allowed it) more. */
  rows: AgentOfficeResearchRow[];
  lastSuccessAt: Date | null;
  enabledSince: Date | null;
  now: Date;
}): AgentOfficeResearchState {
  if (!input.enabled) return { kind: "disabled" };

  const slot = slotForInstant(input.now.getTime());
  const [entry] = observationSlotSeries(input.rows, { endSlot: slot, count: 1 });
  const silence = observationSilenceVerdict({
    enabled: true,
    lastSuccessAt: input.lastSuccessAt?.getTime() ?? null,
    enabledSince: input.enabledSince?.getTime() ?? null,
    now: input.now.getTime(),
  });

  return {
    kind: "observed",
    slot,
    slotState: entry.state as AgentOfficeSlotState,
    failureStage: entry.failureStage,
    windowOpen: withinSlotWindow(input.now.getTime(), slot),
    lastSuccessAt: input.lastSuccessAt?.toISOString() ?? null,
    silence: silence.state,
    silenceHours: silence.sinceHours,
  };
}
