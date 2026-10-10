// The Agent office's demo engine: agent state machines, A* movement, meetings
// and one scripted day. Ported from the original AI OFFICE engine; the day is
// rewritten around the eight agent teams.
//
// Nothing here reads an agent's record. Every status, line and approval is
// the demo scenario, and the operator's approval only advances the demo.

import type { AdminMessageShape } from "@/lib/adminLocale";
import type { AgentOfficeCopy } from "@/lib/adminMessages/agentOffice";
import type { AgentOfficeLiveDept } from "@/lib/agentOffice/live";
import { findPath } from "@/lib/agentOffice/pathfinding";
import { aestClock } from "@/lib/agentOffice/time";
import {
  AGENT_OFFICE_BLOCKED_DEPTS,
  AGENT_OFFICE_DEPT_KEYWORDS,
  AGENT_OFFICE_NARRATOR_ID,
  AGENT_OFFICE_OPERATOR,
  AGENT_OFFICE_STAFF,
  type AgentOfficeRank,
} from "@/lib/agentOffice/roster";
import {
  COLS,
  DEPT_ROOMS,
  ENTRANCE,
  MEETING_SEATS,
  OPERATOR_REPORT_SPOT,
  OPERATOR_SEAT,
  doorApproach,
  roomOf,
  walkable,
  type Pt,
} from "@/lib/agentOffice/world";

export type OfficeCopy = AdminMessageShape<AgentOfficeCopy>;

/**
 * A room's colour. `attention` is only ever a real record's: a run that
 * failed or an agent gone silent, which is neither waiting on a link nor a
 * decision waiting for the operator.
 */
export type DeptStatus = "done" | "working" | "approval" | "attention" | "blocked" | "waiting";
export type AgentStatus =
  | "offDuty"
  | "commuting"
  | "idle"
  | "moving"
  | "working"
  | "meeting"
  | "reporting"
  | "blocked";
export type Anim = "idle" | "walk" | "type" | "talk" | "sit";
export type Facing = "up" | "down" | "left" | "right";

const WALK_SPEED = 3.6; // tiles / sec
/**
 * The office clock runs on simulated time: one simulated second is 1.6
 * minutes. Raising the playback speed speeds the clock up with it, so at any
 * speed the day runs from 07:00 to about 17:00.
 */
const SIM_MIN_PER_SEC = 1.6;
/** Playback speed while skipping ahead (⏭). */
const TURBO_SPEED = 10;

/** Phase indexes the day script and the screens share. */
export const PHASE = {
  beforeWork: 0,
  arrival: 1,
  qa: 2,
  linkCheck: 3,
  research: 4,
  engineering: 5,
  draftSummary: 6,
  approval: 7,
  prPrep: 8,
  marketing: 9,
  digest: 10,
  briefing: 11,
  dayOver: 12,
} as const;
export const PHASE_COUNT = 13;

/** Bilingual order patterns: parsing rules, not displayed copy. */
const ORDER = {
  everyone: /전체|모두|다들|everyone|\ball\b|every team/i,
  focusOn: /집중|커피 ?금지|딴짓|자리 지켜|focus|no coffee|stay at/i,
  focusOff: /자유|쉬어|휴식 허용|집중 해제|relax|unfocus|take a break/i,
  recall: /자리로|복귀|착석|back to (your )?desk|sit down/i,
  boost: /빨리|서둘|속도|급해|당겨|speed|faster|hurry/i,
  convene: /회의|모여|소집|meeting|gather/i,
  brief: /브리핑|보고하러|올라와|brief/i,
  approve: /승인|오케이|고고|진행해|approve|go ahead/i,
  cheer: /수고|칭찬|잘했|좋아요|고마|thank|good job|well done/i,
  delay: /왜|늦|지연|막힘|블로|안 되|안돼|문제|why|slow|late|delay|stuck|block/i,
  status: /뭐|현황|상황|진행|보고|어디까지|status|what|progress|report/i,
  late: /왜|늦|지연|why|late|slow/i,
  hello: /안녕|하이|좋은 ?아침|반가|\bhello\b|\bhi\b|good morning/i,
  /** A line that asks rather than orders: it may mention approval without giving it. */
  question: /[?？]|왜|언제|어떻게|뭐|why|when|how|what|whether/i,
} as const;

type Action =
  | { k: "walk"; to: Pt }
  | { k: "say"; text: string; dur: number; kind: "talk" | "think" }
  | { k: "wait"; dur: number }
  | { k: "face"; dir: Facing }
  | { k: "anim"; a: Anim }
  | { k: "status"; s: AgentStatus }
  | { k: "work"; dur: number; label: string }
  | { k: "fn"; fn: () => void };

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
  /** What they muse about when nothing is going on. */
  thoughts: readonly string[];
};

export type Agent = StaffSeed & {
  x: number;
  y: number;
  facing: Facing;
  anim: Anim;
  status: AgentStatus;
  home: Pt;
  progress: number;
  taskLabel: string;

  path: Pt[];
  pathIdx: number;
  queue: Action[];
  current: Action | null;
  timer: number;
  speech: string | null;
  speechKind: "talk" | "think";
  speechFor: number;
  idleFor: number;
  /** A small render offset that keeps overlapping agents apart. */
  jitter: number;
};

export type LogTone = "pink" | "mint" | "lav" | "yellow";
export type LogEntry = { id: number; time: string; icon: string; text: string; tone: LogTone };
/** The operator console's conversation. */
export type ChatEntry = {
  id: number;
  time: string;
  from: "operator" | "staff";
  name: string;
  text: string;
};

type Step = number | (() => boolean);
type Script = Generator<Step, void, void>;

type Slot = {
  gen: Script | null;
  wait: number;
  until: (() => boolean) | null;
};

