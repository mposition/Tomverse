import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_NAVIGATION } from "../lib/adminNavigation.ts";
import { adminAgentOfficeMessages } from "../lib/adminMessages/agentOffice.ts";
import { findPath } from "../lib/agentOffice/pathfinding.ts";
import {
  AGENT_OFFICE_BLOCKED_DEPTS,
  AGENT_OFFICE_DEPTS,
  AGENT_OFFICE_DEPT_IDS,
  AGENT_OFFICE_NARRATOR_ID,
  AGENT_OFFICE_STAFF,
  AGENT_OFFICE_TEAM_IDS,
} from "../lib/agentOffice/roster.ts";
import { AgentOffice, PHASE, PHASE_COUNT } from "../lib/agentOffice/sim.ts";
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

test("the office holds the seven agent teams and the digest desk", () => {
  assert.equal(AGENT_OFFICE_TEAM_IDS.length, 7);
  assert.deepEqual(
    [...AGENT_OFFICE_TEAM_IDS].sort(),
    ["engineering", "finance", "marketing", "qa", "research", "sre", "support"]
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
  assert.equal(snap.stats.done, AGENT_OFFICE_DEPT_IDS.length - AGENT_OFFICE_BLOCKED_DEPTS.size);
  for (const id of AGENT_OFFICE_BLOCKED_DEPTS) {
    assert.equal(snap.deptStatus[id], "blocked", `${id} was reported as something it did not do`);
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
