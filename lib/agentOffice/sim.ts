// The Agent office's floor: who sits where, what each room's colour is, what
// its lead says, and the operator console's answers.
//
// It plays nothing. Every room's status and every line a lead keeps over its
// head is a live room's record (setLive); a room with no live reading is drawn
// as waiting, or as waiting on a link when the console has no record screen
// for it. Nobody walks, works or meets: the staff stay at their desks, and the
// only words of their own are a greeting or a thank-you in the console with a
// moment's emoji on the floor.

import type { AdminMessageShape } from "@/lib/adminLocale";
import type { AgentOfficeCopy } from "@/lib/adminMessages/agentOffice";
import type { AgentOfficeLiveDept } from "@/lib/agentOffice/live";
import {
  AGENT_OFFICE_BLOCKED_DEPTS,
  AGENT_OFFICE_DEPT_KEYWORDS,
  AGENT_OFFICE_NARRATOR_ID,
  AGENT_OFFICE_OPERATOR,
  AGENT_OFFICE_STAFF,
  type AgentOfficeRank,
} from "@/lib/agentOffice/roster";
import { aestClock } from "@/lib/agentOffice/time";
import { DEPT_ROOMS, OPERATOR_SEAT, type Pt } from "@/lib/agentOffice/world";

export type OfficeCopy = AdminMessageShape<AgentOfficeCopy>;

/**
 * A room's colour. `attention` is only ever a real record's: a run that
 * failed or an agent gone silent, which is neither waiting on a link nor a
 * decision waiting for the operator.
 */
export type DeptStatus = "done" | "working" | "attention" | "blocked" | "waiting";
/** The operator is at work; everyone else sits at a desk. */
export type AgentStatus = "idle" | "working";
export type Facing = "up" | "down";

/** Bilingual console patterns: parsing rules, not displayed copy. */
const ORDER = {
  everyone: /전체|모두|다들|everyone|\ball\b|every team/i,
  /** Orders the office cannot carry out: it shows records and moves nobody. */
  order: /집중|커피 ?금지|딴짓|자리 지켜|focus|no coffee|stay at|자유|쉬어|휴식 허용|집중 해제|relax|unfocus|take a break|자리로|복귀|착석|back to (your )?desk|sit down|빨리|서둘|속도|급해|당겨|speed|faster|hurry|회의|모여|소집|meeting|gather|브리핑|보고하러|올라와|brief|승인|오케이|고고|진행해|approve|go ahead/i,
  cheer: /수고|칭찬|잘했|좋아요|고마|thank|good job|well done/i,
  delay: /왜|늦|지연|막힘|블로|안 되|안돼|문제|why|slow|late|delay|stuck|block/i,
  status: /뭐|현황|상황|진행|보고|어디까지|status|what|progress|report/i,
  hello: /안녕|하이|좋은 ?아침|반가|\bhello\b|\bhi\b|good morning/i,
  /** A line that asks rather than orders: it may mention an order without giving it. */
  question: /[?？]|왜|언제|어떻게|뭐|why|when|how|what|whether/i,
} as const;

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

export type Agent = StaffSeed & {
  x: number;
  y: number;
  facing: Facing;
  status: AgentStatus;
  /** The desk they sit at. */
  home: Pt;
  /** What their team does, for the profile. */
  taskLabel: string;
  speech: string | null;
  speechFor: number;
  /** A small render offset that keeps neighbours apart. */
  jitter: number;
};

/** The operator console's conversation. */
export type ChatEntry = {
  id: number;
  time: string;
  from: "operator" | "staff";
  name: string;
  text: string;
};

