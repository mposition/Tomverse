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
} from "../lib/agentOffice/roster.ts";
import { AgentOffice, PHASE, PHASE_COUNT } from "../lib/agentOffice/sim.ts";
import { qaLiveDept, qaTone, researchLiveDept, researchTone } from "../lib/agentOffice/live.ts";
import { agentOfficeQaState } from "../lib/agentOfficeQaState.ts";
import { agentOfficeResearchState } from "../lib/agentOfficeResearchState.ts";
import {
  DEPT_ROOMS,
  ENTRANCE,
  LOUNGE_ROOM,
  MEETING_SEATS,
  OPERATOR_REPORT_SPOT,
  OPERATOR_SEAT,
  walkable,
} from "../lib/agentOffice/world.ts";

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
  const dark = agentOfficeQaState(qaInput({ control: null, digestSecretConfigured: false }));
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
  assert.equal(qaWorked, false, "the QA room was given scripted work");
  assert.equal(qaInMeeting, false, "the QA lead sat in a scripted meeting");
  assert.deepEqual([...spoken].filter((line) => line !== live.qa.line), []);
  assert.equal(office.deptStatus.qa, "attention");
  assert.ok(office.log.some((entry) => entry.text.includes("(real record): Digest silent")));
  // The PR log no longer claims QA classified CI.
  for (const locale of ["en", "ko"]) {
    assert.doesNotMatch(adminAgentOfficeMessages[locale].sim.prLog, /CI/);
  }
});

test("the office reads the QA agent's state, never a digest's content", () => {
  const source = readFileSync("lib/agentOfficeLiveRead.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = source.indexOf("async function readQa");
  const end = source.indexOf("export async function readAgentOfficeLiveRooms");
  assert.ok(start >= 0 && end > start, "readQa not found");
  const qa = source.slice(start, end);
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
