import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { ADMIN_NAVIGATION } from "../lib/adminNavigation.ts";
import { adminAgentOfficeMessages } from "../lib/adminMessages/agentOffice.ts";
import { findPath } from "../lib/agentOffice/pathfinding.ts";
import {
  AGENT_OFFICE_BLOCKED_DEPTS,
  AGENT_OFFICE_DEPTS,
  AGENT_OFFICE_DEPT_IDS,
  AGENT_OFFICE_NARRATOR_ID,
  AGENT_OFFICE_OPERATOR,
  AGENT_OFFICE_STAFF,
  AGENT_OFFICE_TEAM_IDS,
  AGENT_OFFICE_AMUX_RECORD_HREF,
  AGENT_OFFICE_DECLARED_RECORD_HREFS,
  AGENT_OFFICE_WORKER_COLORS,
  consoleHasRecord,
} from "../lib/agentOffice/roster.ts";
import { AgentOffice, PHASE, PHASE_COUNT } from "../lib/agentOffice/sim.ts";
import {
  amuxRoomView,
  engineeringLiveDept,
  financeLiveDept,
  financeTone,
  qaLiveDept,
  qaTone,
  researchLiveDept,
  reviewRoomView,
  researchTone,
} from "../lib/agentOffice/live.ts";
import { agentOfficeAmuxState } from "../lib/agentOfficeAmuxState.ts";
import { agentOfficeEngineeringState } from "../lib/agentOfficeEngineeringState.ts";
import { agentOfficeFinanceState } from "../lib/agentOfficeFinanceState.ts";
import { agentOfficeQaState } from "../lib/agentOfficeQaState.ts";
import { agentOfficeReviewState } from "../lib/agentOfficeReviewState.ts";
import { recordReviewOrchestratorStatus } from "../lib/reviewOrchestratorStatus.ts";
import {
  REVIEW_ORCHESTRATOR_STATUS_SECRET_ENV,
  parseStoredReviewStatus,
  reviewStatusSnapshotSchema,
} from "../lib/reviewOrchestratorStatusCore.ts";
import { agentOfficeResearchState } from "../lib/agentOfficeResearchState.ts";
import {
  AMUX_ROOM,
  REVIEW_ROOM,
  DEPT_ROOMS,
  ENTRANCE,
  LOUNGE_ROOM,
  MEETING_SEATS,
  OPERATOR_REPORT_SPOT,
  OPERATOR_SEAT,
  walkable,
} from "../lib/agentOffice/world.ts";

/** The live read module's code (comments stripped), cut from one read function to the next. */
const readFunction = (name) => {
  const source = readFileSync("lib/agentOfficeLiveRead.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = source.indexOf("async function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

const reaches = (target) => {
  const path = findPath(ENTRANCE, target);
  const last = path.at(-1);
  return Boolean(last) && last.x === target.x && last.y === target.y;
};

test("the office holds the eight agent teams and the digest desk", () => {
  assert.equal(AGENT_OFFICE_TEAM_IDS.length, 8);
  assert.deepEqual(
    [...AGENT_OFFICE_TEAM_IDS].sort(),
    ["engineering", "finance", "marketing", "qa", "research", "sre", "support", "trust"]
  );
  assert.equal(DEPT_ROOMS.length, AGENT_OFFICE_DEPT_IDS.length);
  assert.ok(AGENT_OFFICE_DEPT_IDS.includes("digest"));
});

test("every desk, meeting seat and the operator's spots can be walked to from the entrance", () => {
  const targets = [
    ...DEPT_ROOMS.flatMap((room) => room.desks.map((desk) => desk.seat)),
    ...MEETING_SEATS,
    ...LOUNGE_ROOM.loiter,
    OPERATOR_REPORT_SPOT,
    OPERATOR_SEAT,
  ];
  for (const target of targets) {
    assert.ok(walkable(target.x, target.y), `${target.x},${target.y} is not walkable`);
    assert.ok(reaches(target), `${target.x},${target.y} cannot be reached from the entrance`);
  }
});

test("each room has exactly one lead and no more staff than desks", () => {
  for (const room of DEPT_ROOMS) {
    const crew = AGENT_OFFICE_STAFF.filter((staff) => staff.dept === room.id);
    assert.equal(crew.filter((staff) => staff.rank === "lead").length, 1, `${room.id} leads`);
    assert.ok(crew.length <= room.desks.length, `${room.id} has more staff than desks`);
  }
  const ids = AGENT_OFFICE_STAFF.map((staff) => staff.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate staff id");
  assert.ok(ids.includes(AGENT_OFFICE_NARRATOR_ID));
});

test("only a team with no record screen is drawn as waiting on a link", () => {
  for (const dept of AGENT_OFFICE_DEPTS) {
    assert.equal(AGENT_OFFICE_BLOCKED_DEPTS.has(dept.id), dept.recordHref === null, dept.id);
  }
});

test("every record link names a page and section the console has", () => {
  for (const dept of AGENT_OFFICE_DEPTS) {
    if (!dept.recordHref) continue;
    const [path, query] = dept.recordHref.split("?");
    const item = ADMIN_NAVIGATION.find((entry) => entry.href === path);
    assert.ok(item, `${dept.id}: ${path} is not a console page`);
    const tab = new URLSearchParams(query || "").get("tab");
    if (tab) {
      assert.ok(
        (item.tabs || []).some((entry) => entry.id === tab),
        `${dept.id}: ${path} has no ?tab=${tab}`
      );
    }
  }
});

test("a record link is kept only while the console has its page and tab", () => {
  assert.equal(consoleHasRecord("/admin/agent-digests"), true);
  assert.equal(consoleHasRecord("/admin/agent-digests?tab=qa-release"), true);
  assert.equal(consoleHasRecord("/admin/agent-digests?tab=no-such-section"), false);
  assert.equal(consoleHasRecord("/admin/no-such-page"), false);
  // The teams whose screens every branch carries stay linked; a team whose
  // screen a branch lacks is drawn as waiting on a link, never as a dead link.
  for (const id of ["engineering", "qa", "marketing", "research", "digest"]) {
    assert.ok(AGENT_OFFICE_DEPTS.find((dept) => dept.id === id)?.recordHref, `${id} lost its link`);
  }
  // Every link on screen is the declared one filtered by that predicate, and
  // every declared link is a well-formed console address. A well-formed typo
  // still reads as a screen this branch does not carry -- which is why the
  // teams every branch has are asserted linked above.
  for (const dept of AGENT_OFFICE_DEPTS) {
    const declared = AGENT_OFFICE_DECLARED_RECORD_HREFS[dept.id];
    assert.equal(dept.recordHref, declared !== null && consoleHasRecord(declared) ? declared : null, dept.id);
    if (declared !== null) assert.match(declared, /^\/admin\/[a-z0-9-]+(\?tab=[a-z0-9-]+)?$/, dept.id);
  }
  assert.equal(
    AGENT_OFFICE_AMUX_RECORD_HREF,
    consoleHasRecord("/admin/amux-execution") ? "/admin/amux-execution" : null
  );
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  assert.match(world, /isAmux && AGENT_OFFICE_AMUX_RECORD_HREF \?/);
});

test("the catalog names every room, person and phase in both languages", () => {
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.deepEqual(Object.keys(copy.depts).sort(), [...AGENT_OFFICE_DEPT_IDS].sort(), locale);
    assert.deepEqual(
      Object.keys(copy.staff).sort(),
      AGENT_OFFICE_STAFF.map((staff) => staff.id).sort(),
      locale
    );
    assert.equal(copy.phases.length, PHASE_COUNT, locale);
    for (const staff of AGENT_OFFICE_STAFF) {
      const words = copy.staff[staff.id];
      assert.ok(words.thoughts.length > 0, `${locale}/${staff.id} has no thoughts`);
      assert.equal("callsign" in words, staff.rank === "lead", `${locale}/${staff.id} callsign`);
    }
  }
});

test("the shell says it is a demo in both languages", () => {
  assert.match(adminAgentOfficeMessages.en.shell.notice, /demo scenario/);
  assert.match(adminAgentOfficeMessages.ko.shell.notice, /데모 시나리오/);
  assert.match(adminAgentOfficeMessages.en.approval.approve, /demo/);
  assert.match(adminAgentOfficeMessages.ko.approval.approve, /데모/);
});

/** Ticks the engine until `done()` holds, failing after `limit` ticks. */
const runUntil = (office, done, limit = 400000) => {
  for (let i = 0; i < limit; i += 1) {
    if (done()) return i;
    office.tick(0.05);
  }
  assert.fail("the office never reached the expected state");
};

test("the demo day stops at the operator's decision and only goes on after it", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en);
  office.speed = 10;

  office.approve();
  assert.equal(office.approved, false, "approve() before the decision point does nothing");

  office.start();
  runUntil(office, () => office.approvalPending);
  assert.equal(office.phaseIndex, PHASE.approval);
  assert.equal(office.snapshot().stats.approval, 1);

  // Without the operator nothing moves past the decision.
  for (let i = 0; i < 4000; i += 1) office.tick(0.05);
  assert.equal(office.phaseIndex, PHASE.approval);
  assert.equal(office.approvalPending, true);

  office.approve();
  runUntil(office, () => office.dayComplete);
  const snap = office.snapshot();
  assert.equal(snap.phaseIndex, PHASE.dayOver);
  assert.equal(snap.briefingReady, true);
  assert.equal(snap.stats.blocked, AGENT_OFFICE_BLOCKED_DEPTS.size);
  for (const id of AGENT_OFFICE_BLOCKED_DEPTS) {
    assert.equal(snap.deptStatus[id], "blocked", `${id} was reported as something it did not do`);
  }
  // Only the rooms the demo day gives work to finish it. A linked team the day
  // has no script for stays waiting rather than being reported as done.
  const scripted = ["qa", "research", "engineering", "marketing", "digest"];
  assert.equal(snap.stats.done, scripted.length);
  for (const id of AGENT_OFFICE_DEPT_IDS) {
    const expected = scripted.includes(id) ? "done" : AGENT_OFFICE_BLOCKED_DEPTS.has(id) ? "blocked" : "waiting";
    assert.equal(snap.deptStatus[id], expected, id);
  }
});

test("skipping ahead stops by itself at the decision", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en);
  office.start();
  office.tick(0.05);
  office.skipToDecision();
  assert.equal(office.turbo, true);
  runUntil(office, () => office.approvalPending);
  office.tick(0.05);
  assert.equal(office.turbo, false);
});

