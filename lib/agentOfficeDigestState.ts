/**
 * The digest desk's state, from two aggregates of the agent digest store
 * (lib/agentDigestStore.ts): how many digests each agent sent in the last 24
 * hours, and when its newest one arrived. Counts and times only -- no
 * payload, kind or idempotency key leaves here, so no digest's content can be
 * shown.
 */

import type { AgentOfficeDigestState } from "@/lib/agentOffice/live";
import { AGENT_DIGEST_AGENT_KEYS } from "@/lib/agentDigestContract";

/** How far back the desk counts digests. */
export const AGENT_OFFICE_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export function agentOfficeDigestState(input: {
  /** Digests per agent in the window. */
  recent: readonly { agentKey: string; count: number }[];
  /** The newest digest per agent, ever. */
  latest: readonly { agentKey: string; lastAt: Date | null }[];
}): AgentOfficeDigestState {
  return {
    kind: "observed",
    // Every agent the store accepts, in its order, whether or not it has sent one.
    agents: AGENT_DIGEST_AGENT_KEYS.map((agentKey) => {
      const lastAt = input.latest.find((row) => row.agentKey === agentKey)?.lastAt ?? null;
      return {
        agentKey,
        recent: input.recent.filter((row) => row.agentKey === agentKey).reduce((sum, row) => sum + row.count, 0),
        lastAt: lastAt ? lastAt.toISOString() : null,
      };
    }),
  };
}