export type Snapshot = {
  clock: string;
  running: boolean;
  paused: boolean;
  speed: number;
  turbo: boolean;
  dayComplete: boolean;
  phase: string;
  phaseIndex: number;
  /** A demo day is on screen; otherwise the office shows its real view. */
  demo: boolean;
  /** Phases a live room replaces; they are neither played nor shown as done. */
  skippedPhases: number[];
  approvalPending: boolean;
  approved: boolean;
  briefingReady: boolean;
  deptStatus: Record<string, DeptStatus>;
  stats: { done: number; working: number; approval: number; attention: number; blocked: number };
  log: LogEntry[];
  meetingTitle: string | null;
  chat: ChatEntry[];
  focusMode: boolean;
  spotlight: string | null;
  busyWithOrder: boolean;
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

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class AgentOffice {
  readonly copy: OfficeCopy;
  readonly staff: StaffSeed[];
  readonly operatorSeed: StaffSeed;
  readonly deptLead: Record<string, StaffSeed>;

  agents: Agent[] = [];
  agentById = new Map<string, Agent>();
  deptStatus: Record<string, DeptStatus> = {};
  log: LogEntry[] = [];
  clockMinutes = 7 * 60;
  /** Playback speed -- the whole simulation, never any real agent. */
  speed = 2;
  turbo = false;
  paused = false;
  running = false;
  dayComplete = false;
  /**
   * Whether a demo day is on screen. The office opens on its real view:
   * everyone at their desk, every room at its real or link status, and nobody
   * moving or speaking a scripted line. The demo plays only when started.
   */
  demo = false;
  phaseIndex = 0;
  approvalPending = false;
  approved = false;
  briefingReady = false;
  /** Meetings in progress, oldest first: the day's own and any the operator called. */
  private activeMeetings: string[] = [];
  onBriefing: (() => void) | null = null;
  chat: ChatEntry[] = [];
  focusMode = false;
  spotlight: string | null = null;

  private spotlightUntil = 0;
  private elapsed = 0;
  private approvalSince: number | null = null;
  private logSeq = 0;
  /** The day script (main) and scenes an operator order slots in (side) run side by side. */
  private main: Slot = { gen: null, wait: 0, until: null };
  private side: Slot = { gen: null, wait: 0, until: null };
  private occupancy = new Set<number>();
  private seatBook = new Map<string, Pt>();
  /** Who in each team still has to finish the work it was given. */
  private pendingWork = new Map<string, Set<string>>();
  /** Agents in a scene: their own idle behaviour (a thought, a chat) cannot cut in. */
  private locked = new Set<string>();
  /**
   * Rooms that show a real record. The demo never simulates them: their
   * status is the record's, nobody in them is given scripted work, and what
   * their lead says is the record's line.
   */
  private live: Readonly<Record<string, AgentOfficeLiveDept>>;

  constructor(copy: OfficeCopy, live: Readonly<Record<string, AgentOfficeLiveDept>> = {}) {
    this.copy = copy;
    this.live = live;
    const { staff, operator } = buildStaff(copy);
    this.staff = staff;
    this.operatorSeed = operator;
    this.deptLead = Object.fromEntries(
      staff.filter((s) => s.rank === "lead").map((s) => [s.deptId, s])
    );
    this.reset();
  }

  reset() {
    this.agents = [];
    this.agentById.clear();
    this.log = [];
    this.logSeq = 0;
    this.clockMinutes = 7 * 60;
    this.running = false;
    this.paused = false;
    this.dayComplete = false;
    this.phaseIndex = PHASE.beforeWork;
    this.approvalPending = false;
    this.approved = false;
    this.briefingReady = false;
    this.activeMeetings = [];
    this.pendingWork.clear();
    this.main = { gen: null, wait: 0, until: null };
    this.side = { gen: null, wait: 0, until: null };
    this.seatBook.clear();
    this.locked.clear();
    this.chat = [];
    this.focusMode = false;
    this.spotlight = null;
    this.spotlightUntil = 0;
    this.elapsed = 0;
    this.approvalSince = null;

    const seats = new Map<string, Pt[]>();
    for (const room of DEPT_ROOMS) seats.set(room.id, room.desks.map((d) => d.seat));

    for (const seed of this.staff) {
      const pool = seats.get(seed.deptId);
      const home = pool?.shift() ?? { x: ENTRANCE.x, y: ENTRANCE.y - 2 };
      // Outside the demo everyone is at their desk. In the demo a demo room's
      // staff start at the entrance and arrive; a live room's stay where they
      // are, because the demo's day is not theirs.
      const seated = !this.demo || this.isLive(seed.deptId);
      this.spawn(seed, home, seated ? home : { x: ENTRANCE.x, y: ENTRANCE.y }, seated);
    }
    this.spawn(this.operatorSeed, OPERATOR_SEAT, OPERATOR_SEAT);

    const operator = this.operator();
    operator.status = "working";
    operator.anim = "sit";
    operator.facing = "down";

    for (const room of DEPT_ROOMS) {
      this.deptStatus[room.id] =
        this.live[room.id]?.status ?? (AGENT_OFFICE_BLOCKED_DEPTS.has(room.id) ? "blocked" : "waiting");
    }
    this.pushLog("🎛️", this.demo ? this.copy.sim.ready : this.copy.sim.realReady, "lav");
    this.pushChat("staff", this.narratorName(), this.copy.sim.welcome(this.narratorName()));
  }

  private spawn(seed: StaffSeed, home: Pt, at: Pt, seated = false) {
    const isOperator = seed.rank === "operator";
    const agent: Agent = {
      ...seed,
      x: at.x,
      y: at.y,
      facing: seated ? "up" : "down",
      anim: isOperator || seated ? "sit" : "idle",
      status: isOperator ? "working" : seated ? "idle" : "offDuty",
      home,
      progress: 0,
      taskLabel: isOperator ? seed.role : this.deptCopy(seed.deptId).task,
      path: [],
      pathIdx: 0,
      queue: [],
      current: null,
      timer: 0,
      speech: null,
      speechKind: "talk",
      speechFor: 0,
      idleFor: Math.random() * 8,
      jitter: (Math.random() - 0.5) * 0.28,
    };
    this.agents.push(agent);
    this.agentById.set(agent.id, agent);
  }

  // ── Copy lookups ──────────────────────────────────────────
  deptCopy(deptId: string) {
    const depts = this.copy.depts as unknown as Record<
      string,
      { name: string; task: string; report: string; blockReason: string }
    >;
    return depts[deptId];
  }

  roomName(roomId: string) {
    if (roomId === "operator") return this.copy.rooms.operator;
    if (roomId === "decision") return this.copy.rooms.decision;
    return this.deptCopy(roomId).name;
  }

  phaseName(index: number) {
    return this.copy.phases[index] ?? "";
  }

  private operator() {
    return this.agentById.get(AGENT_OFFICE_OPERATOR.id)!;
  }

  private narrator() {
    return this.agentById.get(AGENT_OFFICE_NARRATOR_ID)!;
  }

  private narratorName() {
    return this.agentById.get(AGENT_OFFICE_NARRATOR_ID)?.name ?? "";
  }

  /** The meeting on screen: the most recent one still in progress. */
  get meetingTitle(): string | null {
    return this.activeMeetings.at(-1) ?? null;
  }

  private beginMeeting(title: string) {
    this.activeMeetings.push(title);
  }

  private endMeeting(title: string) {
    const index = this.activeMeetings.lastIndexOf(title);
    if (index >= 0) this.activeMeetings.splice(index, 1);
  }

  // ── Log ────────────────────────────────────────────────────
  pushLog(icon: string, text: string, tone: LogTone = "pink") {
    this.log.unshift({ id: this.logSeq++, time: this.clockText(), icon, text, tone });
    if (this.log.length > 60) this.log.pop();
  }

  clockText() {
    const total = Math.floor(this.clockMinutes) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // ── Action queue ───────────────────────────────────────────
  private enqueue(agent: Agent, ...actions: Action[]) {
    agent.queue.push(...actions);
  }

  private goto(agent: Agent, to: Pt, status: AgentStatus = "moving") {
    this.enqueue(agent, { k: "status", s: status }, { k: "walk", to });
  }

  private sitAtDesk(agent: Agent) {
    this.enqueue(
      agent,
      { k: "walk", to: agent.home },
      { k: "face", dir: "up" },
      { k: "anim", a: "sit" },
      { k: "status", s: "idle" }
    );
  }

  say(agent: Agent, text: string, dur = 2.6, kind: "talk" | "think" = "talk") {
    // A live room's staff say the record's line or nothing: beside a LIVE
    // chip, a greeting, a cheer or a passing thought would read as the
    // agent's own finding. One gate here rather than one at every caller.
    const live = this.live[agent.deptId];
    if (live && text !== live.line) return;
    agent.speech = text;
    agent.speechKind = kind;
    agent.speechFor = dur;
  }

  /** A scene starts: cut off what the agents were doing on their own, and lock them. */
  private lock(agents: Agent[]) {
    for (const agent of agents) {
      this.locked.add(agent.id);
      agent.queue.length = 0;
      agent.current = null;
      agent.path = [];
      agent.pathIdx = 0;
    }
  }

  private unlock(agents: Agent[]) {
    for (const agent of agents) this.locked.delete(agent.id);
  }

  private busy(agent: Agent) {
    return agent.queue.length > 0 || agent.current !== null;
  }

  private allFree(agents: Agent[]) {
    return () => agents.every((a) => !this.busy(a));
  }

  private deptAgents(deptId: string) {
    return this.agents.filter((a) => a.deptId === deptId && a.rank !== "operator");
  }

  private leadOf(deptId: string) {
    return this.agentById.get(this.deptLead[deptId].id)!;
  }

  // ── The day ────────────────────────────────────────────────
  /** Plays the demo day. */
  start() {
    if (this.running) return;
    this.demo = true;
    this.reset();
    this.running = true;
    this.main.gen = this.dayScript();
  }

  /** Leaves the demo for the real view: everyone back at their desk, every room at its real or link status. */
  endDemo() {
    if (!this.demo) return;
    this.demo = false;
    this.turbo = false;
    this.reset();
    this.pushChat("staff", this.narratorName(), this.copy.sim.demoEnded);
  }

  private *dayScript(): Script {
    const s = this.copy.sim;

    // ① 07:00 arrival
    this.phaseIndex = PHASE.arrival;
    // A live room's staff are already at their desks; only the demo's arrive.
    const workers = this.agents.filter((a) => a.rank !== "operator" && !this.isLive(a.deptId));
    this.pushLog("🚪", s.arrival(workers.length), "yellow");
    this.lock(workers);
    for (const agent of workers) {
      this.enqueue(
        agent,
        { k: "status", s: "commuting" },
        { k: "wait", dur: Math.random() * 6 },
        { k: "fn", fn: () => this.say(agent, rand(s.greetings), 2.4) },
        { k: "walk", to: agent.home },
        { k: "face", dir: "up" },
        { k: "anim", a: "sit" },
        { k: "status", s: "idle" }
      );
    }
    yield this.allFree(workers);
    this.unlock(workers);
    this.pushLog("✅", s.seated, "mint");
    yield 0.6;

    const narrator = this.narrator();
    this.stand(narrator);
    this.say(narrator, s.narratorStart, 2.6);
    yield 1.6;
    this.sitAtDesk(narrator);

    // ② QA daily digest
    this.phaseIndex = PHASE.qa;
    yield* this.runDept("qa", s.qaLabel, 6.5, s.qaDone);

    // ③ Teams with no record screen sit the day out, and say why.
    this.phaseIndex = PHASE.linkCheck;
    const blocked = DEPT_ROOMS.filter((room) => this.deptStatus[room.id] === "blocked");
    if (blocked.length) {
      const first = this.leadOf(blocked[0].id);
      this.stand(first);
      this.say(first, s.blockedSay, 3);
      this.enqueue(first, { k: "wait", dur: 4 }, { k: "fn", fn: () => this.say(first, s.blockedLater, 2.4) });
      this.sitAtDesk(first);
      this.pushLog("🔌", s.blockedLog(blocked.map((room) => this.roomName(room.id)).join(" · ")), "lav");
    }
    yield 1.2;

    // ④ Product research observation (a live room says its record instead).
    this.phaseIndex = PHASE.research;
    yield* this.runDept("research", s.researchLabel, 6, s.researchDone);

    // Hand-off meeting: research → engineering → QA. A live room has no
    // scripted work to hand over, so its lead is not at the table.
    const handover = (
      [
        ["research-lead", s.handoverResearch],
        ["engineering-lead", s.handoverEngineering],
        ["qa-lead", s.handoverQa],
      ] as [string, string][]
    ).filter(([id]) => !this.agentIsLive(id));
    // With fewer than two teams left to hand over there is no meeting to hold.
    if (handover.length > 1) {
      yield* this.meeting(
        s.handoverTitle,
        handover.map(([id]) => id),
        handover
      );
    }

    // ⑤ Engineering T2 draft
    this.phaseIndex = PHASE.engineering;
    yield* this.runDept("engineering", s.engineeringLabel, 7, s.engineeringDone);

    // ⑥–⑧ The demo's one decision: a T2 draft, the operator's approval and
    // the PR it leads to. A live engineering room's decisions are real and are
    // made on its own screen, so the demo does not play one.
    if (!this.isLive("engineering")) yield* this.decisionScenes(narrator);

    // ⑨ Marketing drafts and the Guard
    this.phaseIndex = PHASE.marketing;
    yield* this.runDept("marketing", s.marketingLabel, 6.5, s.marketingDone);

    // ⑩ Collecting digests: the desk's member collects while the chief waits to brief.
    this.phaseIndex = PHASE.digest;
    this.startDept("digest", s.digestLabel, 5, [AGENT_OFFICE_NARRATOR_ID]);
    yield () => this.deptStatus.digest === "done";
    this.pushLog("📦", s.digestLog, "mint");

    // ⑪ Briefing the operator
    this.phaseIndex = PHASE.briefing;
    const operator = this.operator();
    this.lock([narrator]);
    this.stand(narrator);
    this.say(narrator, s.briefWalk, 3);
    this.goto(narrator, OPERATOR_REPORT_SPOT, "reporting");
    this.enqueue(narrator, { k: "face", dir: "up" });
    yield this.allFree([narrator]);
    this.say(narrator, this.isLive("engineering") ? s.briefSayLive : s.briefSay, 3.2);
    this.say(operator, s.briefOperator, 2.6);
    this.briefingReady = true;
    this.onBriefing?.();
    const stats = this.snapshot().stats;
    this.pushLog("📋", s.briefLog(stats.done, stats.attention, stats.blocked), "pink");
    yield 3;
    this.stand(narrator);
    this.sitAtDesk(narrator);
    yield this.allFree([narrator]);
    this.unlock([narrator]);

    this.phaseIndex = PHASE.dayOver;
    this.dayComplete = true;
    this.running = false;
    this.pushLog("🎀", s.dayOver, "yellow");
  }

  /** ⑥–⑧: the draft summary, the operator's approval meeting and the PR preparation. */
  private *decisionScenes(narrator: Agent): Script {
    const s = this.copy.sim;
    // ⑥ Draft summary
    this.phaseIndex = PHASE.draftSummary;
    const engineer = this.leadOf("engineering");
    this.stand(engineer);
    this.say(engineer, s.draftSay, 3);
    this.pushLog("🛠️", s.draftLog, "pink");
    yield 1.8;
    this.sitAtDesk(engineer);

    // ⑦ The operator's approval meeting
    this.phaseIndex = PHASE.approval;
    this.deptStatus.engineering = "approval";
    this.approvalPending = true;
    this.turbo = false; // a decision point always returns to normal speed
    this.beginMeeting(s.approvalMeeting);
    this.pushLog("📋", s.approvalLog, "yellow");

    const approvers = this.approverIds().map((id) => this.agentById.get(id)!);
    const operator = this.operator();
    this.lock([...approvers, operator]);
    approvers.forEach((agent, i) => {
      this.stand(agent);
      const seat = this.bookSeat(agent, i);
      this.goto(agent, seat, "meeting");
      this.enqueue(agent, { k: "face", dir: seat.y < 7 ? "down" : "up" }, { k: "anim", a: "sit" });
    });
    const operatorSeat = this.bookSeat(operator, 3);
    this.enqueue(
      operator,
      { k: "anim", a: "idle" },
      { k: "status", s: "meeting" },
      { k: "walk", to: operatorSeat },
      { k: "face", dir: operatorSeat.y < 7 ? "down" : "up" },
      { k: "anim", a: "sit" }
    );
    yield this.allFree([...approvers, operator]);

    this.say(engineer, s.approvalPitch, 3.4);
    yield 2.4;
    this.say(narrator, s.approvalNarrator, 3.2);
    yield 2.2;
    this.say(operator, s.approvalOperator, 2.4);

    // Wait for the operator's button.
    yield () => this.approved;

    this.approvalPending = false;
    this.endMeeting(s.approvalMeeting);
    this.deptStatus.engineering = "done";
    this.say(operator, s.approvedOperator, 2.8);
    this.pushLog("✅", s.approvedLog, "mint");
    yield 1.6;
    for (const agent of approvers) {
      this.releaseSeat(agent);
      this.stand(agent);
      this.sitAtDesk(agent);
    }
    this.releaseSeat(operator);
    this.enqueue(
      operator,
      { k: "anim", a: "idle" },
      { k: "walk", to: OPERATOR_SEAT },
      { k: "face", dir: "down" },
      { k: "anim", a: "sit" },
      { k: "status", s: "working" }
    );
    yield this.allFree([...approvers, operator]);
    this.unlock([...approvers, operator]);

    // ⑧ PR preparation: engineering hands the PR to QA, then both work at once.
    this.phaseIndex = PHASE.prPrep;
    const qaLive = this.isLive("qa");
    if (!qaLive) yield* this.deliver("engineering-lead", "qa", s.deliverLine, s.deliverReply);
    this.startDept("engineering", s.prLabel, 7);
    this.startDept("qa", s.ciLabel, 7);
    yield () => this.deptStatus.engineering === "done" && (qaLive || this.deptStatus.qa === "done");
    this.pushLog("🧪", s.prLog, "mint");
  }

  /** The demo phases a live room replaces: engineering's draft, approval and PR scenes. */
  skippedPhases(): number[] {
    return this.isLive("engineering") ? [PHASE.draftSummary, PHASE.approval, PHASE.prPrep] : [];
  }

  private isLive(deptId: string) {
    return this.live[deptId] !== undefined;
  }

  private agentIsLive(agentId: string) {
    const agent = this.agentById.get(agentId);
    return agent !== undefined && this.isLive(agent.deptId);
  }

  /** Who sits in the approval meeting: engineering, QA and the digest chief, less any live room. */
  private approverIds() {
    return ["engineering-lead", "qa-lead", AGENT_OFFICE_NARRATOR_ID].filter((id) => !this.agentIsLive(id));
  }

  /** The names of the people who sit in the approval meeting, for the approval card and the delay report. */
  approverNames() {
    return this.approverIds()
      .map((id) => this.agentById.get(id)?.name)
      .filter(Boolean)
      .join(" · ");
  }

  /** A live room's turn in the day: its lead says the record's line, and nobody plays at work. */
  private *announceLive(deptId: string): Script {
    const live = this.live[deptId];
    if (!live) return;
    const lead = this.leadOf(deptId);
    this.stand(lead);
    this.say(lead, live.line, 3.4);
    this.pushLog(roomOf(deptId).icon, this.copy.real.log(this.roomName(deptId), live.line), "mint");
    yield 2.2;
    this.sitAtDesk(lead);
  }

  /** Start a team's work without waiting for it. `skip` keeps named agents out of it. */
  private startDept(deptId: string, label: string, dur: number, skip: readonly string[] = []) {
    // A room showing its real record is never given scripted work.
    if (this.live[deptId]) return;
    this.deptStatus[deptId] = "working";
    const crew = this.deptAgents(deptId).filter((agent) => !skip.includes(agent.id));
    this.pendingWork.set(deptId, new Set(crew.map((agent) => agent.id)));
    this.lock(crew);
    this.pushLog(roomOf(deptId).icon, this.copy.sim.deptStarted(this.roomName(deptId), label), "pink");
    crew.forEach((agent, i) => {
      this.enqueue(
        agent,
        { k: "wait", dur: i * 0.35 },
        { k: "walk", to: agent.home },
        { k: "face", dir: "up" },
        { k: "status", s: "working" },
        { k: "work", dur: dur + Math.random() * 1.5, label },
        { k: "anim", a: "sit" },
        { k: "status", s: "idle" },
        {
          k: "fn",
          fn: () => {
            this.pendingWork.get(deptId)?.delete(agent.id);
            this.finishDept(deptId);
          },
        }
      );
    });
  }

  private finishDept(deptId: string) {
    // Not "nobody is typing": a teammate still walking back to a desk
    // has not started yet, and the team is not done until they have finished.
    if ((this.pendingWork.get(deptId)?.size ?? 0) > 0) return;
    if (this.deptStatus[deptId] === "done") return;
    this.deptStatus[deptId] = "done";
    this.unlock(this.deptAgents(deptId));
    const lead = this.leadOf(deptId);
    if (lead && !this.locked.has(lead.id)) this.say(lead, this.copy.sim.leadDone, 2.4);
    this.pushLog(
      roomOf(deptId).icon,
      this.copy.sim.deptDone(this.roomName(deptId), this.deptCopy(deptId).report),
      "mint"
    );
  }

  private *runDept(deptId: string, label: string, dur: number, report: string): Script {
    if (this.isLive(deptId)) {
      yield* this.announceLive(deptId);
      return;
    }
    this.startDept(deptId, label, dur);
    yield () => this.deptStatus[deptId] === "done";
    this.say(this.leadOf(deptId), report, 3.2);
    yield 1.2;
  }

  /** A meeting: call the crew in, play their lines, send them back to their desks. */
  private *meeting(title: string, ids: string[], lines: [string, string][]): Script {
    this.beginMeeting(title);
    this.pushLog("💬", this.copy.sim.meetingCalled(title, ids.length), "lav");
    const crew = ids.map((id) => this.agentById.get(id)!);
    this.lock(crew);
    crew.forEach((agent, i) => {
      this.stand(agent);
      this.say(agent, this.copy.sim.toMeeting, 2);
      const seat = this.bookSeat(agent, i);
      this.goto(agent, seat, "meeting");
      this.enqueue(
        agent,
        { k: "face", dir: seat.y < 7 ? "down" : "up" },
        { k: "anim", a: "sit" },
        { k: "status", s: "meeting" }
      );
    });
    yield this.allFree(crew);
    yield 0.6;

    for (const [id, text] of lines) {
      const speaker = this.agentById.get(id)!;
      speaker.anim = "talk";
      this.say(speaker, text, 3.2);
      this.pushLog("🗣️", this.copy.sim.quote(speaker.name, text), "lav");
      yield 2.3;
      speaker.anim = "sit";
    }

    yield 0.8;
    for (const agent of crew) {
      this.releaseSeat(agent);
      this.stand(agent);
      this.sitAtDesk(agent);
    }
    this.endMeeting(title);
    yield this.allFree(crew);
    this.unlock(crew);
  }

  /** A hand-off between teams: walk over, say it, walk back. */
  private *deliver(fromId: string, toDeptId: string, line: string, reply: string): Script {
    const from = this.agentById.get(fromId)!;
    const toLead = this.leadOf(toDeptId);
    const room = roomOf(toDeptId);
    const spot = { x: toLead.home.x, y: Math.min(toLead.home.y + 2, room.y + room.h - 2) };

    this.lock([from, toLead]);
    this.stand(from);
    this.goto(from, walkable(spot.x, spot.y) ? spot : doorApproach(room), "moving");
    yield this.allFree([from]);
    from.anim = "talk";
    this.say(from, line, 3);
    this.pushLog("🤝", this.copy.sim.delivered(from.name, this.roomName(toDeptId), line), "pink");
    yield 2;
    this.say(toLead, reply, 2.8);
    yield 1.6;
    from.anim = "idle";
    this.sitAtDesk(from);
    yield this.allFree([from]);
    this.unlock([from, toLead]);
  }

  private stand(agent: Agent) {
    agent.anim = "idle";
    agent.progress = 0;
  }

  /** Alternate the rows above and below the table, so people face each other. */
  private bookSeat(agent: Agent, preferred: number): Pt {
    const zigzag = [0, 4, 1, 5, 2, 6, 3, 7];
    const taken = new Set([...this.seatBook.values()].map((p) => `${p.x},${p.y}`));
    const order = [zigzag[preferred % zigzag.length], ...zigzag];
    for (const i of order) {
      const seat = MEETING_SEATS[i % MEETING_SEATS.length];
      if (!taken.has(`${seat.x},${seat.y}`)) {
        this.seatBook.set(agent.id, seat);
        return seat;
      }
    }
    return MEETING_SEATS[0];
  }

  private releaseSeat(agent: Agent) {
    this.seatBook.delete(agent.id);
  }

  // ── The operator console ───────────────────────────────────
  pushChat(from: "operator" | "staff", name: string, text: string) {
    // The real view has no simulated clock: a line is stamped with the time it was said.
    const time = this.demo ? this.clockText() : aestClock(new Date().toISOString());
    this.chat.push({ id: this.logSeq++, time, from, name, text });
    if (this.chat.length > 60) this.chat.shift();
  }

  /** Read one line from the console, then report or carry out the order. */
  command(raw: string) {
    const text = raw.trim();
    if (!text) return;
    this.pushChat("operator", this.operatorSeed.name, text);

    // ① A team or a person named
    const deptId = this.matchDept(text);
    // The real view answers a greeting or a thank-you; the demo keeps its own cheer.
    if (!this.demo && (ORDER.hello.test(text) || ORDER.cheer.test(text)) && !ORDER.question.test(text)) {
      this.smallTalk(ORDER.cheer.test(text) ? "thanks" : "hello", deptId && !ORDER.everyone.test(text) ? deptId : null);
      return;
    }
    if (deptId && !ORDER.everyone.test(text)) {
      this.deptReport(deptId, text);
      return;
    }

    // ② Orders that do something. They move the demo's staff, so outside
    // the demo they are declined rather than played over the real view.
    const order = [
      ORDER.focusOff,
      ORDER.focusOn,
      ORDER.recall,
      ORDER.boost,
      ORDER.convene,
      ORDER.brief,
      ORDER.approve,
      ORDER.cheer,
    ].some((pattern) => pattern.test(text));
    if (order && !this.demo && !ORDER.question.test(text)) {
      this.pushChat("staff", this.narratorName(), this.copy.sim.demoOnly);
      return;
    }
    // Orders run only in the demo. On the real view a question that names one
    // ("a meeting?") goes on to the questions below and moves nobody.
    if (this.demo) {
      if (ORDER.focusOff.test(text)) return this.setFocusMode(false);
      if (ORDER.focusOn.test(text)) return this.setFocusMode(true);
      if (ORDER.recall.test(text)) return this.recallAll();
      if (ORDER.boost.test(text)) return this.boost();
      if (ORDER.convene.test(text)) return this.convene();
      if (ORDER.brief.test(text)) return this.briefNow();
      if (ORDER.approve.test(text) && !ORDER.question.test(text) && this.approvalPending) {
        this.approve();
        this.pushChat("staff", this.narratorName(), this.copy.sim.approvedByOrder);
        return;
      }
      if (ORDER.cheer.test(text)) return this.cheer();
    }

    // ③ Questions
    if (ORDER.delay.test(text)) return this.reportDelay();
    if (ORDER.status.test(text)) return this.reportStatus();

    this.pushChat("staff", this.narratorName(), this.copy.sim.unknown);
  }

  // ── Reports ────────────────────────────────────────────────
  private reportStatus() {
    const s = this.copy.sim;
    if (!this.demo) {
      // The real view: what the live rooms read, and the counts.
      const lines: string[] = [s.statusReal];
      for (const [dept, status] of Object.entries(this.deptStatus)) {
        const live = this.live[dept];
        if (live && (status === "attention" || status === "working")) lines.push(`${this.roomName(dept)}: ${live.line}`);
      }
      const stats = this.snapshot().stats;
      lines.push(s.statusCounts(stats.done, stats.attention, stats.blocked, this.onDutyCount()));
      this.pushChat("staff", this.narratorName(), lines.join("\n"));
      return;
    }
    if (!this.running && !this.dayComplete) {
      this.pushChat("staff", this.narratorName(), s.notStarted);
      return;
    }
    // A live room's work is its record's, not a demo progress figure.
    const working = this.workingDepts().filter((dept) => !this.isLive(dept));
    const liveWorking = this.workingDepts().filter((dept) => this.isLive(dept));
    const lines: string[] = [s.statusPhase(this.clockText(), this.phaseName(this.phaseIndex))];

    if (working.length) {
      lines.push(
        s.statusWorking(
          working.map((d) => s.progressItem(this.roomName(d), this.deptProgress(d))).join(" · ")
        )
      );
    } else if (this.approvalPending) {
      lines.push(s.statusApproval);
    } else if (this.meetingTitle) {
      lines.push(s.statusMeeting(this.meetingTitle));
    } else if (liveWorking.length) {
      // Only a live room is at work: it is named below, and "all done" or
      // "a hand-off between steps" would contradict its record.
    } else if (this.dayComplete) {
      lines.push(s.statusDayDone);
    } else {
      lines.push(s.statusGap);
    }
    for (const dept of liveWorking) {
      const live = this.live[dept];
      if (live) lines.push(`${this.roomName(dept)}: ${live.line}`);
    }

    const stats = this.snapshot().stats;
    lines.push(s.statusCounts(stats.done, stats.attention, stats.blocked, this.onDutyCount()));
    const skipped = this.skippedPhases();
    let nextIndex = this.phaseIndex + 1;
    while (skipped.includes(nextIndex)) nextIndex += 1;
    const next = this.copy.phases[nextIndex];
    if (next && !this.dayComplete) lines.push(s.statusNext(next));

    this.pushChat("staff", this.narratorName(), lines.join("\n"));
    this.speakNarrator(s.reportedStatus);
  }

  private reportDelay() {
    const s = this.copy.sim;
    const lines: string[] = [];

    if (this.approvalPending) {
      const waited = Math.max(1, Math.round(this.elapsed - (this.approvalSince ?? this.elapsed)));
      lines.push(s.delayApproval(this.approverNames(), waited));
      lines.push(s.delayApprovalHint);
    }

    for (const dept of this.workingDepts()) {
      // A live room's work is its record's, not a demo task with a progress bar.
      if (this.isLive(dept)) continue;
      lines.push(s.delayWorking(this.roomName(dept), this.deptTaskLabel(dept), this.deptProgress(dept)));
    }

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
        for (const dept of blocked) {
          lines.push(`${this.roomName(dept)}: ${this.live[dept]?.line ?? this.deptCopy(dept).blockReason}`);
        }
      }
    }

    if (!lines.length) lines.push(this.running || !this.demo ? s.delayNone : s.delayNotStarted);
    this.pushChat("staff", this.narratorName(), lines.join("\n"));
    this.speakNarrator(s.reportedDelay);
  }

  private deptReport(deptId: string, question: string) {
    const s = this.copy.sim;
    const lead = this.leadOf(deptId);
    const status = this.deptStatus[deptId];
    const lines: string[] = [];
    const live = this.live[deptId];

    if (live) {
      // The lead answers in its own voice, then with the record.
      const voice = (this.copy.real.voices as Record<string, { answer: string }>)[deptId] ?? this.copy.real.voiceDefault;
      lines.push(voice.answer, this.copy.real.console(live.line), live.detail, this.copy.real.contentElsewhere);
    } else if (status === "working") {
      lines.push(s.deptWorking(this.deptTaskLabel(deptId), this.deptProgress(deptId)));
    } else if (status === "done") {
      lines.push(s.deptReportDone(this.deptCopy(deptId).report));
    } else if (status === "blocked") {
      lines.push(this.deptCopy(deptId).blockReason);
    } else if (status === "approval") {
      lines.push(s.deptApproval);
    } else {
      lines.push(s.deptWaiting(this.deptCopy(deptId).task));
    }
    lines.push(
      s.deptCrew(
        this.deptAgents(deptId)
          .map((a) => s.crewItem(a.name, this.copy.agentStatus[a.status]))
          .join(" · ")
      )
    );
    if (ORDER.late.test(question) && status === "waiting" && !live) lines.push(s.deptNotLate);

    this.pushChat("staff", s.speaker(lead.name, this.roomName(deptId)), lines.join("\n"));
    // On the real view the answer is the console's alone: nobody speaks or stirs.
    if (this.demo) {
      this.say(lead, live ? live.line : s.reportHere, 3);
      lead.anim = "talk";
    }
    this.spotlightRoom(deptId, 8);
    this.pushLog("🎤", s.deptCheckLog(this.roomName(deptId)), "yellow");
  }

  /**
   * The real view's small talk: a greeting or a thank-you is answered by the
   * leads of the rooms that read a real record (or the one named), each in
   * its own voice. The words are social, never a claim about the team's work,
   * and on the floor a lead only reacts with an emoji for a moment -- its
   * bubble otherwise stays the record's line.
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
    agent.speechKind = "talk";
    agent.speechFor = 3;
  }

  // ── Orders ─────────────────────────────────────────────────
  private setFocusMode(on: boolean) {
    const s = this.copy.sim;
    this.focusMode = on;
    if (on) {
      this.recallAll(true);
      this.pushChat("staff", this.narratorName(), s.focusOn);
      this.pushLog("🎤", s.focusOnLog, "yellow");
    } else {
      this.pushChat("staff", this.narratorName(), s.focusOff);
      this.pushLog("🎤", s.focusOffLog, "yellow");
    }
  }

  private recallAll(quiet = false) {
    const s = this.copy.sim;
    let moved = 0;
    for (const agent of this.agents) {
      if (agent.rank === "operator" || this.locked.has(agent.id) || agent.status === "offDuty") continue;
      if (Math.abs(agent.x - agent.home.x) < 0.2 && Math.abs(agent.y - agent.home.y) < 0.2) continue;
      agent.queue.length = 0;
      agent.current = null;
      this.say(agent, s.onMyWay, 2.4);
      this.sitAtDesk(agent);
      moved += 1;
    }
    if (!quiet) {
      this.pushChat("staff", this.narratorName(), moved ? s.recalled(moved) : s.recalledNone);
      this.pushLog("🎤", s.recalledLog(moved), "yellow");
    }
  }

  private boost() {
    const s = this.copy.sim;
    let count = 0;
    for (const agent of this.agents) {
      if (agent.current?.k === "work") {
        agent.current.dur = Math.max(agent.timer + 0.8, agent.current.dur * 0.55);
        this.say(agent, s.speedUp, 2.4);
        count += 1;
      }
    }
    this.speed = Math.min(4, this.speed * 2);
    this.pushChat("staff", this.narratorName(), count ? s.boosted(count, this.speed) : s.boostedIdle(this.speed));
    this.pushLog("🎤", s.boostedLog(this.speed), "yellow");
  }

  private cheer() {
    const s = this.copy.sim;
    for (const agent of this.agents) {
      if (agent.rank === "operator" || agent.status === "offDuty") continue;
      this.say(agent, rand(s.cheer), 3.2);
    }
    this.pushChat("staff", this.narratorName(), s.cheered);
    this.pushLog("🎀", s.cheeredLog, "pink");
  }

  private convene() {
    const s = this.copy.sim;
    if (this.side.gen) {
      this.pushChat("staff", this.narratorName(), s.orderBusy);
      return;
    }
    // A live room is not called in: its lead stays at the desk, and the
    // console answers about it with the record instead.
    const ids = Object.keys(this.deptStatus)
      .filter((dept) => !this.isLive(dept))
      .map((dept) => this.deptLead[dept].id)
      .filter((id) => !this.locked.has(id) && this.agentById.get(id)?.status !== "offDuty")
      .slice(0, 6);
    if (!ids.length) {
      this.pushChat("staff", this.narratorName(), s.conveneNone);
      return;
    }
    this.pushChat("staff", this.narratorName(), s.convened(ids.length));
    this.pushLog("🎤", s.convenedLog(ids.length), "yellow");
    this.spotlightRoom("decision", 24);
    this.side.gen = this.conveneScene(ids);
  }

  private *conveneScene(ids: string[]): Script {
    const s = this.copy.sim;
    const lines = ids.map((id): [string, string] => {
      const agent = this.agentById.get(id)!;
      const status = this.deptStatus[agent.deptId];
      const text =
        status === "working"
          ? s.conveneWorking(this.deptTaskLabel(agent.deptId), this.deptProgress(agent.deptId))
          : status === "done"
            ? s.conveneDone
            : status === "blocked"
              ? this.deptCopy(agent.deptId).blockReason
              : s.conveneWaiting;
      return [id, text];
    });
    yield* this.meeting(s.conveneTitle, ids, lines);
    this.pushChat("staff", this.narratorName(), s.conveneOver);
  }

  private briefNow() {
    const s = this.copy.sim;
    if (this.side.gen) {
      this.pushChat("staff", this.narratorName(), s.briefBusy);
      return;
    }
    const narrator = this.narrator();
    if (this.locked.has(narrator.id)) {
      this.pushChat("staff", this.narratorName(), s.briefLocked);
      return;
    }
    this.pushLog("🎤", s.briefNowLog, "yellow");
    this.side.gen = this.briefScene(narrator);
  }

  private *briefScene(narrator: Agent): Script {
    const s = this.copy.sim;
    this.lock([narrator]);
    this.stand(narrator);
    this.say(narrator, s.briefNowWalk, 3);
    this.goto(narrator, OPERATOR_REPORT_SPOT, "reporting");
    this.enqueue(narrator, { k: "face", dir: "up" });
    yield this.allFree([narrator]);
    narrator.anim = "talk";
    this.say(narrator, s.briefNowSay, 3);
    this.reportStatus();
    yield 3;
    narrator.anim = "idle";
    this.stand(narrator);
    this.sitAtDesk(narrator);
    yield this.allFree([narrator]);
    this.unlock([narrator]);
  }

  // ── Figures for reports ────────────────────────────────────
  private workingDepts() {
    return Object.entries(this.deptStatus)
      .filter(([, status]) => status === "working")
      .map(([dept]) => dept);
  }

  private deptProgress(deptId: string) {
    const crew = this.deptAgents(deptId).filter((a) => a.status === "working" || a.progress > 0);
    if (!crew.length) return 0;
    return Math.round((crew.reduce((sum, a) => sum + a.progress, 0) / crew.length) * 100);
  }

  private deptTaskLabel(deptId: string) {
    const crew = this.deptAgents(deptId);
    return crew.find((a) => a.status === "working")?.taskLabel ?? this.deptCopy(deptId).task;
  }

  private onDutyCount() {
    return this.agents.filter((a) => a.rank !== "operator" && a.status !== "offDuty").length;
  }

  private speakNarrator(text: string) {
    if (!this.demo) return;
    const narrator = this.agentById.get(AGENT_OFFICE_NARRATOR_ID);
    if (narrator && narrator.status !== "offDuty") this.say(narrator, text, 3);
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
      (s) =>
        lower.includes(s.name.toLowerCase()) ||
        (s.callsign !== undefined && lower.includes(s.callsign.toLowerCase()))
    );
    return person?.deptId ?? null;
  }

  // ── The operator's actions ─────────────────────────────────
  /** Advances the demo. It approves nothing outside this screen. */
  approve() {
    if (!this.approvalPending) return;
    this.approved = true;
  }

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
      // reading that only moved the read time (it lives in `detail`) is not one.
      const before = previous[deptId];
      if (lead && before && (before.status !== room.status || before.badge !== room.badge || before.line !== room.line)) {
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
    agent.speechKind = "talk";
    agent.speechFor = Number.POSITIVE_INFINITY;
  }

  /** The live reading for a room, or null for a demo room. */
  liveDept(deptId: string): AgentOfficeLiveDept | null {
    return this.live[deptId] ?? null;
  }

  setBriefingHandler(handler: (() => void) | null) {
    this.onBriefing = handler;
  }

  togglePause() {
    this.paused = !this.paused;
  }

  setSpeed(value: number) {
    this.speed = value;
    this.turbo = false;
  }

  /** Skip ahead until there is something for the operator to decide, or the day ends. */
  skipToDecision() {
    if (!this.running || this.approvalPending || this.dayComplete) return;
    this.turbo = true;
    this.paused = false;
    this.pushLog("⏭", this.isLive("engineering") ? this.copy.sim.skipLogDayEnd : this.copy.sim.skipLog, "yellow");
  }

  // ── Tick ───────────────────────────────────────────────────
  tick(rawDt: number) {
    if (this.paused) return;
    // Skipping stops by itself at a decision point or at the end of the day.
    if (this.turbo && (this.approvalPending || this.dayComplete || !this.running)) this.turbo = false;

    const raw = Math.min(rawDt, 0.05);
    const dt = raw * (this.turbo ? TURBO_SPEED : this.speed);
    if (this.running) this.clockMinutes += dt * SIM_MIN_PER_SEC;

    this.occupancy.clear();
    for (const agent of this.agents) {
      this.occupancy.add(Math.round(agent.y) * COLS + Math.round(agent.x));
    }

    for (const agent of this.agents) this.stepAgent(agent, dt);
    this.runSlot(this.main, dt);
    this.runSlot(this.side, dt);

    this.elapsed += dt;
    if (this.spotlight && this.elapsed > this.spotlightUntil) this.spotlight = null;
    if (this.approvalPending && this.approvalSince === null) this.approvalSince = this.elapsed;
    if (!this.approvalPending) this.approvalSince = null;
  }

  private runSlot(slot: Slot, dt: number) {
    if (!slot.gen) return;
    if (slot.wait > 0) {
      slot.wait -= dt;
      return;
    }
    if (slot.until) {
      if (!slot.until()) return;
      slot.until = null;
    }
    const result = slot.gen.next();
    if (result.done) {
      slot.gen = null;
      return;
    }
    if (typeof result.value === "number") slot.wait = result.value;
    else slot.until = result.value;
  }

  private stepAgent(agent: Agent, dt: number) {
    if (agent.speechFor > 0) {
      agent.speechFor -= dt;
      if (agent.speechFor <= 0) agent.speech = null;
    }
    // A live room's lead keeps its record's line on screen, demo or not: it is
    // the room's real state in words, not a scripted line.
    const recordLine = this.recordLine(agent);
    if (recordLine !== null && agent.speech === null) this.showRecordLine(agent, recordLine);

    if (!agent.current) {
      const next = agent.queue.shift();
      if (next) {
        agent.current = next;
        agent.timer = 0;
        this.beginAction(agent, next);
      } else {
        this.idleBrain(agent, dt);
        return;
      }
    }

    const action = agent.current;
    if (!action) return;
    agent.timer += dt;

    switch (action.k) {
      case "walk": {
        this.stepWalk(agent, dt);
        if (agent.pathIdx >= agent.path.length) {
          agent.path = [];
          agent.anim = "idle";
          agent.current = null;
        }
        break;
      }
      case "wait":
      case "say": {
        if (agent.timer >= action.dur) agent.current = null;
        break;
      }
      case "work": {
        agent.anim = "type";
        agent.progress = Math.min(1, agent.timer / action.dur);
        agent.taskLabel = action.label;
        if (agent.timer >= action.dur) {
          agent.progress = 1;
          agent.current = null;
        }
        break;
      }
      default:
        agent.current = null;
    }
  }

  private beginAction(agent: Agent, action: Action) {
    switch (action.k) {
      case "walk": {
        const path = findPath(
          { x: Math.round(agent.x), y: Math.round(agent.y) },
          action.to,
          this.occupancy
        );
        agent.path = path;
        agent.pathIdx = 0;
        agent.anim = path.length ? "walk" : "idle";
        if (agent.status === "idle") agent.status = "moving";
        break;
      }
      case "say":
        this.say(agent, action.text, action.dur, action.kind);
        break;
      case "face":
        agent.facing = action.dir;
        agent.current = null;
        break;
      case "anim":
        agent.anim = action.a;
        agent.current = null;
        break;
      case "status":
        agent.status = action.s;
        agent.current = null;
        break;
      case "fn":
        action.fn();
        agent.current = null;
        break;
      default:
        break;
    }
  }

  private stepWalk(agent: Agent, dt: number) {
    if (agent.pathIdx >= agent.path.length) return;
    const node = agent.path[agent.pathIdx];
    const dx = node.x - agent.x;
    const dy = node.y - agent.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.06) {
      agent.x = node.x;
      agent.y = node.y;
      agent.pathIdx += 1;
      return;
    }

    if (Math.abs(dx) > Math.abs(dy)) agent.facing = dx > 0 ? "right" : "left";
    else agent.facing = dy > 0 ? "down" : "up";

    const step = WALK_SPEED * dt;
    agent.x += (dx / dist) * Math.min(step, dist);
    agent.y += (dy / dist) * Math.min(step, dist);
    agent.anim = "walk";
  }

  /** Idle behaviour: a passing thought or a word with a teammate. */
  private idleBrain(agent: Agent, dt: number) {
    if (agent.rank === "operator" || this.locked.has(agent.id)) return;
    // The real view is still: a passing thought or a chat is the demo's.
    if (!this.demo) return;
    // A live room's staff keep to their desks and say nothing of their own:
    // beside a LIVE chip, a passing thought would read as the agent's finding.
    if (this.live[agent.deptId]) return;
    agent.idleFor -= dt;
    if (agent.idleFor > 0) return;
    agent.idleFor = 7 + Math.random() * 14;

    if (agent.status === "offDuty") return;

    const s = this.copy.sim;
    const roll = Math.random();

    if (roll < 0.5 || this.focusMode) {
      // In focus mode a thought is all there is: no chat.
      this.say(agent, rand(agent.thoughts), 3.4, "think");
      return;
    }
    if (roll < 0.82) {
      // A word with the next desk.
      const mate = this.agents.find(
        (a) =>
          a.deptId === agent.deptId &&
          a.id !== agent.id &&
          !this.busy(a) &&
          !this.locked.has(a.id) &&
          a.status !== "offDuty"
      );
      if (mate) {
        this.say(agent, rand(s.chatAsk), 3);
        this.say(mate, rand(s.chatReply), 3);
        agent.anim = "talk";
        mate.anim = "talk";
        this.enqueue(agent, { k: "wait", dur: 2.6 }, { k: "anim", a: "sit" });
        this.enqueue(mate, { k: "wait", dur: 2.6 }, { k: "anim", a: "sit" });
      }
      return;
    }
    // Back to the desk.
    if (Math.abs(agent.x - agent.home.x) > 0.1 || Math.abs(agent.y - agent.home.y) > 0.1) {
      this.sitAtDesk(agent);
    }
  }

  // ── Snapshot ───────────────────────────────────────────────
  snapshot(): Snapshot {
    const values = Object.values(this.deptStatus);
    return {
      clock: this.clockText(),
      running: this.running,
      paused: this.paused,
      speed: this.speed,
      turbo: this.turbo,
      dayComplete: this.dayComplete,
      phase:
        this.phaseIndex === PHASE.approval && this.approved
          ? this.copy.phaseApproved
          : this.phaseName(this.phaseIndex),
      phaseIndex: this.phaseIndex,
      demo: this.demo,
      skippedPhases: this.skippedPhases(),
      approvalPending: this.approvalPending,
      approved: this.approved,
      briefingReady: this.briefingReady,
      deptStatus: { ...this.deptStatus },
      stats: {
        done: values.filter((v) => v === "done").length,
        working: values.filter((v) => v === "working").length,
        approval: values.filter((v) => v === "approval").length,
        attention: values.filter((v) => v === "attention").length,
        blocked: values.filter((v) => v === "blocked").length,
      },
      log: this.log.slice(0, 24),
      meetingTitle: this.meetingTitle,
      chat: this.chat.slice(-24),
      focusMode: this.focusMode,
      spotlight: this.spotlight,
      busyWithOrder: this.side.gen !== null,
    };
  }
}