test("the console answers in the office's language and finds the team it names", () => {
  const en = new AgentOffice(adminAgentOfficeMessages.en);
  en.command("What is engineering doing?");
  const enReply = en.chat.at(-1);
  assert.equal(enReply.from, "staff");
  assert.match(enReply.name, /Jiho Han/);

  const ko = new AgentOffice(adminAgentOfficeMessages.ko);
  ko.command("엔지니어링팀 지금 뭐해?");
  assert.match(ko.chat.at(-1).name, /한지호/);

  ko.command("백실장 어디 있어?");
  assert.match(ko.chat.at(-1).name, /백서진/);

  // A finished team answers with its own report, not the feed's log line.
  en.deptStatus.qa = "done";
  en.command("What is QA doing?");
  assert.match(en.chat.at(-1).text, /^Our part is done for today\. /);
  ko.deptStatus.sre = "blocked";
  ko.command("SRE팀 왜 늦어?");
  assert.match(ko.chat.at(-1).text, /기록 화면이 없어서/);

  en.command("hello there");
  assert.equal(en.chat.at(-1).text, adminAgentOfficeMessages.en.sim.unknown);
});

test("a question that mentions approval does not give it", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.ko);
  office.speed = 10;
  office.start();
  runUntil(office, () => office.approvalPending);

  office.command("왜 아직 승인이 안 됐어?");
  office.command("Why is the approval still pending?");
  assert.equal(office.approved, false);

  office.command("승인해");
  assert.equal(office.approved, true);
});

test("a team is not done while someone it gave work to is still on the way", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en);
  const far = office.agentById.get("qa-m2");
  const spot = LOUNGE_ROOM.loiter.at(-1);
  // Everyone is at a desk except one teammate, who is across the office.
  for (const agent of office.agents) {
    if (agent.rank === "operator") continue;
    agent.x = agent.home.x;
    agent.y = agent.home.y;
    agent.status = "idle";
  }
  far.x = spot.x;
  far.y = spot.y;

  office["startDept"]("qa", "test", 0.5);
  runUntil(office, () => office.deptStatus.qa === "done", 20000);
  assert.equal(far.progress, 1, "qa was marked done before its last member finished");
});

test("ending one meeting leaves the other one on screen", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en);
  office["beginMeeting"]("the day's meeting");
  office["beginMeeting"]("the operator's call");
  assert.equal(office.meetingTitle, "the operator's call");
  office["endMeeting"]("the operator's call");
  assert.equal(office.meetingTitle, "the day's meeting");
  office["endMeeting"]("the day's meeting");
  assert.equal(office.meetingTitle, null);
});

