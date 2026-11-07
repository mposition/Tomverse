// The Agent office's teams: who is on each team, what each room's colour is,
// and what its lead says. Every room's status and every line a lead keeps over
// its head is a live room's record (setLive); a room with no live reading is
// drawn as waiting, or as waiting on a link when the console has no record
// screen for it. Where people stand on the floor is lib/agentOffice/floor.ts.

import type { AdminMessageShape } from "@/lib/adminLocale";
import type { AgentOfficeCopy } from "@/lib/adminMessages/agentOffice";
import type { AgentOfficeLiveDept } from "@/lib/agentOffice/live";
import {
  AGENT_OFFICE_BLOCKED_DEPTS,
  AGENT_OFFICE_DEPT_IDS,
  AGENT_OFFICE_OPERATOR,
  AGENT_OFFICE_STAFF,
  type AgentOfficeRank,
} from "@/lib/agentOffice/roster";

export type OfficeCopy = AdminMessageShape<AgentOfficeCopy>;

/**
 * A room's colour. `attention` is only ever a real record's: a run that
 * failed or an agent gone silent, which is neither waiting on a link nor a
 * decision waiting for the operator.
 */
export type DeptStatus = "done" | "working" | "attention" | "blocked" | "waiting";

export type StaffSeed = {
  id: string;
  name: string;
  callsign?: string;
  role: string;
  deptId: string;
  rank: AgentOfficeRank;
  hair: string;
  shirt: string;
  accent: string;
  skin: string;
  /** A line in their own voice for the profile: persona, not a reading. */
  thoughts: readonly string[];
};

export type Snapshot = {
  deptStatus: Record<string, DeptStatus>;
  stats: { done: number; working: number; attention: number; blocked: number };
};

type StaffCopy = { name: string; role: string; callsign?: string; thoughts: readonly string[] };

const SKIN = ["#ffdcc4", "#f7cdae", "#ffe3cf", "#eec39f"];

/** The office's staff and operator, with their copy in one console language. */
export function buildStaff(copy: OfficeCopy): { staff: StaffSeed[]; operator: StaffSeed } {
  const staffCopy = copy.staff as unknown as Record<string, StaffCopy>;
  const staff = AGENT_OFFICE_STAFF.map((meta, i): StaffSeed => {
    const words = staffCopy[meta.id];
    return {
      id: meta.id,
      name: words.name,
      callsign: words.callsign,
      role: words.role,
      deptId: meta.dept,
      rank: meta.rank,
      hair: meta.colors[0],
      shirt: meta.colors[1],
      accent: meta.colors[2],
      skin: SKIN[i % SKIN.length],
      thoughts: words.thoughts,
    };
  });
  const operator: StaffSeed = {
    id: AGENT_OFFICE_OPERATOR.id,
    name: copy.company.operatorName,
    callsign: copy.company.operatorCallsign,
    role: copy.company.operatorRole,
    deptId: "operator",
    rank: "operator",
    hair: AGENT_OFFICE_OPERATOR.hair,
    shirt: AGENT_OFFICE_OPERATOR.shirt,
    accent: AGENT_OFFICE_OPERATOR.accent,
    skin: AGENT_OFFICE_OPERATOR.skin,
    thoughts: copy.company.operatorThoughts,
  };
  return { staff, operator };
}

export class AgentOffice {
  readonly copy: OfficeCopy;
  readonly staff: StaffSeed[];
  readonly operatorSeed: StaffSeed;
  readonly deptLead: Record<string, StaffSeed>;
  deptStatus: Record<string, DeptStatus> = {};
  /** Rooms that show a real record: their status, and what their lead says, are the record's. */
  private live: Readonly<Record<string, AgentOfficeLiveDept>>;

  constructor(copy: OfficeCopy, live: Readonly<Record<string, AgentOfficeLiveDept>> = {}) {
    this.copy = copy;
    this.live = live;
    const { staff, operator } = buildStaff(copy);
    this.staff = staff;
    this.operatorSeed = operator;
    this.deptLead = Object.fromEntries(staff.filter((s) => s.rank === "lead").map((s) => [s.deptId, s]));
    for (const id of AGENT_OFFICE_DEPT_IDS) {
      this.deptStatus[id] = this.live[id]?.status ?? (AGENT_OFFICE_BLOCKED_DEPTS.has(id) ? "blocked" : "waiting");
    }
  }

  deptCopy(deptId: string) {
    const depts = this.copy.depts as unknown as Record<string, { name: string; task: string; blockReason: string }>;
    return depts[deptId];
  }

  roomName(roomId: string) {
    if (roomId === "operator") return this.copy.rooms.operator;
    if (roomId === "decision") return this.copy.rooms.decision;
    return this.deptCopy(roomId).name;
  }

  /** A team's people in roster order, lead first. */
  deptStaff(deptId: string): StaffSeed[] {
    const people = this.staff.filter((s) => s.deptId === deptId);
    return [...people.filter((s) => s.rank === "lead"), ...people.filter((s) => s.rank !== "lead")];
  }

  /** Takes a fresh reading of the live rooms. Their status follows the record; no other room moves. */
  setLive(live: Readonly<Record<string, AgentOfficeLiveDept>>) {
    this.live = live;
    for (const [deptId, room] of Object.entries(live)) {
      if (deptId in this.deptStatus) this.deptStatus[deptId] = room.status;
    }
  }

  /** The live reading for a room, or null for one without. */
  liveDept(deptId: string): AgentOfficeLiveDept | null {
    return this.live[deptId] ?? null;
  }

  snapshot(): Snapshot {
    const values = Object.values(this.deptStatus);
    return {
      deptStatus: { ...this.deptStatus },
      stats: {
        done: values.filter((v) => v === "done").length,
        working: values.filter((v) => v === "working").length,
        attention: values.filter((v) => v === "attention").length,
        blocked: values.filter((v) => v === "blocked").length,
      },
    };
  }
}
