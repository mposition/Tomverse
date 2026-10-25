import React from "react";
import { createRoot } from "react-dom/client";
import { AgentOfficePanel } from "../../components/admin/AgentOfficePanel";
import type { AgentOfficeLiveRooms } from "../../lib/agentOffice/live";
const unread = { kind: "unread" } as const;
const live: AgentOfficeLiveRooms = {
  readAt: new Date().toISOString(), research: unread, qa: unread, finance: unread,
  routing: unread, engineering: unread, digest: unread, decision: unread, review: unread,
  queue: { marketing: 0, amuxEscalations: 0, amuxHalts: 0, autoFix: 0 },
  amux: { kind: "observed", catalogConfigured: true, workers: [
    { name: "codex-impl", provider: "openai", state: "busy", heartbeatAt: new Date().toISOString() },
    { name: "codex-chore", provider: "openai", state: "idle", heartbeatAt: new Date().toISOString() },
  ] },
};
createRoot(document.getElementById("root")!).render(<AgentOfficePanel view="live" live={live} cliMonitorEnabled />);
