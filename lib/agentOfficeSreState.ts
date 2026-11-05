/**
 * The Ops and SRE room's state, from what the server read.
 *
 * Status only. Whether the agent's state chain is trusted (and the chain
 * check's own reason when it is not), the stage the chain was approved in, its
 * generation and when the agent's newest digest was stored. Keys, ledgers,
 * deliveries and audit rows are never read here: the chain verdict comes from
 * `readOpsObserverAdminView()`, which owns those tables.
 */

import type { AgentOfficeSreState } from "@/lib/agentOffice/live";

export function agentOfficeSreState(input: {
  view: {
    head: { generation: number | null; mode: string } | null;
    trustReason: string;
  };
  latestDigestAt: Date | null;
}): AgentOfficeSreState {
  const { view } = input;
  // A verdict that is not a code is not one the room can show: unread, not a guess.
  if (typeof view.trustReason !== "string" || view.trustReason === "") return { kind: "unread" };
  if (view.head && typeof view.head.mode !== "string") return { kind: "unread" };
  return {
    kind: "observed",
    head: view.head ? { generation: view.head.generation, mode: view.head.mode } : null,
    trustReason: view.trustReason,
    latestDigestAt: input.latestDigestAt?.toISOString() ?? null,
  };
}
