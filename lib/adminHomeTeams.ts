/**
 * The team strip on Today: one pixel figure per agent team and how it is doing,
 * from the Agent office's own live read (`lib/agentOfficeLiveRead.ts`).
 *
 * Tone only. The office derives each team's state with its `*Tone` functions;
 * this reuses them rather than judging a team a second way, and shows no text
 * a team produced. A team whose state could not be read is "unknown", not
 * "fine".
 */
import {
  engineeringTone,
  financeTone,
  marketingTone,
  qaTone,
  researchTone,
  routingTone,
  sreTone,
  supportTone,
  trustTone,
  type AgentOfficeLiveRooms,
} from "@/lib/agentOffice/live";
import type { DeptStatus } from "@/lib/agentOffice/sim";
import type { AdminPixelTeam } from "@/lib/adminPixelAvatarPalette";
import type { AdminTone } from "@/lib/adminUiCore";

export type AdminHomeTeam = { team: Exclude<AdminPixelTeam, "amux">; tone: AdminTone };

const TONE: Record<DeptStatus, AdminTone> = {
  done: "ok",
  working: "info",
  attention: "warn",
  blocked: "bad",
  waiting: "idle",
};

const unread = (state: { kind?: string }) => state.kind === "unread";

export function adminHomeTeams(rooms: AgentOfficeLiveRooms): AdminHomeTeam[] {
  const row = (
    team: AdminHomeTeam["team"],
    state: { kind?: string },
    tone: () => DeptStatus
  ): AdminHomeTeam => ({ team, tone: unread(state) ? "unknown" : TONE[tone()] });
  return [
    row("marketing", rooms.marketing, () => marketingTone(rooms.marketing)),
    row("research", rooms.research, () => researchTone(rooms.research)),
    row("engineering", rooms.engineering, () => engineeringTone(rooms.engineering)),
    row("sre", rooms.sre, () => sreTone(rooms.sre)),
    row("finance", rooms.finance, () => financeTone(rooms.finance)),
    row("qa", rooms.qa, () => qaTone(rooms.qa)),
    row("support", rooms.support, () => supportTone(rooms.support)),
    row("trust", rooms.trust, () => trustTone(rooms.trust)),
    row("routing", rooms.routing, () => routingTone(rooms.routing)),
  ];
}