test("the office's two sections are addresses, not component state", () => {
  const item = ADMIN_NAVIGATION.find((entry) => entry.id === "office");
  assert.deepEqual(item.tabs.map((tab) => tab.id), ["live", "dashboard"]);
  const page = readFileSync("app/(site)/(application)/admin/office/page.tsx", "utf8");
  assert.match(page, /resolveAdminTab\(TABS, query\.tab\)/);
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.match(panel, /<Link\s+href=\{viewHref\("live"\)\}/);
  assert.match(panel, /<Link\s+href=\{viewHref\("dashboard"\)\}/);
  assert.doesNotMatch(panel, /useState<View>/);
  // Both dialogs keep the shared focus contract.
  assert.equal((panel.match(/useOfficeDialog\(onClose,/g) || []).length, 2);
});

// ── Live rooms ────────────────────────────────────────────────────────────

const at = (iso) => new Date(iso);
const okRow = (slot) => ({ slot: at(slot), outcome: "ok", failureStage: null });

test("the research room's state comes from the agent's own slot and silence judgements", () => {
  assert.deepEqual(
    agentOfficeResearchState({ enabled: false, rows: [], lastSuccessAt: null, enabledSince: null, now: at("2026-10-07T22:00:00Z") }),
    { kind: "disabled" }
  );

  // 21:30 UTC is the slot; at 22:00 its window is still open.
  const ok = agentOfficeResearchState({
    enabled: true,
    rows: [okRow("2026-10-07T21:30:00Z")],
    lastSuccessAt: at("2026-10-07T21:30:00Z"),
    enabledSince: at("2026-10-01T00:00:00Z"),
    now: at("2026-10-07T22:00:00Z"),
  });
  assert.equal(ok.kind, "observed");
  assert.equal(ok.slot, "2026-10-07T21:30:00.000Z");
  assert.equal(ok.slotState, "ok");
  assert.equal(ok.windowOpen, true);
  assert.equal(ok.silence, "recent");
  assert.equal(researchTone(ok), "done");

  // An hour after the slot its window is closed; a day-old success is not yet silence.
  const late = agentOfficeResearchState({
    enabled: true,
    rows: [],
    lastSuccessAt: at("2026-10-06T21:30:00Z"),
    enabledSince: at("2026-10-01T00:00:00Z"),
    now: at("2026-10-07T23:10:00Z"),
  });
  assert.equal(late.slotState, "missing");
  assert.equal(late.windowOpen, false);
  assert.equal(late.silence, "recent");
  assert.equal(researchTone(late), "waiting");

  // Before 21:30 a moment still answers for yesterday's slot -- and by then a
  // missed run has made the agent silent (26 hours).
  const nextMorning = agentOfficeResearchState({
    enabled: true,
    rows: [],
    lastSuccessAt: at("2026-10-06T21:30:00Z"),
    enabledSince: at("2026-10-01T00:00:00Z"),
    now: at("2026-10-08T00:10:00Z"),
  });
  assert.equal(nextMorning.slot, "2026-10-07T21:30:00.000Z");
  assert.equal(nextMorning.silence, "silent");

  const silent = agentOfficeResearchState({
    enabled: true,
    rows: [],
    lastSuccessAt: at("2026-10-04T21:30:00Z"),
    enabledSince: at("2026-10-01T00:00:00Z"),
    now: at("2026-10-07T22:00:00Z"),
  });
  assert.equal(silent.silence, "silent");
  assert.equal(researchTone(silent), "attention");

  const failed = agentOfficeResearchState({
    enabled: true,
    rows: [{ slot: at("2026-10-07T21:30:00Z"), outcome: "failed", failureStage: "clone" }],
    lastSuccessAt: at("2026-10-06T21:30:00Z"),
    enabledSince: at("2026-10-01T00:00:00Z"),
    now: at("2026-10-07T21:50:00Z"),
  });
  assert.equal(failed.slotState, "failed");
  assert.equal(failed.failureStage, "clone");
  assert.equal(researchTone(failed), "attention");
});

test("a live room's line says what the record says, in UTC, and an unread record is not a state", () => {
  const copy = adminAgentOfficeMessages.ko.real.research;
  const readAt = "2026-10-07T22:05:00.000Z";
  const ok = researchLiveDept(
    {
      kind: "observed",
      slot: "2026-10-07T21:30:00.000Z",
      slotState: "ok",
      failureStage: null,
      windowOpen: true,
      lastSuccessAt: "2026-10-07T21:30:00.000Z",
      silence: "recent",
      silenceHours: 0.6,
    },
    readAt,
    copy
  );
  assert.equal(ok.status, "done");
  assert.equal(ok.line, "직전 회차 기록됨 · 10-07 21:30 UTC");
  assert.match(ok.detail, /마지막 성공 10-07 21:30 UTC/);
  assert.match(ok.detail, /읽은 시각 10-07 22:05 UTC/);

  assert.equal(ok.badge, "기록됨");

  // A read that failed needs a look; it is not "waiting on a link" and not done.
  const unread = researchLiveDept({ kind: "unread" }, readAt, copy);
  assert.equal(unread.status, "attention");
  assert.equal(unread.badge, "읽지 못함");
  assert.equal(unread.line, copy.unread);

  // A switched-off agent waits; it is not a failure.
  assert.equal(researchLiveDept({ kind: "disabled" }, readAt, copy).status, "waiting");

  // Before 21:30 UTC the slot that has passed is yesterday's, and the line
  // says which slot it means rather than calling it today's.
  const morning = researchLiveDept(
    agentOfficeResearchState({
      enabled: true,
      rows: [{ slot: at("2026-10-07T21:30:00Z"), outcome: "failed", failureStage: "clone" }],
      lastSuccessAt: at("2026-10-06T21:30:00Z"),
      enabledSince: at("2026-10-01T00:00:00Z"),
      now: at("2026-10-08T01:00:00Z"),
    }),
    "2026-10-08T01:00:00.000Z",
    copy
  );
  assert.equal(morning.line, "직전 회차 실패 · 10-07 21:30 UTC · clone");
  assert.equal(morning.badge, "실패");
  for (const locale of ["en", "ko"]) {
    const words = adminAgentOfficeMessages[locale].real.research;
    for (const value of [words.ok("x"), words.failed("x", "y"), words.duplicate("x"), words.missingOpen("x"), words.missing("x")]) {
      assert.doesNotMatch(value, /today|오늘/i, `${locale}: "${value}" calls the slot today's`);
      assert.match(value, /x/, `${locale}: "${value}" does not name its slot`);
    }
  }
});

test("a live room is never simulated: no scripted work, and its status is the record's", () => {
  const live = {
    research: {
      status: "done",
      badge: "Recorded",
      line: "Today's run recorded · 10-07 21:30 UTC",
      detail: "read 10-07 22:05 UTC",
    },
  };
  const office = new AgentOffice(adminAgentOfficeMessages.en, live);
  office.speed = 10;
  office.start();
  let worked = false;
  let meetingWithResearch = false;
  const spoken = new Set();
  const watch = () => {
    for (const agent of office.agents) {
      if (agent.deptId === "research" && agent.speech) spoken.add(agent.speech);
      if (agent.deptId === "research" && (agent.status === "working" || agent.progress > 0)) worked = true;
      if (agent.id === "research-lead" && agent.status === "meeting" && !office.approvalPending) {
        meetingWithResearch = true;
      }
    }
    return office.approvalPending;
  };
  runUntil(office, watch);
  assert.equal(office.deptStatus.research, "done");
  office.approve();
  runUntil(office, () => {
    watch();
    return office.dayComplete;
  });
  assert.equal(worked, false, "the research room was given scripted work");
  // ...and the orders that make everyone speak or move do not reach it either.
  for (let i = 0; i < 2000; i += 1) {
    office.tick(0.05);
    watch();
  }
  office.command("Thank you, everyone");
  office.command("Everyone back to your desks");
  office.command("Call a meeting with every team");
  for (let i = 0; i < 4000; i += 1) {
    office.tick(0.05);
    watch();
  }
  for (const agent of office.agents) {
    if (agent.deptId === "research") assert.notEqual(agent.status, "onBreak", agent.id);
  }
  assert.deepEqual(
    [...spoken].filter((line) => line !== live.research.line),
    [],
    "a live room's staff said something the record did not say"
  );
  assert.equal(meetingWithResearch, false, "the research lead sat in the scripted hand-off");
  assert.equal(office.deptStatus.research, "done");
  assert.ok(office.log.some((entry) => entry.text.includes("(real record): Today's run recorded")));

  // The console answers about it with the record, not with a demo line.
  office.command("What is research doing?");
  assert.match(office.chat.at(-1).text, /real record/);

  // A fresh reading moves the room and nothing else.
  const before = { ...office.deptStatus };
  office.setLive({ research: { status: "attention", badge: "Unread", line: "Could not read its record", detail: "" } });
  assert.equal(office.deptStatus.research, "attention");
  assert.equal(office.snapshot().stats.attention, 1);
  // A real record that needs a look is not a decision waiting for the operator.
  assert.equal(office.snapshot().stats.approval, 0);
  // ...and the delay report names it in its own words.
  office.command("Why is it slow?");
  assert.match(office.chat.at(-1).text, /Product research: Could not read its record/);
  for (const id of Object.keys(before)) {
    if (id !== "research") assert.equal(office.deptStatus[id], before[id], id);
  }
});

test("the office reads the research agent's state, never its content, and writes nothing", () => {
  // Code only: the module's comments name the writer it avoids.
  const source = readFileSync("lib/agentOfficeLiveRead.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(source, /^import "server-only";/m);
  // No write of any kind, and not the anchor writer the agent's own section uses.
  assert.doesNotMatch(source, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  assert.doesNotMatch(source, /\$executeRaw|\$queryRaw/);
  assert.doesNotMatch(source, /readProductResearchEnabledSince\(/);
  // The observation row is selected for its slot, outcome and failure stage only.
  assert.match(source, /select: \{ slot: true, outcome: true, failureStage: true \}/);
  assert.doesNotMatch(source, /payload: true|issueCount: true|title/);
});

// ── QA and release ────────────────────────────────────────────────────────

const qaInput = (overrides = {}) => ({
  digestSecretConfigured: true,
  control: { revision: 4, digestEnabled: true },
  latestDigestAt: at("2026-10-07T06:00:00Z"),
  mergeLaneLatched: false,
  now: at("2026-10-07T22:00:00Z"),
  ...overrides,
});

test("the QA room's verdict is the agent's own freshness judgement", () => {
  const fresh = agentOfficeQaState(qaInput());
  assert.deepEqual(fresh, {
    kind: "observed",
    verdict: "fresh",
    latestDigestAt: "2026-10-07T06:00:00.000Z",
    controlRevision: 4,
    mergeLaneLatched: false,
  });
  // 28 hours is the line, as the monitor draws it.
  const verdictAt = (iso) => agentOfficeQaState(qaInput({ now: at(iso) })).verdict;
  assert.equal(verdictAt("2026-10-08T09:59:59Z"), "fresh");
  assert.equal(verdictAt("2026-10-08T10:00:00Z"), "stale");
  // A digest dated after the clock is not healthy.
  assert.equal(verdictAt("2026-10-07T05:00:00Z"), "stale");
  // A secret and no digest ever stored: nothing to be fresh against.
  assert.equal(agentOfficeQaState(qaInput({ latestDigestAt: null })).verdict, "stale");
  // Recorded off is quiet whatever else is true.
  assert.equal(
    agentOfficeQaState(qaInput({ control: { revision: 5, digestEnabled: false }, digestSecretConfigured: false })).verdict,
    "operator_disabled"
  );
  // No secret: quiet if never recorded as on, a mismatch if it was.
  assert.equal(agentOfficeQaState(qaInput({ control: null, digestSecretConfigured: false })).verdict, "dark_not_configured");
  assert.equal(agentOfficeQaState(qaInput({ digestSecretConfigured: false })).verdict, "control_mismatch");
});

test("the QA room says whether a digest arrived, in UTC, and a latched lane needs a look", () => {
  const copy = adminAgentOfficeMessages.ko.real.qa;
  const readAt = "2026-10-07T22:05:00.000Z";
  const fresh = qaLiveDept(agentOfficeQaState(qaInput()), readAt, copy);
  assert.equal(fresh.status, "done");
  assert.equal(fresh.badge, "수신됨");
  assert.equal(fresh.line, "최근 digest 수신 · 10-07 06:00 UTC");
  assert.equal(fresh.detail, "제어 기록 4번 · 읽은 시각 10-07 22:05 UTC");

  const silent = qaLiveDept(agentOfficeQaState(qaInput({ now: at("2026-10-08T12:00:00Z") })), readAt, copy);
  assert.equal(silent.status, "attention");
  assert.equal(silent.line, "digest 침묵 · 마지막 수신 10-07 06:00 UTC");
  assert.equal(qaLiveDept(agentOfficeQaState(qaInput({ latestDigestAt: null })), readAt, copy).line, copy.staleNever);

  const latched = qaLiveDept(agentOfficeQaState(qaInput({ mergeLaneLatched: true })), readAt, copy);
  assert.equal(latched.status, "attention");
  assert.equal(latched.badge, "레인 잠김");
  assert.match(latched.detail, /병합 레인 잠김/);

  const mismatch = qaLiveDept(agentOfficeQaState(qaInput({ digestSecretConfigured: false })), readAt, copy);
  assert.equal(mismatch.status, "attention");
  assert.equal(mismatch.line, copy.mismatch);

  // Switched off, or never configured here: waiting, not a failure.
  const off = agentOfficeQaState(qaInput({ control: { revision: 5, digestEnabled: false } }));
  assert.equal(qaTone(off), "waiting");
  assert.equal(qaLiveDept(off, readAt, copy).line, copy.disabled);
  // A digest stored before it was switched off is still named.
  assert.equal(qaLiveDept(off, readAt, copy).detail, "제어 기록 5번 · 마지막 digest 10-07 06:00 UTC · 읽은 시각 10-07 22:05 UTC");
  assert.match(mismatch.detail, /마지막 digest 10-07 06:00 UTC/);
  const dark = agentOfficeQaState(qaInput({ control: null, digestSecretConfigured: false, latestDigestAt: null }));
  assert.equal(qaTone(dark), "waiting");
  assert.equal(qaLiveDept(dark, readAt, copy).detail, "제어 기록 없음 · 읽은 시각 10-07 22:05 UTC");

  // A read that failed is not a state.
  const unread = qaLiveDept({ kind: "unread" }, readAt, copy);
  assert.equal(unread.status, "attention");
  assert.equal(unread.badge, "읽지 못함");

  for (const locale of ["en", "ko"]) {
    const words = adminAgentOfficeMessages[locale].real.qa;
    assert.match(words.fresh("x"), /x/);
    assert.match(words.stale("x"), /x/);
    // The room says nothing about what a digest contains.
    for (const value of Object.values(words).filter((v) => typeof v === "string")) {
      assert.doesNotMatch(value, /pass|fail|gate|통과|실패|게이트/i, `${locale}: "${value}"`);
    }
  }
});

test("with research and QA both live the demo day still reaches its end, and QA is never handed work", () => {
  const live = {
    research: { status: "done", badge: "Recorded", line: "Latest run recorded · 10-07 21:30 UTC", detail: "" },
    qa: { status: "attention", badge: "Silent", line: "Digest silent · last received 10-06 06:00 UTC", detail: "" },
  };
  const office = new AgentOffice(adminAgentOfficeMessages.en, live);
  office.speed = 10;
  office.start();
  let qaWorked = false;
  let qaInMeeting = false;
  const spoken = new Set();
  const watch = () => {
    for (const agent of office.agents) {
      if (agent.deptId !== "qa") continue;
      if (agent.speech) spoken.add(agent.speech);
      if (agent.status === "working" || agent.progress > 0) qaWorked = true;
      if (agent.status === "meeting") qaInMeeting = true;
    }
  };
  runUntil(office, () => {
    watch();
    return office.approvalPending;
  });
  // The approval card names only the people who are actually in the room.
  assert.ok(!office.approverNames().includes(office.deptLead.qa.name));
  assert.ok(office.approverNames().includes(office.deptLead.engineering.name));
  office.approve();
  runUntil(office, () => {
    watch();
    return office.dayComplete;
  });
  // QA's lead is second in room order, so a meeting the operator calls would
  // reach it first if live rooms were not left out.
  office.command("Call a meeting with every team");
  for (let i = 0; i < 4000; i += 1) {
    office.tick(0.05);
    watch();
  }
  assert.ok(office.log.some((entry) => entry.text.startsWith("Operator order: urgent meeting")), "the meeting was not called");
  assert.equal(qaWorked, false, "the QA room was given scripted work");
  assert.equal(qaInMeeting, false, "the QA lead sat in a meeting");
  assert.deepEqual([...spoken].filter((line) => line !== live.qa.line), []);
  assert.equal(office.deptStatus.qa, "attention");
  assert.ok(office.log.some((entry) => entry.text.includes("(real record): Digest silent")));
  // The PR log no longer claims QA classified CI.
  for (const locale of ["en", "ko"]) {
    assert.doesNotMatch(adminAgentOfficeMessages[locale].sim.prLog, /CI/);
  }
});

test("the office reads the QA agent's state, never a digest's content", () => {
  const qa = readFunction("readQa");
  // The digest row is read for when it was stored, nothing else.
  assert.match(qa, /agentDigestItem\.findFirst\(\{[\s\S]*?select: \{ createdAt: true \}/);
  assert.doesNotMatch(qa, /payload|sizeBytes|kind: true|idempotencyKey/);
  assert.match(qa, /select: \{ revision: true, digestEnabled: true \}/);
  assert.match(qa, /select: \{ latched: true \}/);
  assert.doesNotMatch(qa, /reason: true|attemptId: true/);
  // The secret is seen only as a length, never passed on.
  assert.match(qa, /\(process\.env\[QA_RELEASE_ROUTE_SECRET_ENV\.digest\] \?\? ""\)\.length >= 32/);
  assert.equal((qa.match(/process\.env/g) || []).length, 1);
  assert.match(qa, /read: "qa_release"/);
  // The verdict's clock is taken after the reads, not handed in before them.
  assert.match(qa, /async function readQa\(\)/);
  assert.ok(qa.indexOf("now: new Date()") > qa.indexOf("await Promise.all"));
});

// ── Engineering ───────────────────────────────────────────────────────────

const engInput = (overrides = {}) => ({
  settings: [
    { key: "feature.engineeringAgentMode", value: "t1" },
    { key: "engineeringAgent.runnerLastFinishAt", value: "2026-10-07T21:40:00.000Z" },
  ],
  killSwitch: undefined,
  halt: "none",
  openOwnerItems: [],
  active: { count: 0, since: null },
  lastRun: {
    status: "finished",
    outcome: "private_result",
    startedAt: at("2026-10-07T21:00:00Z"),
    endedAt: at("2026-10-07T21:30:00Z"),
  },
  ...overrides,
});

test("the engineering room reads the mode the agent acts on, through its own switch resolution", () => {
  const clear = agentOfficeEngineeringState(engInput());
  assert.deepEqual(clear, {
    kind: "observed",
    mode: "t1",
    frozen: false,
    killSwitch: false,
    halt: "none",
    pending: { t2Draft: 0, decision: 0, stateMismatch: 0 },
    activeRuns: 0,
    activeSince: null,
    lastRun: {
      status: "finished",
      outcome: "private_result",
      startedAt: "2026-10-07T21:00:00.000Z",
      endedAt: "2026-10-07T21:30:00.000Z",
      needsLook: false,
    },
    runnerLastFinishAt: "2026-10-07T21:40:00.000Z",
    publisherLastFinishAt: null,
  });
  // An engaged kill switch is off whatever the mode setting says.
  const killed = agentOfficeEngineeringState(engInput({ killSwitch: "1" }));
  assert.equal(killed.mode, "off");
  assert.equal(killed.killSwitch, true);
  assert.equal(agentOfficeEngineeringState(engInput({ killSwitch: "false" })).killSwitch, false);
  // Unset or unknown is off.
  assert.equal(agentOfficeEngineeringState(engInput({ settings: [] })).mode, "off");
  assert.equal(
    agentOfficeEngineeringState(engInput({ settings: [{ key: "feature.engineeringAgentMode", value: "on" }] })).mode,
    "off"
  );
  assert.equal(
    agentOfficeEngineeringState(
      engInput({
        settings: [
          { key: "feature.engineeringAgentMode", value: "shadow" },
          { key: "feature.engineeringAgentFreeze", value: "true" },
        ],
      })
    ).frozen,
    true
  );
  // An instant not in the agent's own stored form is no record.
  assert.equal(
    agentOfficeEngineeringState(
      engInput({ settings: [{ key: "engineeringAgent.publisherLastFinishAt", value: "yesterday" }] })
    ).publisherLastFinishAt,
    null
  );
  assert.deepEqual(
    agentOfficeEngineeringState(
      engInput({ openOwnerItems: [{ kind: "t2_draft", count: 1 }, { kind: "state_mismatch", count: 2 }] })
    ).pending,
    { t2Draft: 1, decision: 0, stateMismatch: 2 }
  );
});

test("whether the latest run needs a look is the agent's own settlement of its outcome", () => {
  const needsLook = (outcome, status = "finished") =>
    agentOfficeEngineeringState(
      engInput({ lastRun: { status, outcome, startedAt: at("2026-10-07T21:00:00Z"), endedAt: at("2026-10-07T21:30:00Z") } })
    ).lastRun.needsLook;
  // Settled for review: a result went to a person.
  for (const outcome of ["t1_queued", "t2_draft", "private_result"]) assert.equal(needsLook(outcome), false, outcome);
  // Retried, blocked or recovered by AMUX: no result went to a person.
  for (const outcome of ["no_change", "agent_failed", "schema_invalid", "scope_violation", "secret_detected"]) {
    assert.equal(needsLook(outcome), true, outcome);
  }
  assert.equal(needsLook("abandoned", "abandoned"), true);
  // An outcome the table does not know, or none at all, is not a clean run.
  assert.equal(needsLook("something_new"), true);
  assert.equal(needsLook(null), true);
  assert.equal(needsLook("toString"), true, "an inherited property is not an outcome");
});

test("the engineering room says how the agent stands: halts and decisions first, then switches, then runs", () => {
  const copy = adminAgentOfficeMessages.ko.real.engineering;
  const readAt = "2026-10-07T22:05:00.000Z";
  const room = (overrides) => engineeringLiveDept(agentOfficeEngineeringState(engInput(overrides)), readAt, copy);

  const clear = room({});
  assert.equal(clear.status, "done");
  assert.equal(clear.badge, "이상 없음");
  assert.equal(clear.line, "직전 회차 private_result · 10-07 21:30 UTC");
  assert.equal(
    clear.detail,
    "모드 t1 · 실행기 마지막 완료 10-07 21:40 UTC · 게시기 완료 기록 없음 · 읽은 시각 10-07 22:05 UTC"
  );

  // A failed latest run is not clear, whatever its line says.
  const failed = room({
    lastRun: { status: "finished", outcome: "agent_failed", startedAt: at("2026-10-07T21:00:00Z"), endedAt: at("2026-10-07T21:30:00Z") },
  });
  assert.equal(failed.status, "attention");
  assert.equal(failed.badge, "확인 필요");
  assert.equal(failed.line, "직전 회차 agent_failed · 10-07 21:30 UTC");

  const halted = room({ halt: "circuit_open", killSwitch: "1" });
  assert.equal(halted.status, "attention", "a halt needs a look even while the agent is switched off");
  assert.equal(halted.line, "정지: 반복 실패로 차단기 열림");
  assert.match(halted.detail, /직전 회차 private_result · 10-07 21:30 UTC/);

  const deciding = room({ openOwnerItems: [{ kind: "t2_draft", count: 1 }, { kind: "decision", count: 1 }] });
  assert.equal(deciding.status, "attention");
  assert.equal(deciding.badge, "결정 대기");
  assert.equal(deciding.line, "결정 대기 2건");
  assert.match(deciding.detail, /T2 초안 1 · 결정 1 · 불일치 0/);

  assert.equal(room({ killSwitch: "1" }).status, "waiting");
  assert.equal(room({ killSwitch: "1" }).line, copy.killSwitch);
  assert.equal(room({ settings: [] }).line, copy.off);
  const frozen = room({
    settings: [
      { key: "feature.engineeringAgentMode", value: "t1" },
      { key: "feature.engineeringAgentFreeze", value: "true" },
    ],
  });
  assert.equal(frozen.status, "waiting");
  assert.equal(frozen.line, copy.frozen);

  // A run in progress is named by its own start, and the run that ended
  // later -- possible with two runs at once -- keeps its own outcome.
  const running = room({ active: { count: 1, since: at("2026-10-07T20:00:00Z") } });
  assert.equal(running.status, "working");
  assert.equal(running.line, "작업 중 · 10-07 20:00 UTC 시작");
  assert.match(running.detail, /직전 회차 private_result · 10-07 21:30 UTC/);
  assert.doesNotMatch(running.detail, /작업 중/, "the runs in progress are named once");
  // Runs in progress stay on screen when a failed run, a halt or a decision takes the line.
  const failedWhileRunning = room({
    active: { count: 2, since: at("2026-10-07T20:00:00Z") },
    lastRun: { status: "finished", outcome: "agent_failed", startedAt: at("2026-10-07T21:00:00Z"), endedAt: at("2026-10-07T21:30:00Z") },
  });
  assert.equal(failedWhileRunning.status, "attention");
  assert.equal(failedWhileRunning.line, "직전 회차 agent_failed · 10-07 21:30 UTC");
  assert.match(failedWhileRunning.detail, /작업 중 2건 · 가장 이른 시작 10-07 20:00 UTC/);
  assert.match(
    room({ halt: "state_mismatch", active: { count: 1, since: at("2026-10-07T20:00:00Z") } }).detail,
    /작업 중 · 10-07 20:00 UTC 시작/
  );
  assert.match(
    room({ openOwnerItems: [{ kind: "decision", count: 1 }], active: { count: 1, since: at("2026-10-07T20:00:00Z") } }).detail,
    /작업 중 · 10-07 20:00 UTC 시작/
  );
  const two = room({ active: { count: 2, since: at("2026-10-07T20:00:00Z") } });
  assert.equal(two.line, "작업 중 2건 · 가장 이른 시작 10-07 20:00 UTC");

  const fresh = room({ lastRun: null });
  assert.equal(fresh.status, "waiting");
  assert.equal(fresh.line, copy.noRun);

  const unread = engineeringLiveDept({ kind: "unread" }, readAt, copy);
  assert.equal(unread.status, "attention");
  assert.equal(unread.badge, "읽지 못함");

  // Every halt the agent can report has words in both languages.
  for (const locale of ["en", "ko"]) {
    const words = adminAgentOfficeMessages[locale].real.engineering;
    for (const halt of ["config_missing", "circuit_open", "unbound_app_pr", "unbound_app_ref", "state_mismatch"]) {
      assert.ok(words.halts[halt], `${locale}: ${halt}`);
    }
  }
});

test("with engineering live the demo plays no decision, and the day still reaches its end", () => {
  const line = (text) => ({ status: "done", badge: "", line: text, detail: "" });
  const live = {
    research: line("Latest run recorded · 10-07 21:30 UTC"),
    qa: line("Latest digest received · 10-07 06:00 UTC"),
    engineering: { status: "attention", badge: "Decisions waiting", line: "2 decisions waiting for you", detail: "" },
  };
  const office = new AgentOffice(adminAgentOfficeMessages.en, live);
  const skipped = [PHASE.draftSummary, PHASE.approval, PHASE.prPrep];
  assert.deepEqual(office.snapshot().skippedPhases, skipped);
  office.speed = 10;
  office.start();
  let everPending = false;
  let engineeringMoved = false;
  let handoverHeld = false;
  let askedAtEngineering = false;
  const spokenByNarrator = new Set();
  const narrator = office.agents.find((agent) => agent.id === AGENT_OFFICE_NARRATOR_ID);
  const watch = () => {
    if (office.approvalPending) everPending = true;
    if (narrator.speech) spokenByNarrator.add(narrator.speech);
    if (office.snapshot().meetingTitle === adminAgentOfficeMessages.en.sim.handoverTitle) handoverHeld = true;
    for (const agent of office.agents) {
      if (agent.deptId !== "engineering") continue;
      if (agent.status === "working" || agent.status === "meeting" || agent.progress > 0) engineeringMoved = true;
    }
    // The status report names the next phase that will actually play.
    if (!askedAtEngineering && office.phaseIndex === PHASE.engineering) {
      askedAtEngineering = true;
      office.command("Status?");
      const answer = office.chat.at(-1).text;
      assert.ok(answer.includes(adminAgentOfficeMessages.en.phases[PHASE.marketing]), answer);
      assert.ok(!answer.includes(adminAgentOfficeMessages.en.phases[PHASE.draftSummary]), answer);
    }
  };
  runUntil(office, () => {
    watch();
    return office.dayComplete;
  });
  assert.ok(askedAtEngineering, "the day never reached the engineering phase");
  assert.equal(everPending, false, "the demo asked the operator to approve something");
  assert.equal(office.approved, false);
  assert.equal(engineeringMoved, false, "the engineering room was given demo work or a meeting seat");
  // The real record keeps its own status; the demo never set it to approval or done.
  assert.equal(office.deptStatus.engineering, "attention");
  assert.ok(office.log.some((entry) => entry.text.includes("(real record): 2 decisions waiting for you")));
  assert.equal(handoverHeld, false, "a hand-off meeting was held with nobody to hand over");
  // The narrator does not claim there is nothing to decide; it says where the decisions are.
  assert.ok(spokenByNarrator.has(adminAgentOfficeMessages.en.sim.briefSayLive), [...spokenByNarrator].join(" | "));
  assert.ok(!spokenByNarrator.has(adminAgentOfficeMessages.en.sim.briefSay));
  // approve() outside a decision does nothing.
  office.approve();
  assert.equal(office.approved, false);
  // Without a live engineering room nothing is skipped.
  assert.deepEqual(new AgentOffice(adminAgentOfficeMessages.en).snapshot().skippedPhases, []);
});

test("a live room at work is named by its record, not by a demo progress figure", () => {
  // As in the real office: research, QA and engineering all read their records.
  const line = (text) => ({ status: "done", badge: "", line: text, detail: "" });
  const office = new AgentOffice(adminAgentOfficeMessages.en, {
    research: line("Latest run recorded"),
    qa: line("Latest digest received"),
    engineering: { status: "working", badge: "Running", line: "Run in progress · started 10-07 20:00 UTC", detail: "" },
  });
  const s = adminAgentOfficeMessages.en.sim;
  office.speed = 10;
  office.start();
  runUntil(office, () => office.phaseIndex >= PHASE.research);
  office.command("Status?");
  let status = office.chat.at(-1).text;
  assert.match(status, /Engineering: Run in progress · started 10-07 20:00 UTC/);
  assert.doesNotMatch(status, /Engineering 0%/);
  assert.ok(!status.includes(s.statusGap), status);
  office.command("Why is it slow?");
  assert.match(office.chat.at(-1).text, /Engineering: Run in progress/);
  // At the end of the demo day a real run in progress is not "all done".
  runUntil(office, () => office.dayComplete);
  office.command("Status?");
  status = office.chat.at(-1).text;
  assert.ok(!status.includes(s.statusDayDone), status);
  assert.match(status, /Engineering: Run in progress/);
  // With no live room at work the demo's own summaries still apply.
  const plain = new AgentOffice(adminAgentOfficeMessages.en);
  plain.speed = 10;
  plain.start();
  runUntil(plain, () => plain.approvalPending);
  plain.approve();
  runUntil(plain, () => plain.dayComplete);
  plain.command("Status?");
  assert.ok(plain.chat.at(-1).text.includes(s.statusDayDone));
});

test("the office reads the engineering agent's state, never what it worked on", () => {
  const engineering = readFunction("readEngineering");
  // The agent's own halt verdict, not a restatement of it.
  assert.match(engineering, /halt: currentEngineeringAgentHalt\(haltState\)/);
  assert.match(engineering, /readEngineeringAgentHaltState\(prisma\)/);
  // Ended runs by their end, for their enums and times; owner items only counted.
  assert.match(engineering, /where: \{ status: \{ in: \["finished", "abandoned"\] \}, endedAt: \{ not: null \} \}/);
  assert.match(engineering, /orderBy: \[\{ endedAt: "desc" \}, \{ id: "desc" \}\]/);
  assert.match(engineering, /select: \{ status: true, outcome: true, startedAt: true, endedAt: true \}/);
  assert.doesNotMatch(engineering, /patchBody|patchDigest|reason|causeKey|cardId|baseSha|findMany\(\{\s*where: \{ kind/);
  // The kill switch is passed on raw and kept only as engaged or not.
  assert.equal((engineering.match(/process\.env/g) || []).length, 1);
  assert.match(engineering, /process\.env\[ENGINEERING_AGENT_KILL_SWITCH_ENV\]/);
  assert.match(readFileSync("lib/agentOfficeEngineeringState.ts", "utf8"), /killSwitch: killSwitchEngaged\(input\.killSwitch\)/);
  assert.match(engineering, /read: "engineering"/);

  // While engineering is live every decision surface points at its own screen
  // and none offers an approve button.
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.equal((panel.match(/<LiveDecisionNote m=\{m\} \/>/g) || []).length, 2);
  const note = panel.slice(panel.indexOf("function LiveDecisionNote"), panel.indexOf("function LiveView"));
  assert.doesNotMatch(note, /onApprove|approve-button/);
  const briefing = panel.slice(panel.indexOf("function BriefingModal"), panel.indexOf("function DashboardView"));
  assert.match(briefing, /engineeringLive \? m\.dashboard\.decisionLive : m\.briefing\.decisionNone/);
  // No copy shown while engineering is live claims there is nothing to decide.
  for (const locale of ["en", "ko"]) {
    const c = adminAgentOfficeMessages[locale];
    for (const value of [
      c.sim.briefSayLive,
      c.sim.skipLogDayEnd,
      c.dashboard.decisionLive,
      c.approval.liveTitle,
      c.approval.liveBody,
    ]) {
      assert.doesNotMatch(
        value,
        /nothing (left )?to decide|nothing comes to you|결정할 (건|일이?) (이제 )?(없|올라오지)/,
        `${locale}: ${value}`
      );
    }
  }
});

// ── AMUX execution room ───────────────────────────────────────────────────

const catalogRow = (name, overrides = {}) => ({
  worker_name: name,
  provider: "anthropic",
  archived: false,
  paused: false,
  isolated: false,
  blocked: false,
  ...overrides,
});
const runtimeRow = (name, overrides = {}) => ({
  workerName: name,
  status: "idle",
  dispatchReady: true,
  heartbeatAt: at("2026-10-07T22:04:30Z"),
  leaseExpiresAt: at("2026-10-07T22:06:00Z"),
  ...overrides,
});
const amuxNow = at("2026-10-07T22:05:00Z");

test("the AMUX room sits under the teams, with a desk for every worker and a way in from the lobby", () => {
  assert.ok(AMUX_ROOM.desks.length >= 8, "fewer desks than the catalog's workers");
  assert.ok(AMUX_ROOM.y > DEPT_ROOMS.reduce((bottom, room) => Math.max(bottom, room.y + room.h), 0));
  for (const desk of AMUX_ROOM.desks) assert.ok(reaches(desk.seat), `AMUX seat ${desk.seat.x},${desk.seat.y}`);
  for (const door of AMUX_ROOM.doors) assert.ok(walkable(door.x, door.y), "the AMUX room's door is walled in");
  // The entrance is in the lobby, not in the AMUX room.
  assert.ok(ENTRANCE.x >= AMUX_ROOM.x + AMUX_ROOM.w, "the entrance opens into the AMUX room");
});

test("each AMUX worker's state is its catalog row read against its runtime the way AMUX reads it", () => {
  const state = (catalog, runtime, now = amuxNow) =>
    agentOfficeAmuxState({ catalog: [catalog], runtimes: runtime ? [runtime] : [], now }).workers[0].state;
  const w = (overrides) => catalogRow("w1", overrides);
  const r = (overrides) => runtimeRow("w1", overrides);
  assert.equal(state(w(), r()), "ready");
  assert.equal(state(w(), r({ dispatchReady: false })), "idle");
  assert.equal(state(w(), r({ status: "busy", dispatchReady: false })), "busy");
  assert.equal(state(w(), r({ status: "starting" })), "starting");
  assert.equal(state(w(), r({ status: "error" })), "error");
  assert.equal(state(w(), r({ status: "stopped" })), "stopped");
  assert.equal(state(w(), r({ status: "something_new" })), "error", "an unknown runtime status is not healthy");
  assert.equal(state(w(), null), "not_running");
  // A lease that has run out is a lost heartbeat, whatever the status said.
  assert.equal(state(w(), r({ status: "busy", leaseExpiresAt: amuxNow })), "lost");
  // The operator's exclusions win, as they do when AMUX hands out work.
  assert.equal(state(w({ paused: true }), r({ status: "busy" })), "paused");
  assert.equal(state(w({ isolated: true }), r()), "isolated");
  assert.equal(state(w({ blocked: true, paused: true }), r()), "blocked");

  const observed = agentOfficeAmuxState({
    catalog: [catalogRow("b"), catalogRow("old", { archived: true }), catalogRow("a")],
    runtimes: [runtimeRow("a"), runtimeRow("old")],
    now: amuxNow,
  });
  assert.deepEqual(
    observed.workers.map((worker) => [worker.name, worker.state, worker.heartbeatAt]),
    [
      ["b", "not_running", null],
      ["a", "ready", "2026-10-07T22:04:30.000Z"],
    ],
    "an archived worker is left out and catalog order is kept"
  );
  assert.deepEqual(agentOfficeAmuxState({ catalog: null, runtimes: [], now: amuxNow }), { kind: "no_catalog" });
});

test("the AMUX room's colour and summary come from its workers, and a missing record is not a state", () => {
  const copy = adminAgentOfficeMessages.ko.real.amux;
  const readAt = "2026-10-07T22:05:00.000Z";
  const view = (workers, desks = 12) =>
    amuxRoomView({ kind: "observed", workers }, readAt, desks, copy);
  const worker = (name, state) => ({ name, provider: "openai", state, heartbeatAt: "2026-10-07T22:04:30.000Z" });

  const mixed = view([worker("a", "ready"), worker("b", "busy"), worker("c", "lost"), worker("d", "stopped")]);
  assert.equal(mixed.status, "attention");
  assert.equal(mixed.summary, "연결 2/4 · 작업 중 1 · 확인 필요 1 · 읽은 시각 10-07 22:05 UTC");
  assert.deepEqual(
    mixed.workers.map((w) => [w.name, w.status, w.label, w.dim]),
    [
      ["a", "done", "배정 가능", false],
      ["b", "working", "작업 중", false],
      ["c", "attention", "연결 끊김", false],
      ["d", "waiting", "정지", true],
    ]
  );
  assert.equal(mixed.workers[0].title, "a · openai · 배정 가능 · 마지막 heartbeat 10-07 22:04 UTC");
  assert.equal(view([worker("a", "busy"), worker("b", "ready")]).status, "working");
  assert.equal(view([worker("a", "ready")]).status, "done");
  assert.equal(view([worker("a", "paused"), worker("b", "not_running")]).status, "waiting");
  assert.equal(view([]).status, "waiting");
  assert.equal(mixed.note, null);
  // When they do not all fit, the ones that need a look are drawn, and the
  // room says in words how many are not.
  const crowded = view([worker("a", "ready"), worker("b", "busy"), worker("c", "error")], 1);
  assert.equal(crowded.workers[0].name, "c");
  assert.equal(crowded.note, "여기 그리지 못한 worker 2개");
  assert.match(crowded.summary, /여기 그리지 못한 worker 2개/);
  // It says the workers are not drawn, not where else they are: one not
  // running has no runtime row for any other screen to list.
  for (const locale of ["en", "ko"]) {
    assert.doesNotMatch(adminAgentOfficeMessages[locale].real.amux.more(2), /page|화면/);
  }
  assert.equal(adminAgentOfficeMessages.en.real.amux.more(1), "1 more worker not drawn here");
  assert.equal(adminAgentOfficeMessages.en.real.amux.more(3), "3 more workers not drawn here");
  assert.equal(view([]).note, copy.noWorkers);

  const unread = amuxRoomView({ kind: "unread" }, readAt, 12, copy);
  assert.equal(unread.status, "attention");
  assert.deepEqual(unread.workers, []);
  assert.match(unread.summary, /worker 기록을 읽지 못함/);
  assert.equal(unread.note, copy.unread, "a failed read is said in the room, not only in a tooltip");
  const none = amuxRoomView({ kind: "no_catalog" }, readAt, 12, copy);
  assert.equal(none.status, "waiting");
  assert.match(none.summary, /카탈로그가 없음/);
  assert.equal(none.note, copy.noCatalog);

  for (const locale of ["en", "ko"]) {
    const states = adminAgentOfficeMessages[locale].real.amux.states;
    for (const key of ["ready", "idle", "busy", "starting", "error", "lost", "stopped", "not_running", "paused", "isolated", "blocked"]) {
      assert.ok(states[key], `${locale}: ${key}`);
    }
  }
});

test("the office reads AMUX workers' runtime state, never their work, and draws them outside the demo", () => {
  const amux = readFunction("readAmuxWorkers");
  assert.match(amux, /getConfiguredAmuxWorkerCatalog\(\)/);
  assert.match(
    amux,
    /select: \{ workerName: true, status: true, dispatchReady: true, heartbeatAt: true, leaseExpiresAt: true \}/
  );
  assert.doesNotMatch(amux, /amuxWorkItem|amuxExecutionAttempt|amuxRouteDecision|title|process\.env/);
  assert.ok(
    amux.indexOf("now: new Date()") > amux.indexOf("await prisma"),
    "the lease must be judged against a clock taken after the read"
  );
  assert.match(amux, /read: "amux_workers"/);

  // Workers are drawn by their own layer: not engine agents, so the demo can
  // neither move them nor give them a line.
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  const layer = world.slice(world.indexOf("const SeatedLayer"), world.indexOf("const PropLayer"));
  assert.doesNotMatch(layer, /onPointerUp|onPick|engine/);
  assert.match(world, /<SeatedLayer room=\{AMUX_ROOM\} people=\{amux\.workers\} \/>/);
  assert.match(world, /\{real\?\.note \? \(/);
  assert.ok(!AGENT_OFFICE_STAFF.some((staff) => staff.dept === "amux"));
});

// ── Billing and finance ───────────────────────────────────────────────────

const financeControl = (state, overrides = {}) =>
  state === "unreadable"
    ? { state }
    : {
        state,
        control: {
          enabled: state === "enabled",
          revision: 3,
          enabledAt: state === "enabled" ? "2026-10-01T00:00:00.000Z" : null,
          ...overrides,
        },
      };
const financeInput = (overrides = {}) => ({
  environment: "production",
  control: financeControl("enabled"),
  recordedToday: true,
  latestDigestAt: at("2026-10-08T01:00:12Z"),
  now: at("2026-10-08T08:00:00Z"),
  ...overrides,
});

test("the billing and finance room's verdict is the agent's own silence judgement", () => {
  const verdict = (overrides) => agentOfficeFinanceState(financeInput(overrides)).verdict;
  assert.deepEqual(agentOfficeFinanceState(financeInput()), {
    kind: "observed",
    verdict: "recorded",
    controlRevision: 3,
    enabledAt: "2026-10-01T00:00:00.000Z",
    latestDigestAt: "2026-10-08T01:00:12.000Z",
  });
  assert.equal(verdict({ recordedToday: false }), "silent");
  // The day's slot is 01:00 UTC with an hour's grace.
  assert.equal(verdict({ recordedToday: false, now: at("2026-10-08T01:59:59Z") }), "not_due");
  // Turned on after today's slot: the first run is tomorrow's.
  assert.equal(
    verdict({ recordedToday: false, control: financeControl("enabled", { enabledAt: "2026-10-08T03:00:00.000Z" }) }),
    "not_due"
  );
  assert.equal(verdict({ control: financeControl("disabled") }), "off");
  // An unreadable switch row is never folded into "off".
  assert.equal(verdict({ control: financeControl("unreadable") }), "control_unreadable");
  assert.equal(agentOfficeFinanceState(financeInput({ control: financeControl("unreadable") })).controlRevision, null);
  assert.equal(verdict({ environment: "development" }), "not_applicable");
});

test("the billing and finance room says whether today's digest arrived, never what it held", () => {
  const copy = adminAgentOfficeMessages.ko.real.finance;
  const readAt = "2026-10-08T08:05:00.000Z";
  const room = (overrides) => financeLiveDept(agentOfficeFinanceState(financeInput(overrides)), readAt, copy);

  const recorded = room({});
  assert.equal(recorded.status, "done");
  assert.equal(recorded.badge, "기록됨");
  assert.equal(recorded.line, "오늘 기한 digest 기록됨 · 10-08 01:00 UTC");
  assert.equal(recorded.detail, "스위치 기록 3번 · 켜진 시각 10-01 00:00 UTC · 읽은 시각 10-08 08:05 UTC");

  const silent = room({ recordedToday: false, latestDigestAt: at("2026-10-07T01:00:09Z") });
  assert.equal(silent.status, "attention");
  assert.equal(silent.line, "오늘 digest 없음 · 마지막 기록 10-07 01:00 UTC");
  assert.equal(room({ recordedToday: false, latestDigestAt: null }).line, copy.silentNever);

  // Not due covers the grace hour and a switch turned on after today's slot.
  assert.equal(room({ recordedToday: false, now: at("2026-10-08T01:30:00Z") }).line, copy.notDue);
  assert.equal(room({ recordedToday: false, now: at("2026-10-08T01:30:00Z") }).status, "waiting");
  // Recorded stays recorded even when the newest digest's time was not read with it.
  const untimed = financeLiveDept(
    { kind: "observed", verdict: "recorded", controlRevision: 3, enabledAt: null, latestDigestAt: null },
    readAt,
    copy
  );
  assert.equal(untimed.line, copy.recordedUntimed);
  assert.equal(untimed.badge, "기록됨");

  const unreadable = room({ control: financeControl("unreadable") });
  assert.equal(unreadable.status, "attention");
  assert.equal(unreadable.line, copy.controlUnreadable);
  assert.match(unreadable.detail, /읽을 수 있는 스위치 없음/);

  const off = room({ control: financeControl("disabled") });
  assert.equal(financeTone(agentOfficeFinanceState(financeInput({ control: financeControl("disabled") }))), "waiting");
  assert.equal(off.line, copy.off);
  // The newest digest's time is still named when the line does not carry it.
  assert.match(off.detail, /마지막 digest 10-08 01:00 UTC/);
  assert.equal(room({ environment: "development" }).status, "waiting");
  assert.equal(room({ environment: "development" }).line, copy.notApplicable);

  const unread = financeLiveDept({ kind: "unread" }, readAt, copy);
  assert.equal(unread.status, "attention");
  assert.equal(unread.badge, "읽지 못함");

  for (const locale of ["en", "ko"]) {
    const words = adminAgentOfficeMessages[locale].real.finance;
    for (const key of ["recorded", "silent", "not_due", "off", "control_unreadable", "not_applicable", "unread"]) {
      assert.ok(words.badges[key], `${locale}: ${key}`);
    }
    // Nothing about prices, models or deadlines inside the digest.
    for (const value of Object.values(words).filter((v) => typeof v === "string")) {
      assert.doesNotMatch(value, /model|price|\$|모델|가격/i, `${locale}: "${value}"`);
    }
  }
});

test("the office reads the billing and finance agent's state, never its digest", () => {
  const finance = readFunction("readFinance");
  assert.match(finance, /readBillingFinanceOpsControl\(prisma\)/);
  // Today's row for this environment, by the agent's own idempotency key.
  assert.match(finance, /agentDigestItem\.count\(\{[\s\S]*?billingFinanceOpsIdempotencyKey\(/);
  assert.match(finance, /agentDigestItem\.findFirst\(\{[\s\S]*?select: \{ createdAt: true \}/);
  assert.doesNotMatch(finance, /payload|sizeBytes|kind: true|select: \{ value/);
  // The environment through the app's own resolver; no secret, no raw env.
  assert.match(finance, /resolveDeploymentEnvironment\(\)/);
  assert.doesNotMatch(finance, /process\.env/);
  assert.match(finance, /read: "billing_finance_ops"/);
});

// ── The real view is the default; the demo plays on request ───────────────

const liveLine = (text, status = "done") => ({ status, badge: "", line: text, detail: "" });

test("the office opens on the real view: everyone at their desk, still, and every room at its real or link status", () => {
  const live = { research: liveLine("Latest run recorded"), qa: liveLine("Digest silent", "attention") };
  const office = new AgentOffice(adminAgentOfficeMessages.en, live);
  assert.equal(office.snapshot().demo, false);
  assert.equal(office.log[0].text, adminAgentOfficeMessages.en.sim.realReady);
  const homes = new Map(office.agents.map((agent) => [agent.id, `${agent.x},${agent.y}`]));
  for (const agent of office.agents) {
    if (agent.rank === "operator") continue;
    assert.notEqual(agent.status, "offDuty", `${agent.id} is not at work`);
    assert.equal(`${agent.x},${agent.y}`, `${agent.home.x},${agent.home.y}`, `${agent.id} is not at their desk`);
    assert.equal(agent.anim, "sit");
  }
  for (const id of AGENT_OFFICE_DEPT_IDS) {
    const expected = live[id]?.status ?? (AGENT_OFFICE_BLOCKED_DEPTS.has(id) ? "blocked" : "waiting");
    assert.equal(office.deptStatus[id], expected, id);
  }
  // Nobody wanders off or speaks a line of their own; a live room's lead
  // keeps its record's line on screen, and that is all anyone says.
  const said = new Set();
  for (let i = 0; i < 4000; i += 1) {
    office.tick(0.05);
    for (const agent of office.agents) if (agent.speech) said.add(`${agent.id}: ${agent.speech}`);
  }
  assert.deepEqual(
    [...said].sort(),
    ["qa-lead: Digest silent", "research-lead: Latest run recorded"],
    "someone said something other than a record line on the real view"
  );
  for (const agent of office.agents) assert.equal(`${agent.x},${agent.y}`, homes.get(agent.id), agent.id);
});

test("on the real view the console answers questions and declines orders that would move the demo's staff", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en, {
    engineering: liveLine("Run in progress · started 10-08 12:00 UTC", "working"),
  });
  const s = adminAgentOfficeMessages.en.sim;
  const before = office.agents.map((agent) => `${agent.id}@${agent.x},${agent.y}`);
  for (const order of ["Everyone back to your desks", "Call a meeting with every team", "Thank you, everyone", "Hurry up"]) {
    office.command(order);
    assert.equal(office.chat.at(-1).text, s.demoOnly, order);
  }
  // An order phrased as a question is not an order: it moves nobody.
  for (const question of ["Call a meeting?", "회의 소집?", "Brief me?", "브리핑?"]) office.command(question);
  for (let i = 0; i < 400; i += 1) office.tick(0.05);
  assert.deepEqual(office.agents.map((agent) => `${agent.id}@${agent.x},${agent.y}`), before);
  assert.equal(office.meetingTitle, null);
  // Questions are still answered, from the real view.
  office.command("Status?");
  const status = office.chat.at(-1).text;
  assert.ok(status.startsWith(s.statusReal), status);
  assert.match(status, /Engineering: Run in progress/);
  office.command("Why is it slow?");
  assert.doesNotMatch(office.chat.at(-1).text, new RegExp(s.delayNotStarted));
  office.command("What is engineering doing?");
  assert.match(office.chat.at(-1).text, /real record/);
  office.command("What is marketing doing?");
  // ...and only in the console: nobody stirs, and the only bubble is the
  // live room's record line.
  for (let i = 0; i < 40; i += 1) office.tick(0.05);
  for (const agent of office.agents) {
    const expected = agent.id === "engineering-lead" ? "Run in progress · started 10-08 12:00 UTC" : null;
    assert.equal(agent.speech, expected, `${agent.id} said something on the real view`);
    if (agent.rank !== "operator") assert.equal(agent.anim, "sit", `${agent.id} stirred on the real view`);
  }
  // A fresh reading changes what the lead says.
  office.setLive({ engineering: liveLine("2 decisions waiting for you", "attention") });
  office.tick(0.05);
  assert.equal(office.agentById.get("engineering-lead").speech, "2 decisions waiting for you");
});

test("the demo plays on request, leaves the live rooms seated, and ends back on the real view", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en, { research: liveLine("Latest run recorded") });
  office.speed = 10;
  office.start();
  assert.equal(office.snapshot().demo, true);
  const researchAt = new Map();
  for (const agent of office.agents) {
    if (agent.rank === "operator") continue;
    if (agent.deptId === "research") {
      assert.notEqual(agent.status, "offDuty", "a live room's staff were sent home for the demo");
      researchAt.set(agent.id, `${agent.x},${agent.y}`);
    } else {
      assert.equal(agent.status, "offDuty", `${agent.id} did not start the demo at the entrance`);
    }
  }
  runUntil(office, () => office.approvalPending);
  for (const agent of office.agents) {
    if (agent.deptId === "research") assert.equal(`${agent.x},${agent.y}`, researchAt.get(agent.id), agent.id);
  }
  // Orders work while the demo plays.
  office.command("Thank you, everyone");
  assert.notEqual(office.chat.at(-1).text, adminAgentOfficeMessages.en.sim.demoOnly);

  office.endDemo();
  const snap = office.snapshot();
  assert.equal(snap.demo, false);
  assert.equal(snap.running, false);
  assert.equal(snap.approvalPending, false);
  assert.equal(office.chat.at(-1).text, adminAgentOfficeMessages.en.sim.demoEnded);
  assert.equal(office.deptStatus.research, "done");
  assert.equal(office.deptStatus.engineering, "waiting");
  for (const agent of office.agents) {
    if (agent.rank !== "operator") assert.equal(`${agent.x},${agent.y}`, `${agent.home.x},${agent.home.y}`, agent.id);
  }
});

test("the page offers no way into the demo, and says demo only if one plays", () => {
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  // Operator decision 2026-10-09: the office is live only. No control starts,
  // paces or ends a demo day, and the camera-follow toggle is gone with it.
  assert.doesNotMatch(panel, /engine\.start\(|engine\.endDemo\(|engine\.setSpeed\(|engine\.togglePause\(|skipToDecision\(/);
  assert.doesNotMatch(panel, /agent-office-watch-demo|agent-office-end-demo|m\.live\.follow\(|m\.live\.onDuty\(/);
  assert.doesNotMatch(panel, /m\.console\.focusOn|m\.console\.normal/);
  assert.match(panel, /\{snap\.demo \? \(\s*<div className=\{cx\("shell-notice"\)\}/);
  assert.match(panel, /snap\.demo \? m\.live\.eyebrow\(engine\.staff\.length\) : m\.live\.eyebrowReal/);
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.match(copy.live.eyebrowReal(26), locale === "en" ? /REAL VIEW/ : /실제 화면/);
    // The quick chips are the two questions the real view answers from records.
    assert.equal(copy.console.quick.length, 2);
  }
});

// ── Independent review room ───────────────────────────────────────────────

const reviewSnapshot = (overrides = {}) => ({
  schemaVersion: 1,
  draining: false,
  pendingJobs: 2,
  providers: [
    { id: "claude", vendor: "anthropic", enabled: true, running: 1, maxConcurrent: 2 },
    { id: "codex", vendor: "openai", enabled: true, running: 0, maxConcurrent: 2 },
    { id: "devin", vendor: "cognition", enabled: false, running: 0, maxConcurrent: 2 },
  ],
  last24h: { accept: 9, reject: 3, unknown: 2 },
  ...overrides,
});
const SECRET = "s".repeat(40);
const statusRequest = (body, authorization = `Bearer ${SECRET}`, headers = {}) =>
  new Request("https://tomverse.test/api/internal/review-orchestrator/status", {
    method: "POST",
    headers: { authorization, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const fakeDb = () => {
  const writes = [];
  return { writes, appSetting: { upsert: async (args) => (writes.push(args), args) } };
};

test("the review server's report is content-free by its schema", () => {
  assert.equal(reviewStatusSnapshotSchema.safeParse(reviewSnapshot()).success, true);
  // No field for a job, a branch, a scope or a finding.
  for (const extra of [{ jobId: "r-1" }, { branch: "x" }, { scope: "y" }, { findings: [] }]) {
    assert.equal(reviewStatusSnapshotSchema.safeParse({ ...reviewSnapshot(), ...extra }).success, false, Object.keys(extra)[0]);
  }
  assert.equal(
    reviewStatusSnapshotSchema.safeParse(
      reviewSnapshot({ providers: [{ id: "claude", vendor: "anthropic", enabled: true, running: 0, maxConcurrent: 1, note: "x" }] })
    ).success,
    false
  );
  // Reviewer ids are machine ids, unique.
  assert.equal(
    reviewStatusSnapshotSchema.safeParse(
      reviewSnapshot({ providers: [{ id: "Claude Opus!", vendor: "anthropic", enabled: true, running: 0, maxConcurrent: 1 }] })
    ).success,
    false
  );
  const dup = { id: "codex", vendor: "openai", enabled: true, running: 0, maxConcurrent: 1 };
  assert.equal(reviewStatusSnapshotSchema.safeParse(reviewSnapshot({ providers: [dup, dup] })).success, false);
  assert.equal(parseStoredReviewStatus("not json").state, "unreadable");
  assert.equal(parseStoredReviewStatus(JSON.stringify({ receivedAt: "x", snapshot: reviewSnapshot() })).state, "unreadable");
});

test("the status route records the latest report only with the secret, and stamps it with the app's clock", async () => {
  const env = { [REVIEW_ORCHESTRATOR_STATUS_SECRET_ENV]: SECRET };
  const now = () => new Date("2026-10-09T01:02:03.000Z");

  let db = fakeDb();
  assert.deepEqual(await recordReviewOrchestratorStatus(statusRequest(reviewSnapshot(), "Bearer wrong"), env, db, now), {
    status: 401,
    body: { result: "unauthorized" },
  });
  // A short secret configured is no secret at all.
  assert.equal(
    (await recordReviewOrchestratorStatus(statusRequest(reviewSnapshot(), "Bearer short"), { [REVIEW_ORCHESTRATOR_STATUS_SECRET_ENV]: "short" }, db, now)).status,
    401
  );
  assert.equal((await recordReviewOrchestratorStatus(statusRequest("{nope"), env, db, now)).status, 400);
  assert.equal((await recordReviewOrchestratorStatus(statusRequest({ ...reviewSnapshot(), jobId: "r-1" }), env, db, now)).status, 400);
  assert.equal(
    (await recordReviewOrchestratorStatus(statusRequest(reviewSnapshot(), `Bearer ${SECRET}`, { "content-length": "99999" }), env, db, now)).status,
    413
  );
  // No Content-Length at all: the read itself stops at the limit.
  const flood = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(4096)));
    },
  });
  const unsized = new Request("https://tomverse.test/api/internal/review-orchestrator/status", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
    body: flood,
    duplex: "half",
  });
  assert.equal(unsized.headers.get("content-length"), null);
  assert.equal((await recordReviewOrchestratorStatus(unsized, env, db, now)).status, 413);
  assert.equal(db.writes.length, 0, "a refused report was written");

  db = fakeDb();
  assert.deepEqual(await recordReviewOrchestratorStatus(statusRequest(reviewSnapshot()), env, db, now), {
    status: 200,
    body: { result: "recorded" },
  });
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].where.key, "reviewOrchestrator.status");
  const stored = parseStoredReviewStatus(db.writes[0].update.value);
  assert.equal(stored.state, "observed");
  assert.equal(stored.receivedAt, "2026-10-09T01:02:03.000Z");
  assert.deepEqual(stored.snapshot, reviewSnapshot());

  const route = readFileSync("app/api/internal/review-orchestrator/status/route.ts", "utf8");
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /snapshot|request\.json/, "the route answers with a code, never the report");
});

test("the review room shows each reviewer's real state, and a silent server as lost", () => {
  const copy = adminAgentOfficeMessages.ko.real.review;
  const readAt = "2026-10-09T01:05:00.000Z";
  const stored = (snapshot, receivedAt = "2026-10-09T01:04:00.000Z") => JSON.stringify({ receivedAt, snapshot });
  const state = (snapshot, receivedAt, now = "2026-10-09T01:05:00.000Z") =>
    agentOfficeReviewState({ stored: stored(snapshot, receivedAt), now: at(now) });

  const live = reviewRoomView(state(reviewSnapshot()), readAt, REVIEW_ROOM.desks.length, copy);
  assert.equal(live.status, "working");
  assert.equal(live.note, null);
  assert.deepEqual(
    live.reviewers.map((r) => [r.name, r.label, r.status, r.dim]),
    [
      ["claude", "검토 중", "working", false],
      ["codex", "대기", "done", false],
      ["devin", "꺼짐", "waiting", true],
    ]
  );
  assert.equal(live.reviewers[0].title, "claude · anthropic · 검토 중 · 실행 1/2 · 마지막 보고 10-09 01:04 UTC");
  assert.equal(
    live.summary,
    "대기 2 · 최근 24시간 accept 9 · reject 3 · unknown 2 · 마지막 보고 10-09 01:04 UTC · 읽은 시각 10-09 01:05 UTC"
  );
  const idle = reviewRoomView(
    state(reviewSnapshot({ providers: [{ id: "codex", vendor: "openai", enabled: true, running: 0, maxConcurrent: 2 }] })),
    readAt,
    6,
    copy
  );
  assert.equal(idle.status, "done");

  // Five missed beats: every reviewer is lost, and the room says since when.
  const silent = reviewRoomView(state(reviewSnapshot(), "2026-10-09T00:58:00.000Z"), readAt, 6, copy);
  assert.equal(silent.status, "attention");
  assert.ok(silent.reviewers.every((r) => r.label === "보고 없음" && r.status === "attention"));
  assert.equal(silent.note, "10-09 00:58 UTC 이후 보고 없음");
  // Exactly at the threshold it is still fresh.
  assert.equal(state(reviewSnapshot(), "2026-10-09T01:00:00.000Z").stale, false);

  // More reviewers than desks: the room still speaks for all of them, and says how many are not drawn.
  const crowd = Array.from({ length: 8 }, (_, i) => ({
    id: `r${i}`,
    vendor: "openai",
    enabled: true,
    running: i === 7 ? 1 : 0,
    maxConcurrent: 1,
  }));
  const crowded = reviewRoomView(state(reviewSnapshot({ providers: crowd })), readAt, 6, copy);
  assert.equal(crowded.reviewers.length, 6);
  assert.equal(crowded.status, "working", "the one reviewing is past the desks, and still counts");
  assert.equal(crowded.note, "여기 그리지 못한 검토자 2명");
  assert.equal(
    reviewRoomView(state(reviewSnapshot({ providers: crowd.slice(0, 7) })), readAt, 6, adminAgentOfficeMessages.en.real.review).note,
    "1 more reviewer not drawn here"
  );

  const draining = reviewRoomView(state(reviewSnapshot({ draining: true })), readAt, 6, copy);
  assert.equal(draining.status, "waiting");
  assert.equal(draining.note, copy.draining);

  const never = reviewRoomView(agentOfficeReviewState({ stored: null, now: at(readAt) }), readAt, 6, copy);
  assert.equal(never.status, "waiting");
  assert.equal(never.note, copy.notReporting);
  const broken = reviewRoomView(agentOfficeReviewState({ stored: "{", now: at(readAt) }), readAt, 6, copy);
  assert.equal(broken.status, "attention");
  assert.equal(broken.note, copy.unreadable);
  assert.equal(reviewRoomView({ kind: "unread" }, readAt, 6, copy).status, "attention");

  for (const locale of ["en", "ko"]) {
    const states = adminAgentOfficeMessages[locale].real.review.states;
    for (const key of ["reviewing", "idle", "off", "lost"]) assert.ok(states[key], `${locale}: ${key}`);
  }
});

test("the review room has a desk for each reviewer and a way in, and the entrance stays outside it", () => {
  assert.ok(REVIEW_ROOM.desks.length >= 5);
  for (const desk of REVIEW_ROOM.desks) assert.ok(reaches(desk.seat), `review seat ${desk.seat.x},${desk.seat.y}`);
  for (const door of REVIEW_ROOM.doors) assert.ok(walkable(door.x, door.y), "the review room's door is walled in");
  assert.ok(ENTRANCE.y >= REVIEW_ROOM.y + REVIEW_ROOM.h, "the entrance opens into the review room");
  // Reading it selects the one row the review server may write.
  const review = readFunction("readReview");
  assert.match(review, /where: \{ key: REVIEW_ORCHESTRATOR_STATUS_KEY \}/);
  assert.match(review, /select: \{ value: true \}/);
  assert.match(review, /read: "review_orchestrator"/);
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  assert.match(world, /<SeatedLayer room=\{REVIEW_ROOM\} people=\{review\.reviewers\}/);
});

test("a record that needs a look is counted on its own, never as a decision", () => {
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.match(copy.sim.briefLog(5, 1, 4), locale === "en" ? /1 needs a look/ : /확인 필요 1개/);
  }
  assert.equal(adminAgentOfficeMessages.en.dashboard.briefAttention(1), "1 real record needs a look");
  assert.match(adminAgentOfficeMessages.en.briefing.attention(1), /1 room —/);
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.doesNotMatch(panel, /stats\.approval \+ snap\.stats\.attention/);
  assert.match(panel, /m\.dashboard\.metricAttention/);
  assert.match(panel, /m\.live\.attention\(snap\.stats\.attention\)/);
  // The end-of-day brief no longer claims the scripted observation was done.
  for (const locale of ["en", "ko"]) {
    assert.doesNotMatch(adminAgentOfficeMessages[locale].briefing.done(3), /observation|관측/);
  }
});

// ── Theme ─────────────────────────────────────────────────────────────────

test("the office wears Tomverse's colours, in both themes, and not the AI Review gradient", () => {
  const css = readFileSync("components/admin/agentOffice.module.css", "utf8");
  // The original's pinks and lavenders are gone.
  for (const pink of ["#ff8fc0", "#ff5fa8", "#ffe6f2", "#ffb9d9", "#c9b8ff", "#4a2b3c", "rgba(255, 95, 168"]) {
    assert.ok(!css.toLowerCase().includes(pink), `${pink} is back in the office stylesheet`);
  }
  // Cyan, blue and purple together are AI Review's (AGENTS.md, accent roles).
  assert.doesNotMatch(css, /#0e7490|#22d3ee|#9333ea|#c084fc|tomverse-accent/);

  // Dark is written twice -- for an explicit choice and for the system's --
  // and the two copies must not drift.
  const block = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `${selector} is missing`);
    const body = css
      .slice(css.indexOf("{", at) + 1, css.indexOf("}", at))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return body
      .split(";")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  };
  const explicit = block(":global(.dark) .office");
  const system = block(":global(:root:not(.light):not(.dark)) .office");
  assert.deepEqual(system, explicit);
  assert.ok(explicit.length > 40, "the dark block lost its tokens");

  // Every token dark sets is one light defines.
  const light = new Set(block(".office {").map((line) => line.split(":")[0]));
  for (const line of explicit) {
    const name = line.split(":")[0];
    if (name.startsWith("--")) assert.ok(light.has(name), `${name} has a dark value and no light one`);
  }
});

test("the staff wear the office's palette, not the original's pink", () => {
  const pinks = ["#ff8fc0", "#ffe6f2", "#c9b8ff", "#42283a"];
  for (const staff of AGENT_OFFICE_STAFF) {
    for (const colour of staff.colors) {
      assert.ok(!pinks.includes(colour), `${staff.id} still wears ${colour}`);
    }
  }
  for (const [key, colour] of Object.entries(AGENT_OFFICE_OPERATOR)) {
    assert.ok(!pinks.includes(colour), `the operator's ${key} is still ${colour}`);
  }
  for (const colours of AGENT_OFFICE_WORKER_COLORS) {
    for (const colour of colours) assert.ok(!pinks.includes(colour), `an AMUX worker wears ${colour}`);
  }
});

test("a variable set inline on a sprite or a portrait never shadows a theme token", () => {
  // Custom properties inherit, so one set inline on an element replaces the
  // theme's value for everything drawn inside it -- the rank badge, the name
  // tag and the ring sit inside the sprite.
  const css = readFileSync("components/admin/agentOffice.module.css", "utf8");
  const theme = css.slice(css.indexOf(".office {"), css.indexOf("}", css.indexOf(".office {")));
  const tokens = new Set([...theme.matchAll(/(--[a-z0-9-]+):/g)].map((match) => match[1]));
  assert.ok(tokens.has("--accent") && tokens.size > 40);
  for (const file of ["components/admin/AgentOfficeWorld.tsx", "components/admin/AgentOfficePanel.tsx"]) {
    const source = readFileSync(file, "utf8");
    const inline = [...source.matchAll(/"(--[a-z0-9-]+)":/g)].map((match) => match[1]);
    assert.ok(inline.length > 0, `${file} sets no inline variables`);
    for (const name of inline) assert.ok(!tokens.has(name), `${file} sets ${name} inline, shadowing the theme`);
  }
});
