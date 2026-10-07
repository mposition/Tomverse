/**
 * The QA-and-release room's state, from what the server read.
 *
 * The verdict is the agent's own -- `judgeQaReleaseFreshness`, the same pure
 * function its silence monitor calls, with the same inputs: whether a usable
 * digest secret is configured (its length, never its value), the newest
 * operator control revision's `digestEnabled`, and when the newest digest
 * was stored. The difference is the clock and the snapshot: the monitor
 * reads every fact and the database clock in one statement, the office reads
 * the facts separately and judges them against the app's clock taken after
 * them. So a database clock running ahead of the app's can make a digest
 * stored a moment ago read as dated in the future (stale), and within a clock
 * skew of the 28-hour line the two can disagree. The office is a view; the
 * monitor's verdict is the one that alerts.
 *
 * "Configured" is this app process's environment, the same one the monitor
 * route sees -- a secret set on the host but not yet in a running process is
 * not configured here, for the office and the monitor alike.
 */

import type { AgentOfficeQaState } from "@/lib/agentOffice/live";
import { judgeQaReleaseFreshness } from "@/lib/qaReleaseDigestFreshnessCore";

export function agentOfficeQaState(input: {
  digestSecretConfigured: boolean;
  /** The newest control revision, or null when none is recorded. */
  control: { revision: number; digestEnabled: boolean } | null;
  latestDigestAt: Date | null;
  mergeLaneLatched: boolean;
  now: Date;
}): AgentOfficeQaState {
  const verdict = judgeQaReleaseFreshness({
    digestSecretConfigured: input.digestSecretConfigured,
    desiredEnabled: input.control?.digestEnabled ?? null,
    latestDigestCreatedAtMs: input.latestDigestAt?.getTime() ?? null,
    dbNowMs: input.now.getTime(),
  });
  return {
    kind: "observed",
    verdict,
    latestDigestAt: input.latestDigestAt?.toISOString() ?? null,
    controlRevision: input.control?.revision ?? null,
    mergeLaneLatched: input.mergeLaneLatched,
  };
}
