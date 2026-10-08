/**
 * The engineering room's state, from what the server read.
 *
 * The switches go through the agent's own `resolveEngineeringAgentSwitches`,
 * so the office reads the mode the agent acts on: unset or unknown is off, and
 * an engaged kill switch is off whatever the mode setting says. The kill
 * switch is seen only through `killSwitchEngaged`. The halt is the one the
 * agent tells its services (`currentEngineeringAgentHalt`), computed by the
 * caller from the agent's own halt reading. A setting that could not be read
 * is not passed here as "off": the caller draws the whole room as unread.
 *
 * Whether the latest ended run needs a look is the agent's own settlement of
 * its outcome (`AMUX_SETTLEMENT_FOR_OUTCOME`): `review` hands a result to a
 * person; `retry`, `blocked` and a lease AMUX recovers did not, and an
 * outcome the table does not know is treated the same way.
 */

import type { AgentOfficeEngineeringHalt, AgentOfficeEngineeringState } from "@/lib/agentOffice/live";
import {
  AMUX_SETTLEMENT_FOR_OUTCOME,
  ENGINEERING_AGENT_FREEZE_SETTING_KEY,
  ENGINEERING_AGENT_MODE_SETTING_KEY,
  ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY,
  ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY,
  killSwitchEngaged,
  parseSettingInstant,
  resolveEngineeringAgentSwitches,
  type RunOutcome,
} from "@/lib/engineeringAgentCore";

const settledForReview = (outcome: string | null) =>
  outcome !== null &&
  Object.hasOwn(AMUX_SETTLEMENT_FOR_OUTCOME, outcome) &&
  AMUX_SETTLEMENT_FOR_OUTCOME[outcome as RunOutcome] === "review";

/** The settings the office reads: the switches and each service's last finished cycle. */
export const AGENT_OFFICE_ENGINEERING_SETTING_KEYS = [
  ENGINEERING_AGENT_MODE_SETTING_KEY,
  ENGINEERING_AGENT_FREEZE_SETTING_KEY,
  ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY,
  ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY,
];

export function agentOfficeEngineeringState(input: {
  settings: ReadonlyArray<{ key: string; value: string }>;
  /** The raw kill switch environment value; only whether it is engaged is kept. */
  killSwitch: string | undefined;
  halt: AgentOfficeEngineeringHalt;
  /** Open owner items by kind (t2_draft, decision, state_mismatch). */
  openOwnerItems: ReadonlyArray<{ kind: string; count: number }>;
  /** Runs still in progress, and when the earliest of them started. */
  active: { count: number; since: Date | null };
  /** The newest run that ended, by its end. */
  lastRun: { status: string; outcome: string | null; startedAt: Date; endedAt: Date | null } | null;
}): AgentOfficeEngineeringState {
  const setting = (key: string) => input.settings.find((row) => row.key === key)?.value ?? null;
  const switches = resolveEngineeringAgentSwitches({
    mode: setting(ENGINEERING_AGENT_MODE_SETTING_KEY),
    freeze: setting(ENGINEERING_AGENT_FREEZE_SETTING_KEY),
    registration: null,
    killSwitch: input.killSwitch,
    readFailed: false,
  });
  const count = (kind: string) => input.openOwnerItems.find((row) => row.kind === kind)?.count ?? 0;
  const instant = (key: string) => parseSettingInstant(setting(key))?.toISOString() ?? null;
  return {
    kind: "observed",
    mode: switches.mode,
    frozen: switches.frozen,
    killSwitch: killSwitchEngaged(input.killSwitch),
    halt: input.halt,
    pending: { t2Draft: count("t2_draft"), decision: count("decision"), stateMismatch: count("state_mismatch") },
    activeRuns: input.active.count,
    activeSince: input.active.count > 0 ? (input.active.since?.toISOString() ?? null) : null,
    lastRun: input.lastRun
      ? {
          status: input.lastRun.status,
          outcome: input.lastRun.outcome,
          startedAt: input.lastRun.startedAt.toISOString(),
          endedAt: (input.lastRun.endedAt ?? input.lastRun.startedAt).toISOString(),
          needsLook: !settledForReview(input.lastRun.outcome),
        }
      : null,
    runnerLastFinishAt: instant(ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY),
    publisherLastFinishAt: instant(ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY),
  };
}