export type Snapshot = {
  deptStatus: Record<string, DeptStatus>;
  stats: { done: number; working: number; attention: number; blocked: number };
  chat: ChatEntry[];
  /** A room the console just answered about, for the camera. */
  spotlight: string | null;
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

  agents: Agent[] = [];
  agentById = new Map<string, Agent>();
  deptStatus: Record<string, DeptStatus> = {};
  chat: ChatEntry[] = [];
  spotlight: string | null = null;

  /** How many the office draws, as shown: the teams' staff until the page says otherwise. */
  private staffText: string;
  private spotlightUntil = 0;
  private elapsed = 0;
  private chatSeq = 0;
  /** Rooms that show a real record: their status, and what their lead says, are the record's. */
  private live: Readonly<Record<string, AgentOfficeLiveDept>>;

  constructor(copy: OfficeCopy, live: Readonly<Record<string, AgentOfficeLiveDept>> = {}) {
    this.copy = copy;
    this.live = live;
    const { staff, operator } = buildStaff(copy);
    this.staff = staff;
    this.staffText = String(staff.length);
    this.operatorSeed = operator;
    this.deptLead = Object.fromEntries(staff.filter((s) => s.rank === "lead").map((s) => [s.deptId, s]));

    // Everyone at their own desk, in roster order.
    const seats = new Map<string, Pt[]>();
    for (const room of DEPT_ROOMS) seats.set(room.id, room.desks.map((desk) => desk.seat));
    for (const seed of this.staff) {
      const seat = seats.get(seed.deptId)?.shift();
      if (seat) this.place(seed, seat);
    }
    const operatorAgent = this.place(this.operatorSeed, OPERATOR_SEAT);
    operatorAgent.status = "working";
    operatorAgent.facing = "down";

    for (const room of DEPT_ROOMS) {
      this.deptStatus[room.id] =
        this.live[room.id]?.status ?? (AGENT_OFFICE_BLOCKED_DEPTS.has(room.id) ? "blocked" : "waiting");
    }
    this.pushChat("staff", this.narratorName(), this.copy.sim.welcome(this.narratorName()));
  }

  private place(seed: StaffSeed, seat: Pt): Agent {
    const isOperator = seed.rank === "operator";
    const agent: Agent = {
      ...seed,
      x: seat.x,
      y: seat.y,
      facing: "up",
      status: "idle",
      home: seat,
      taskLabel: isOperator ? seed.role : this.deptCopy(seed.deptId).task,
      speech: null,
      speechFor: 0,
      jitter: (Math.random() - 0.5) * 0.28,
    };
    this.agents.push(agent);
    this.agentById.set(agent.id, agent);
    return agent;
  }

  // ── Copy lookups ──────────────────────────────────────────
  deptCopy(deptId: string) {
    const depts = this.copy.depts as unknown as Record<string, { name: string; task: string; blockReason: string }>;
    return depts[deptId];
  }

  roomName(roomId: string) {
    if (roomId === "operator") return this.copy.rooms.operator;
    if (roomId === "decision") return this.copy.rooms.decision;
    return this.deptCopy(roomId).name;
  }

  private narratorName() {
    return this.agentById.get(AGENT_OFFICE_NARRATOR_ID)?.name ?? "";
  }

  private leadOf(deptId: string) {
    return this.agentById.get(this.deptLead[deptId].id)!;
  }

  private deptAgents(deptId: string) {
    return this.agents.filter((a) => a.deptId === deptId && a.rank !== "operator");
  }

  // ── The operator console ───────────────────────────────────
  pushChat(from: "operator" | "staff", name: string, text: string) {
    // A line is stamped with the time it was said, on the operator's clock.
    this.chat.push({ id: this.chatSeq++, time: aestClock(new Date().toISOString()), from, name, text });
    if (this.chat.length > 60) this.chat.shift();
  }

  /** Read one line from the console and answer it. Nothing here acts on anything. */
  command(raw: string) {
    const text = raw.trim();
    if (!text) return;
    this.pushChat("operator", this.operatorSeed.name, text);

    const deptId = this.matchDept(text);
    if ((ORDER.hello.test(text) || ORDER.cheer.test(text)) && !ORDER.question.test(text)) {
      this.smallTalk(ORDER.cheer.test(text) ? "thanks" : "hello", deptId && !ORDER.everyone.test(text) ? deptId : null);
      return;
    }
    if (deptId && !ORDER.everyone.test(text)) {
      this.deptReport(deptId);
      return;
    }
    // An order is declined: the office shows records and moves nobody. A
    // question that names one ("a meeting?") goes on to the questions below.
    if (ORDER.order.test(text) && !ORDER.question.test(text)) {
      this.pushChat("staff", this.narratorName(), this.copy.sim.ordersDeclined);
      return;
    }
    if (ORDER.delay.test(text)) return this.reportDelay();
    if (ORDER.status.test(text)) return this.reportStatus();

    this.pushChat("staff", this.narratorName(), this.copy.sim.unknown);
  }

  // ── Reports ────────────────────────────────────────────────
  /** What the live rooms that need a look or are at work read, and the counts. */
  private reportStatus() {
    const s = this.copy.sim;
    const lines: string[] = [s.statusReal];
    for (const [dept, status] of Object.entries(this.deptStatus)) {
      const live = this.live[dept];
      if (live && (status === "attention" || status === "working")) lines.push(`${this.roomName(dept)}: ${live.line}`);
    }
    const stats = this.snapshot().stats;
    lines.push(s.statusCounts(stats.done, stats.attention, stats.blocked, this.staffText));
    this.pushChat("staff", this.narratorName(), lines.join("\n"));
  }

  private reportDelay() {
    const s = this.copy.sim;
    const lines: string[] = [];
    // A real record that needs a look, or a real run in progress, is named in its own words.
    for (const [dept, status] of Object.entries(this.deptStatus)) {
      const live = this.live[dept];
      if ((status === "attention" || status === "working") && live) lines.push(`${this.roomName(dept)}: ${live.line}`);
    }
    const blocked = Object.entries(this.deptStatus)
      .filter(([, status]) => status === "blocked")
      .map(([dept]) => dept);
    if (blocked.length) {
      if (lines.length) {
        // The real bottleneck is named already; the blocked teams get one line.
        lines.push(s.delayBlockedSummary(blocked.length, blocked.map((d) => this.roomName(d)).join(" · ")));
      } else {
        for (const dept of blocked) lines.push(`${this.roomName(dept)}: ${this.deptCopy(dept).blockReason}`);
      }
    }
    if (!lines.length) lines.push(s.delayNone);
    this.pushChat("staff", this.narratorName(), lines.join("\n"));
  }

  private deptReport(deptId: string) {
    const s = this.copy.sim;
    const lead = this.leadOf(deptId);
    const status = this.deptStatus[deptId];
    const live = this.live[deptId];
    const lines: string[] = [];

    if (live) {
      // The lead answers in its own voice, then with the record.
      const voice = (this.copy.real.voices as Record<string, { answer: string }>)[deptId] ?? this.copy.real.voiceDefault;
      lines.push(voice.answer, this.copy.real.console(live.line));
      if (live.detail) lines.push(live.detail);
      lines.push(this.copy.real.contentElsewhere);
    } else if (status === "blocked") {
      lines.push(this.deptCopy(deptId).blockReason);
    } else {
      lines.push(s.deptWaiting(this.deptCopy(deptId).task));
    }
    lines.push(s.deptCrew(this.deptAgents(deptId).map((a) => s.crewItem(a.name, this.copy.agentStatus[a.status])).join(" · ")));

    this.pushChat("staff", s.speaker(lead.name, this.roomName(deptId)), lines.join("\n"));
    this.spotlightRoom(deptId, 8);
  }

  /**
   * A greeting or a thank-you is answered by the leads of the rooms that read
   * a real record (or the one named), each in its own voice. The words are
   * social, never a claim about the team's work, and on the floor a lead only
   * reacts with an emoji for a moment -- its bubble otherwise stays the
   * record's line.
   */
  private smallTalk(kind: "hello" | "thanks", deptId: string | null) {
    const real = this.copy.real;
    const rooms = (deptId ? [deptId] : Object.keys(this.live)).filter((dept) => this.live[dept] && this.deptLead[dept]);
    if (rooms.length === 0) {
      this.pushChat("staff", this.narratorName(), real.noLiveRoom);
      return;
    }
    for (const dept of rooms) {
      const lead = this.leadOf(dept);
      const voice = (real.voices as Record<string, { hello: string; thanks: string }>)[dept] ?? real.voiceDefault;
      this.pushChat("staff", this.copy.sim.speaker(lead.name, this.roomName(dept)), voice[kind]);
      this.react(lead, real.reactions[kind]);
    }
  }

  /** A moment's emoji over a lead's head; the record line comes back when it ends. */
  private react(agent: Agent, emoji: string) {
    agent.speech = emoji;
    agent.speechFor = 3;
  }

  private spotlightRoom(roomId: string, seconds: number) {
    this.spotlight = roomId;
    this.spotlightUntil = this.elapsed + seconds;
  }

  /** The team a console line names: team words first, then names and callsigns. */
  private matchDept(text: string): string | null {
    const lower = text.toLowerCase();
    for (const [deptId, words] of AGENT_OFFICE_DEPT_KEYWORDS) {
      if (words.some((word) => lower.includes(word.toLowerCase()))) return deptId;
    }
    const person = this.staff.find(
      (s) => lower.includes(s.name.toLowerCase()) || (s.callsign !== undefined && lower.includes(s.callsign.toLowerCase()))
    );
    return person?.deptId ?? null;
  }

  // ── Live readings ──────────────────────────────────────────
  /**
   * Takes a fresh reading of the live rooms. Their status follows the record;
   * no other room moves.
   */
  setLive(live: Readonly<Record<string, AgentOfficeLiveDept>>) {
    const previous = this.live;
    this.live = live;
    for (const [deptId, room] of Object.entries(live)) {
      if (deptId in this.deptStatus) this.deptStatus[deptId] = room.status;
      // A fresh reading replaces what the room's lead is saying.
      const lead = this.agentById.get(this.deptLead[deptId]?.id ?? "");
      if (lead) this.showRecordLine(lead, room.line);
      // A room whose record changed since the last reading says so in the
      // console, in its lead's name. The first reading is not a change, and a
      // reading that only moved its detail is not one; a room whose line
      // cannot tell two readings apart says so with its revision.
      const before = previous[deptId];
      if (
        lead &&
        before &&
        (before.status !== room.status ||
          before.badge !== room.badge ||
          before.line !== room.line ||
          before.revision !== room.revision)
      ) {
        this.pushChat("staff", lead.name, this.copy.real.changed(this.roomName(deptId), room.line));
      }
    }
  }

  /** The record line a live room's lead keeps on screen, or null for anyone else. */
  private recordLine(agent: Agent): string | null {
    const live = this.live[agent.deptId];
    return live && agent.rank === "lead" ? live.line : null;
  }

  private showRecordLine(agent: Agent, line: string) {
    agent.speech = line;
    agent.speechFor = Number.POSITIVE_INFINITY;
  }

/** Everyone the office draws, as the page counts them (agentOfficeStaffCount): the console says the same. */
  setStaffCount(text: string) {
    this.staffText = text;
  }

  /** The live reading for a room, or null for one without. */
  liveDept(deptId: string): AgentOfficeLiveDept | null {
    return this.live[deptId] ?? null;
  }

  // ── Tick ───────────────────────────────────────────────────
  /** Speech bubbles run out and the spotlight fades; nothing else moves. */
  tick(rawDt: number) {
    const dt = Math.min(rawDt, 0.05);
    for (const agent of this.agents) {
      if (agent.speechFor > 0) {
        agent.speechFor -= dt;
        if (agent.speechFor <= 0) agent.speech = null;
      }
      // A live room's lead keeps its record's line on screen.
      const recordLine = this.recordLine(agent);
      if (recordLine !== null && agent.speech === null) this.showRecordLine(agent, recordLine);
    }
    this.elapsed += dt;
    if (this.spotlight && this.elapsed > this.spotlightUntil) this.spotlight = null;
  }

  // ── Snapshot ───────────────────────────────────────────────
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
      chat: this.chat.slice(-24),
      spotlight: this.spotlight,
    };
  }
}
