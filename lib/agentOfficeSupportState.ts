/**
 * The Support triage room's state, from what the server read.
 *
 * Status only. The effective switch, the newest finished worker run's time and
 * outcome, the day's counts and the agent's own staleness verdict. A report's
 * text, a reply draft or a suggestion is never read here. The verdict is
 * `readSupportTriageHealth()`'s and the switch is
 * `resolveSupportTriageEnabled()`'s: neither is judged again.
 */

import type { AgentOfficeSupportState } from "@/lib/agentOffice/live";

export function agentOfficeSupportState(input: {
  enabled: boolean;
  health: {
    worker: { at: string; outcome: string } | null;
    reportsToday: number;
    failedRunsToday: number;
    stale: boolean;
  };
}): AgentOfficeSupportState {
  const { health } = input;
  return {
    kind: "observed",
    enabled: input.enabled,
    worker: health.worker ? { at: health.worker.at, outcome: health.worker.outcome } : null,
    reportsToday: health.reportsToday,
    failedRunsToday: health.failedRunsToday,
    stale: health.stale,
  };
}
