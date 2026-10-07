/**
 * The QA-and-release room's state, from what the server read.
 *
 * The verdict is the agent's own -- `judgeQaReleaseFreshness`, the same pure
 * function its silence monitor calls, with the same inputs: whether a usable
 * digest secret is configured (its length, never its value), the newest
 * operator control revision's `digestEnabled`, and when the newest digest
 * was stored. The one difference is the clock: the monitor reads the
 * database's, the office passes the app's, so within a clock skew of the
 * 28-hour line the two can disagree for that moment. The office is a view;
 * the monitor's verdict is the one that alerts.
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
