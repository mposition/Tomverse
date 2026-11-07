import React from "react";
import { createRoot } from "react-dom/client";
import { AgentOfficePanel } from "../../components/admin/AgentOfficePanel";
import type { AgentOfficeLiveRooms } from "../../lib/agentOffice/live";
import { AGENT_OFFICE_AMUX_ROSTER } from "../../lib/agentOffice/amuxRoster";
const unread = { kind: "unread" } as const;
const live: AgentOfficeLiveRooms = {
  readAt: new Date().toISOString(), research: unread, qa: unread, finance: unread,
  routing: unread, sre: unread, support: unread, marketing: unread, trust: unread, engineering: unread, digest: unread, decision: unread, review: unread,
  queue: { marketing: 0, amuxEscalations: 0, amuxHalts: 0 },
  amuxDetail: { kind: "observed", ownerDetail: true, workers: {} },
  inbox: { dmAttention: 0, v22Questions: 0, planRefusals: 0 },
  merges: { kind: "observed", items: [] },
  amux: { kind: "observed", catalogConfigured: true, workers: AGENT_OFFICE_AMUX_ROSTER.map(worker =>
    ({ ...worker, state: "idle" as const, heartbeatAt: new Date().toISOString() })) },
};
createRoot(document.getElementById("root")!).render(<AgentOfficePanel view="live" live={live} cliMonitorEnabled />);
