import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import { ADMIN_NAVIGATION } from "../lib/adminNavigation.ts";
import { adminAgentOfficeMessages } from "../lib/adminMessages/agentOffice.ts";
import {
  AGENT_OFFICE_BLOCKED_DEPTS,
  AGENT_OFFICE_DEPTS,
  AGENT_OFFICE_DEPT_IDS,
  AGENT_OFFICE_NARRATOR_ID,
  AGENT_OFFICE_OPERATOR,
  AGENT_OFFICE_STAFF,
  AGENT_OFFICE_TEAM_IDS,
  AGENT_OFFICE_AMUX_RECORD_HREF,
  AGENT_OFFICE_DECISION_RECORD_HREF,
  AGENT_OFFICE_DECLARED_RECORD_HREFS,
  AGENT_OFFICE_DIGEST_SENDERS,
  AGENT_OFFICE_WORKER_COLORS,
  AGENT_OFFICE_WORKER_SKINS,
  agentOfficeSeatedClothes,
  consoleHasRecord,
} from "../lib/agentOffice/roster.ts";
import { AgentOffice } from "../lib/agentOffice/sim.ts";
import {
  amuxRoomView,
  decisionRoomView,
  digestLiveDept,
  engineeringLiveDept,
  financeLiveDept,
  financeTone,
  qaLiveDept,
  qaTone,
  OPERATOR_QUEUE_HREFS,
  OPERATOR_QUEUE_KEYS,
  agentOfficeBrief,
  agentOfficeReport,
  operatorQueueTotal,
  researchLiveDept,
  reviewQuotaView,
  reviewRoomView,
  researchTone,
} from "../lib/agentOffice/live.ts";
import { agentOfficeAmuxState } from "../lib/agentOfficeAmuxState.ts";
import { AGENT_OFFICE_DECISION_WINDOW_MS, agentOfficeDecisionState } from "../lib/agentOfficeDecisionState.ts";
import { AGENT_OFFICE_DIGEST_WINDOW_MS, agentOfficeDigestState } from "../lib/agentOfficeDigestState.ts";
import { AGENT_DIGEST_AGENT_KEYS } from "../lib/agentDigestContract.ts";
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
  DECISION_ROOM,
  REVIEW_ROOM,
  DEPT_ROOMS,
  ENTRANCE_MAT,
  PROPS,
  ROOMS,
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

test("the office holds the eight agent teams and the digest desk", () => {
  assert.equal(AGENT_OFFICE_TEAM_IDS.length, 8);
  assert.deepEqual(
    [...AGENT_OFFICE_TEAM_IDS].sort(),
    ["engineering", "finance", "marketing", "qa", "research", "sre", "support", "trust"]
  );
  assert.equal(DEPT_ROOMS.length, AGENT_OFFICE_DEPT_IDS.length);
  assert.ok(AGENT_OFFICE_DEPT_IDS.includes("digest"));
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
  assert.equal(
    AGENT_OFFICE_DECISION_RECORD_HREF,
    consoleHasRecord("/admin/amux-execution?tab=decision-maker") ? "/admin/amux-execution?tab=decision-maker" : null
  );
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  // A room's header links its record: the AMUX room, the Decision Maker, and a
  // team room only while it reads a live record -- a link is never offered for
  // a room the office shows as waiting on one.
  assert.match(world, /const liveDept = real \? null : engine\.liveDept\(room\.id\);/);
  assert.match(
    world,
    /const recordHref = isAmux\s*\? AGENT_OFFICE_AMUX_RECORD_HREF\s*: isDecision\s*\? AGENT_OFFICE_DECISION_RECORD_HREF\s*: liveDept\s*\? \(agentOfficeDept\(room\.id\)\?\.recordHref \?\? null\)\s*: null;/
  );
  assert.match(world, /\{recordHref \? \(/);
});

test("the catalog names every room and person in both languages", () => {
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.deepEqual(Object.keys(copy.depts).sort(), [...AGENT_OFFICE_DEPT_IDS].sort(), locale);
    assert.deepEqual(
      Object.keys(copy.staff).sort(),
      AGENT_OFFICE_STAFF.map((staff) => staff.id).sort(),
      locale
    );
    for (const staff of AGENT_OFFICE_STAFF) {
      const words = copy.staff[staff.id];
      assert.ok(words.thoughts.length > 0, `${locale}/${staff.id} has no thoughts`);
      assert.equal("callsign" in words, staff.rank === "lead", `${locale}/${staff.id} callsign`);
    }
  }
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

  // A team with no record screen says so.
  ko.deptStatus.sre = "blocked";
  ko.command("SRE팀 왜 늦어?");
  assert.match(ko.chat.at(-1).text, /기록 화면이 없어서/);

  en.command("banana split");
  assert.equal(en.chat.at(-1).text, adminAgentOfficeMessages.en.sim.unknown);
  // A greeting on the real view is small talk; with no live room nobody is there to answer.
  en.command("hello there");
  assert.equal(en.chat.at(-1).text, adminAgentOfficeMessages.en.real.noLiveRoom);
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
  // Every dialog keeps the shared focus contract: profile and seated profile.
  const dialogs = (panel.match(/role="dialog"/g) || []).length;
  assert.equal(dialogs, 2);
  assert.equal((panel.match(/useOfficeDialog\(onClose,/g) || []).length, dialogs);
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

test("a live room's line says what the record says, in Brisbane time, and an unread record is not a state", () => {
  const copy = adminAgentOfficeMessages.ko.real.research;
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
    copy
  );
  assert.equal(ok.status, "done");
  assert.equal(ok.line, "직전 회차 기록됨 · 10-08 07:30 AEST");
  assert.match(ok.detail, /마지막 성공 10-08 07:30 AEST/);
  // The read time is drawn once, by the clock, not in every room line.
  assert.doesNotMatch(ok.detail, /읽은 시각|마지막 갱신/);

  assert.equal(ok.badge, "기록됨");

  // A read that failed needs a look; it is not "waiting on a link" and not done.
  const unread = researchLiveDept({ kind: "unread" }, copy);
  assert.equal(unread.status, "attention");
  assert.equal(unread.badge, "읽지 못함");
  assert.equal(unread.line, copy.unread);

  // A switched-off agent waits; it is not a failure.
  assert.equal(researchLiveDept({ kind: "disabled" }, copy).status, "waiting");

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
    copy
  );
  assert.equal(morning.line, "직전 회차 실패 · 10-08 07:30 AEST · clone");
  assert.equal(morning.badge, "실패");
  for (const locale of ["en", "ko"]) {
    const words = adminAgentOfficeMessages[locale].real.research;
    for (const value of [words.ok("x"), words.failed("x", "y"), words.duplicate("x"), words.missingOpen("x"), words.missing("x")]) {
      assert.doesNotMatch(value, /today|오늘/i, `${locale}: "${value}" calls the slot today's`);
      assert.match(value, /x/, `${locale}: "${value}" does not name its slot`);
    }
  }
});

test("a live room's status and line are its record's, and a fresh reading moves only it", () => {
  const live = {
    research: { status: "done", badge: "Recorded", line: "Today's run recorded · 10-08 07:30 AEST", detail: "" },
  };
  const office = new AgentOffice(adminAgentOfficeMessages.en, live);
  assert.equal(office.deptStatus.research, "done");
  // Thanks and orders reach nobody's desk: the room's staff stay put and say
  // only the record's line (and a moment's emoji for a thank-you).
  office.command("Thank you, everyone");
  office.command("Everyone back to your desks");
  office.command("Call a meeting with every team");
  const spoken = new Set();
  for (let i = 0; i < 400; i += 1) {
    office.tick(0.05);
    for (const agent of office.agents) if (agent.deptId === "research" && agent.speech) spoken.add(agent.speech);
  }
  for (const agent of office.agents) {
    if (agent.deptId === "research") assert.deepEqual([agent.x, agent.y], [agent.home.x, agent.home.y], agent.id);
  }
  assert.deepEqual(
    [...spoken].filter((line) => line !== live.research.line && line !== adminAgentOfficeMessages.en.real.reactions.thanks),
    [],
    "a live room's staff said something the record did not say"
  );

  // The console answers about it with the record.
  office.command("What is research doing?");
  assert.match(office.chat.at(-1).text, /real record/);

  // A fresh reading moves the room and nothing else.
  const before = { ...office.deptStatus };
  office.setLive({ research: { status: "attention", badge: "Unread", line: "Could not read its record", detail: "" } });
  assert.equal(office.deptStatus.research, "attention");
  assert.equal(office.snapshot().stats.attention, 1);
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

test("the QA room says whether a digest arrived, in Brisbane time, and a latched lane needs a look", () => {
  const copy = adminAgentOfficeMessages.ko.real.qa;
  const fresh = qaLiveDept(agentOfficeQaState(qaInput()), copy);
  assert.equal(fresh.status, "done");
  assert.equal(fresh.badge, "수신됨");
  assert.equal(fresh.line, "최근 digest 수신 · 10-07 16:00 AEST");
  assert.equal(fresh.detail, "제어 기록 4번");

  const silent = qaLiveDept(agentOfficeQaState(qaInput({ now: at("2026-10-08T12:00:00Z") })), copy);
  assert.equal(silent.status, "attention");
  assert.equal(silent.line, "digest 침묵 · 마지막 수신 10-07 16:00 AEST");
  assert.equal(qaLiveDept(agentOfficeQaState(qaInput({ latestDigestAt: null })), copy).line, copy.staleNever);

  const latched = qaLiveDept(agentOfficeQaState(qaInput({ mergeLaneLatched: true })), copy);
  assert.equal(latched.status, "attention");
  assert.equal(latched.badge, "레인 잠김");
  assert.match(latched.detail, /병합 레인 잠김/);

  const mismatch = qaLiveDept(agentOfficeQaState(qaInput({ digestSecretConfigured: false })), copy);
  assert.equal(mismatch.status, "attention");
  assert.equal(mismatch.line, copy.mismatch);

  // Switched off, or never configured here: waiting, not a failure.
  const off = agentOfficeQaState(qaInput({ control: { revision: 5, digestEnabled: false } }));
  assert.equal(qaTone(off), "waiting");
  assert.equal(qaLiveDept(off, copy).line, copy.disabled);
  // A digest stored before it was switched off is still named.
  assert.equal(qaLiveDept(off, copy).detail, "제어 기록 5번 · 마지막 digest 10-07 16:00 AEST");
  assert.match(mismatch.detail, /마지막 digest 10-07 16:00 AEST/);
  const dark = agentOfficeQaState(qaInput({ control: null, digestSecretConfigured: false, latestDigestAt: null }));
  assert.equal(qaTone(dark), "waiting");
  assert.equal(qaLiveDept(dark, copy).detail, "제어 기록 없음");

  // A read that failed is not a state.
  const unread = qaLiveDept({ kind: "unread" }, copy);
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
  const room = (overrides) => engineeringLiveDept(agentOfficeEngineeringState(engInput(overrides)), copy);

  const clear = room({});
  assert.equal(clear.status, "done");
  assert.equal(clear.badge, "이상 없음");
  assert.equal(clear.line, "직전 회차 private_result · 10-08 07:30 AEST");
  assert.equal(
    clear.detail,
    "모드 t1 · 실행기 마지막 완료 10-08 07:40 AEST · 게시기 완료 기록 없음"
  );

  // A failed latest run is not clear, whatever its line says.
  const failed = room({
    lastRun: { status: "finished", outcome: "agent_failed", startedAt: at("2026-10-07T21:00:00Z"), endedAt: at("2026-10-07T21:30:00Z") },
  });
  assert.equal(failed.status, "attention");
  assert.equal(failed.badge, "확인 필요");
  assert.equal(failed.line, "직전 회차 agent_failed · 10-08 07:30 AEST");

  const halted = room({ halt: "circuit_open", killSwitch: "1" });
  assert.equal(halted.status, "attention", "a halt needs a look even while the agent is switched off");
  assert.equal(halted.line, "정지: 반복 실패로 차단기 열림");
  assert.match(halted.detail, /직전 회차 private_result · 10-08 07:30 AEST/);

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
  assert.equal(running.line, "작업 중 · 10-08 06:00 AEST 시작");
  assert.match(running.detail, /직전 회차 private_result · 10-08 07:30 AEST/);
  assert.doesNotMatch(running.detail, /작업 중/, "the runs in progress are named once");
  // Runs in progress stay on screen when a failed run, a halt or a decision takes the line.
  const failedWhileRunning = room({
    active: { count: 2, since: at("2026-10-07T20:00:00Z") },
    lastRun: { status: "finished", outcome: "agent_failed", startedAt: at("2026-10-07T21:00:00Z"), endedAt: at("2026-10-07T21:30:00Z") },
  });
  assert.equal(failedWhileRunning.status, "attention");
  assert.equal(failedWhileRunning.line, "직전 회차 agent_failed · 10-08 07:30 AEST");
  assert.match(failedWhileRunning.detail, /작업 중 2건 · 가장 이른 시작 10-08 06:00 AEST/);
  assert.match(
    room({ halt: "state_mismatch", active: { count: 1, since: at("2026-10-07T20:00:00Z") } }).detail,
    /작업 중 · 10-08 06:00 AEST 시작/
  );
  assert.match(
    room({ openOwnerItems: [{ kind: "decision", count: 1 }], active: { count: 1, since: at("2026-10-07T20:00:00Z") } }).detail,
    /작업 중 · 10-08 06:00 AEST 시작/
  );
  const two = room({ active: { count: 2, since: at("2026-10-07T20:00:00Z") } });
  assert.equal(two.line, "작업 중 2건 · 가장 이른 시작 10-08 06:00 AEST");

  const fresh = room({ lastRun: null });
  assert.equal(fresh.status, "waiting");
  assert.equal(fresh.line, copy.noRun);

  const unread = engineeringLiveDept({ kind: "unread" }, copy);
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
  // No copy shown while engineering is live claims there is nothing to decide.
  for (const locale of ["en", "ko"]) {
    const c = adminAgentOfficeMessages[locale];
    for (const value of [
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

test("the AMUX room sits under the teams, with a desk for every worker", () => {
  assert.ok(AMUX_ROOM.desks.length >= 8, "fewer desks than the catalog's workers");
  assert.ok(AMUX_ROOM.y > DEPT_ROOMS.reduce((bottom, room) => Math.max(bottom, room.y + room.h), 0));
  // The entrance's doormat is in the lobby, not in the AMUX room.
  assert.ok(ENTRANCE_MAT.x >= AMUX_ROOM.x + AMUX_ROOM.w, "the entrance is drawn in the AMUX room");
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
  const view = (workers, desks = 12) =>
    amuxRoomView({ kind: "observed", workers }, desks, copy);
  const worker = (name, state) => ({ name, provider: "openai", state, heartbeatAt: "2026-10-07T22:04:30.000Z" });

  const mixed = view([worker("a", "ready"), worker("b", "busy"), worker("c", "lost"), worker("d", "stopped")]);
  assert.equal(mixed.status, "attention");
  assert.equal(mixed.summary, "연결 2/4 · 작업 중 1 · 확인 필요 1");
  assert.deepEqual(
    mixed.workers.map((w) => [w.name, w.status, w.label, w.dim]),
    [
      ["a", "done", "배정 가능", false],
      ["b", "working", "작업 중", false],
      ["c", "attention", "연결 끊김", false],
      ["d", "waiting", "정지", true],
    ]
  );
  assert.equal(mixed.workers[0].title, "a · openai · 배정 가능 · 마지막 heartbeat 10-08 08:04 AEST");
  // The profile a click opens says the same as the tooltip, a fact per line.
  assert.deepEqual(mixed.workers[0].facts, [
    { label: "공급사", value: "openai" },
    { label: "상태", value: "배정 가능" },
    { label: "마지막 heartbeat", value: "10-08 08:04 AEST" },
  ]);
  assert.equal(
    view([{ name: "q", provider: "openai", state: "not_running", heartbeatAt: null }]).workers[0].facts[2].value,
    copy.noHeartbeat
  );
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

  const unread = amuxRoomView({ kind: "unread" }, 12, copy);
  assert.equal(unread.status, "attention");
  assert.deepEqual(unread.workers, []);
  assert.match(unread.summary, /worker 기록을 읽지 못함/);
  assert.equal(unread.note, copy.unread, "a failed read is said in the room, not only in a tooltip");
  const none = amuxRoomView({ kind: "no_catalog" }, 12, copy);
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
  // neither move them nor give them a line. A click names the room and the
  // worker, and nothing else.
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  const layer = world.slice(world.indexOf("const SeatedLayer"), world.indexOf("const PropLayer"));
  assert.doesNotMatch(layer, /engine|onSelect\b/);
  assert.equal(layer.match(/onPick\(/g)?.length, 2, "pointer and keyboard open the same profile");
  assert.match(layer, /onPointerUp=\{\(\) => onPick\(kind, worker\.name\)\}/);
  assert.match(layer, /role="button"/);
  assert.match(layer, /tabIndex=\{0\}/);
  assert.match(world, /<SeatedLayer room=\{AMUX_ROOM\} kind="amux" people=\{amux\.workers\} onPick=\{onPickSeated\} \/>/);
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
  const room = (overrides) => financeLiveDept(agentOfficeFinanceState(financeInput(overrides)), copy);

  const recorded = room({});
  assert.equal(recorded.status, "done");
  assert.equal(recorded.badge, "기록됨");
  assert.equal(recorded.line, "오늘 기한 digest 기록됨 · 10-08 11:00 AEST");
  assert.equal(recorded.detail, "스위치 기록 3번 · 켜진 시각 10-01 10:00 AEST");

  const silent = room({ recordedToday: false, latestDigestAt: at("2026-10-07T01:00:09Z") });
  assert.equal(silent.status, "attention");
  assert.equal(silent.line, "오늘 digest 없음 · 마지막 기록 10-07 11:00 AEST");
  assert.equal(room({ recordedToday: false, latestDigestAt: null }).line, copy.silentNever);

  // Not due covers the grace hour and a switch turned on after today's slot.
  assert.equal(room({ recordedToday: false, now: at("2026-10-08T01:30:00Z") }).line, copy.notDue);
  assert.equal(room({ recordedToday: false, now: at("2026-10-08T01:30:00Z") }).status, "waiting");
  // Recorded stays recorded even when the newest digest's time was not read with it.
  const untimed = financeLiveDept(
    { kind: "observed", verdict: "recorded", controlRevision: 3, enabledAt: null, latestDigestAt: null },
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
  assert.match(off.detail, /마지막 digest 10-08 11:00 AEST/);
  assert.equal(room({ environment: "development" }).status, "waiting");
  assert.equal(room({ environment: "development" }).line, copy.notApplicable);

  const unread = financeLiveDept({ kind: "unread" }, copy);
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

test("the office opens with everyone at their desk, still, and every room at its real or link status", () => {
  const live = { research: liveLine("Latest run recorded"), qa: liveLine("Digest silent", "attention") };
  const office = new AgentOffice(adminAgentOfficeMessages.en, live);
  const homes = new Map(office.agents.map((agent) => [agent.id, `${agent.x},${agent.y}`]));
  for (const agent of office.agents) {
    if (agent.rank === "operator") continue;
    assert.equal(agent.status, "idle", agent.id);
    assert.equal(`${agent.x},${agent.y}`, `${agent.home.x},${agent.home.y}`, `${agent.id} is not at their desk`);
  }
  for (const id of AGENT_OFFICE_DEPT_IDS) {
    const expected = live[id]?.status ?? (AGENT_OFFICE_BLOCKED_DEPTS.has(id) ? "blocked" : "waiting");
    assert.equal(office.deptStatus[id], expected, id);
  }
  // Nobody moves or speaks a line of their own; a live room's lead keeps its
  // record's line on screen, and that is all anyone says.
  const said = new Set();
  for (let i = 0; i < 4000; i += 1) {
    office.tick(0.05);
    for (const agent of office.agents) if (agent.speech) said.add(`${agent.id}: ${agent.speech}`);
  }
  assert.deepEqual(
    [...said].sort(),
    ["qa-lead: Digest silent", "research-lead: Latest run recorded"],
    "someone said something other than a record line"
  );
  for (const agent of office.agents) assert.equal(`${agent.x},${agent.y}`, homes.get(agent.id), agent.id);
});

test("the console answers questions and declines orders: the office moves nobody", () => {
  const office = new AgentOffice(adminAgentOfficeMessages.en, {
    engineering: liveLine("Run in progress · started 10-08 22:00 AEST", "working"),
  });
  const s = adminAgentOfficeMessages.en.sim;
  const before = office.agents.map((agent) => `${agent.id}@${agent.x},${agent.y}`);
  for (const order of ["Everyone back to your desks", "Call a meeting with every team", "Hurry up"]) {
    office.command(order);
    assert.equal(office.chat.at(-1).text, s.ordersDeclined, order);
  }
  // An order phrased as a question is not an order: it moves nobody.
  for (const question of ["Call a meeting?", "회의 소집?", "Brief me?", "브리핑?"]) office.command(question);
  for (let i = 0; i < 400; i += 1) office.tick(0.05);
  assert.deepEqual(office.agents.map((agent) => `${agent.id}@${agent.x},${agent.y}`), before);
  // Questions are still answered, from the records.
  office.command("Status?");
  const status = office.chat.at(-1).text;
  assert.ok(status.startsWith(s.statusReal), status);
  assert.match(status, /Engineering: Run in progress/);
  office.command("Why is it slow?");
  assert.match(office.chat.at(-1).text, /Engineering: Run in progress/);
  office.command("What is engineering doing?");
  assert.match(office.chat.at(-1).text, /real record/);
  office.command("What is marketing doing?");
  // ...and only in the console: nobody stirs, and the only bubble is the
  // live room's record line.
  for (let i = 0; i < 40; i += 1) office.tick(0.05);
  for (const agent of office.agents) {
    const expected = agent.id === "engineering-lead" ? "Run in progress · started 10-08 22:00 AEST" : null;
    assert.equal(agent.speech, expected, `${agent.id} said something`);
  }
  // A fresh reading changes what the lead says.
  office.setLive({ engineering: liveLine("2 decisions waiting for you", "attention") });
  office.tick(0.05);
  assert.equal(office.agentById.get("engineering-lead").speech, "2 decisions waiting for you");
});

test("the office has no demo: nothing plays, paces or ends a scripted day", () => {
  // Operator decisions 2026-10-09 (live only) and 2026-10-10 (remove the demo engine).
  const office = new AgentOffice(adminAgentOfficeMessages.en);
  for (const method of ["start", "endDemo", "approve", "setSpeed", "togglePause", "skipToDecision", "skippedPhases"]) {
    assert.equal(typeof office[method], "undefined", method);
  }
  const snap = office.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ["chat", "deptStatus", "spotlight", "stats"]);
  const sim = readFileSync("lib/agentOffice/sim.ts", "utf8");
  assert.doesNotMatch(sim, /dayScript|PHASE|findPath|beginMeeting|this\.demo|clockText/);
  assert.equal(existsSync("lib/agentOffice/pathfinding.ts"), false);
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.doesNotMatch(panel, /snap\.demo|shell-notice|BriefingModal|setBriefingHandler|m\.shell|m\.briefing/);
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  assert.doesNotMatch(world, /PHASE|meetingTitle|ag-bar/);
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    for (const block of ["shell", "briefing", "phases", "phaseApproved"]) assert.equal(copy[block], undefined, `${locale}.${block}`);
    assert.doesNotMatch(JSON.stringify(copy, (key, value) => (typeof value === "function" ? value(2, "x", "y", 1) : value)), /demo|데모|simulat|시뮬/i);
    assert.match(copy.live.eyebrowReal(26), locale === "en" ? /REAL VIEW/ : /실제 화면/);
    // The quick chips: the two questions the console answers from records, and a thank-you.
    assert.equal(copy.console.quick.length, 3);
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

  const live = reviewRoomView(state(reviewSnapshot()), REVIEW_ROOM.desks.length, copy);
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
  assert.equal(live.reviewers[0].title, "claude · anthropic · 검토 중 · 실행 1/2 · 마지막 보고 10-09 11:04 AEST");
  assert.deepEqual(live.reviewers[0].facts, [
    { label: "공급사", value: "anthropic" },
    { label: "상태", value: "검토 중" },
    { label: "실행 중/상한", value: "1/2" },
    { label: "마지막 보고", value: "10-09 11:04 AEST" },
  ]);
  assert.equal(
    live.summary,
    "대기 2 · 최근 24시간 accept 9 · reject 3 · unknown 2 · 마지막 보고 10-09 11:04 AEST"
  );
  const idle = reviewRoomView(
    state(reviewSnapshot({ providers: [{ id: "codex", vendor: "openai", enabled: true, running: 0, maxConcurrent: 2 }] })),
    6,
    copy
  );
  assert.equal(idle.status, "done");

  // Five missed beats: every reviewer is lost, and the room says since when.
  const silent = reviewRoomView(state(reviewSnapshot(), "2026-10-09T00:58:00.000Z"), 6, copy);
  assert.equal(silent.status, "attention");
  assert.ok(silent.reviewers.every((r) => r.label === "보고 없음" && r.status === "attention"));
  assert.equal(silent.note, "10-09 10:58 AEST 이후 보고 없음");
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
  const crowded = reviewRoomView(state(reviewSnapshot({ providers: crowd })), 6, copy);
  assert.equal(crowded.reviewers.length, 6);
  assert.equal(crowded.status, "working", "the one reviewing is past the desks, and still counts");
  assert.equal(crowded.note, "여기 그리지 못한 검토자 2명");
  assert.equal(
    reviewRoomView(state(reviewSnapshot({ providers: crowd.slice(0, 7) })), 6, adminAgentOfficeMessages.en.real.review).note,
    "1 more reviewer not drawn here"
  );

  const draining = reviewRoomView(state(reviewSnapshot({ draining: true })), 6, copy);
  assert.equal(draining.status, "waiting");
  assert.equal(draining.note, copy.draining);

  const never = reviewRoomView(agentOfficeReviewState({ stored: null, now: at(readAt) }), 6, copy);
  assert.equal(never.status, "waiting");
  assert.equal(never.note, copy.notReporting);
  const broken = reviewRoomView(agentOfficeReviewState({ stored: "{", now: at(readAt) }), 6, copy);
  assert.equal(broken.status, "attention");
  assert.equal(broken.note, copy.unreadable);
  assert.equal(reviewRoomView({ kind: "unread" }, 6, copy).status, "attention");

  for (const locale of ["en", "ko"]) {
    const states = adminAgentOfficeMessages[locale].real.review.states;
    for (const key of ["reviewing", "idle", "off", "lost"]) assert.ok(states[key], `${locale}: ${key}`);
  }
});

test("the status report is what the screen shows, as Markdown, copied or downloaded and sent nowhere", () => {
  const copy = adminAgentOfficeMessages.ko;
  const row = (id, status, line) => ({ id, name: id, status, badge: status, line, href: null });
  const report = agentOfficeReport(
    {
      readAt: "2026-10-09T02:13:00.000Z",
      rows: [row("qa", "attention", "Digest silent"), row("engineering", "working", "1 run active"), row("research", "done", "recorded")],
      notConnected: ["🎧 지원", "🛡️ 신뢰·안전"],
      queue: [
        { label: copy.queue.labels.marketing, count: 2 },
        { label: copy.queue.labels.amuxEscalations, count: null },
      ],
      quota: { rows: [{ id: "claude", vendor: "anthropic", status: "done", label: "사용 가능", amount: "62% 남음" }], note: null },
      unknownCount: copy.queue.unknown,
    },
    copy.report
  );
  assert.equal(
    report,
    [
      "# Tomverse 에이전트 오피스 상태 보고 · 10-09 12:13 AEST",
      "",
      "## 확인 필요 (1)",
      "- qa · attention · Digest silent",
      "",
      "## 진행 중 (1)",
      "- engineering · working · 1 run active",
      "",
      "## 조용함 (1)",
      "- research · done · recorded",
      "",
      "## 연동 대기 (2)",
      "- 🎧 지원",
      "- 🛡️ 신뢰·안전",
      "",
      "## 운영자 할 일 (2+?)",
      "- 마케팅 게시 승인: 2",
      "- AMUX 사람 확인 요청: 확인 불가",
      "",
      "## 검토 CLI quota",
      "- claude (anthropic) · 사용 가능 · 62% 남음",
      "",
      copy.report.footer,
      "",
    ].join("\n")
  );
  const empty = agentOfficeReport(
    { readAt: "2026-10-09T02:13:00.000Z", rows: [], notConnected: [], queue: [], quota: { rows: [], note: "보고 없음" }, unknownCount: "?" },
    adminAgentOfficeMessages.en.report
  );
  assert.match(empty, /## Needs a look \(0\)\n- None/);
  assert.match(empty, /## Reviewer CLI quota\n- 보고 없음/);

  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.match(panel, /data-testid="agent-office-report-copy"/);
  assert.match(panel, /data-testid="agent-office-report-download"/);
  assert.match(panel, /navigator\.clipboard\.writeText\(reportText\(\)\)/);
  // The report goes to the clipboard or a file; the page posts it nowhere.
  assert.doesNotMatch(panel, /fetch\(|sendBeacon|m\.live\.publish/);
});

test("live leads answer a greeting or a thank-you in their own voice, and never claim anything", () => {
  const live = (line) => ({ status: "done", badge: "Fresh", line, detail: "" });
  const copy = adminAgentOfficeMessages.ko;
  const office = new AgentOffice(copy, { qa: live("digest 받음"), research: live("기록됨") });
  const lead = (dept) => office.agentById.get(office.deptLead[dept].id);

  office.command("다들 수고했어요");
  const replies = office.chat.slice(-2);
  assert.deepEqual(replies.map((entry) => entry.text).sort(), [copy.real.voices.qa.thanks, copy.real.voices.research.thanks].sort());
  assert.ok(replies.every((entry) => entry.name.includes(" · ")), "each reply names its lead and room");
  // On the floor only an emoji, for a moment; then the record line is back.
  assert.equal(lead("qa").speech, "😊");
  for (let i = 0; i < 80; i += 1) office.tick(0.05);
  assert.equal(lead("qa").speech, "digest 받음");

  // A named team: only its lead answers. A question is not small talk.
  const before = office.chat.length;
  office.command("QA팀 안녕");
  assert.equal(office.chat.length, before + 2);
  assert.equal(office.chat.at(-1).text, copy.real.voices.qa.hello);
  assert.equal(lead("qa").speech, "👋");
  office.command("수고했어?");
  assert.notEqual(office.chat.at(-1).text, copy.real.voices.qa.thanks);

  // A team question is answered in the lead's voice, then with the record.
  office.command("리서치팀 뭐해?");
  assert.ok(office.chat.at(-1).text.startsWith(`${copy.real.voices.research.answer}\n`));
  assert.match(office.chat.at(-1).text, /기록됨/);

  // No voice line states a fact about a team's work: no numbers, no times, no
  // states, and no activity or promise -- the same words have to be true when
  // the room's record is silent, its switch is off or it could not be read.
  const activity = {
    en: /\b(watch\w*|gather\w*|open|polish\w*|check\w*|runs?|signals?|ledgers?|inbox|keep|I'll|won't|will)\b/i,
    ko: /지켜|모으|당번|열어|펼쳐|다듬|점검|볼게|할게|지킬|찾아|울리/,
  };
  for (const locale of ["en", "ko"]) {
    const real = adminAgentOfficeMessages[locale].real;
    for (const [dept, voice] of Object.entries({ ...real.voices, default: real.voiceDefault })) {
      for (const line of [voice.hello, voice.thanks, voice.answer]) {
        assert.doesNotMatch(line, /\d|UTC|\bdone\b|\bfailed\b|\bok\b|완료|실패|정상|없음/i, `${locale}.${dept}: ${line}`);
        assert.doesNotMatch(line, activity[locale], `${locale}.${dept} claims activity: ${line}`);
      }
    }
  }
  // A room that could not be read, or whose switch is off, is greeted the same way.
  for (const [badge, status] of [["읽지 못함", "attention"], ["스위치 꺼짐", "waiting"]]) {
    const quiet = new AgentOffice(copy, { research: { status, badge, line: "기록을 읽지 못함", detail: "" } });
    quiet.command("안녕");
    assert.equal(quiet.chat.at(-1).text, copy.real.voices.research.hello, badge);
  }
});

test("the office reads its rooms again each minute, and a room whose record changed says so", () => {
  const qa = (line, status = "done", detail = "") => ({ status, badge: "Fresh", line, detail });
  const office = new AgentOffice(adminAgentOfficeMessages.en, { qa: qa("Digest received · 10-09 10:55 AEST") });
  const said = () => office.chat.filter((entry) => entry.text.startsWith("🔔")).map((entry) => entry.text);
  // The first reading is not a change, nor is one that only moved the read time.
  office.setLive({ qa: qa("Digest received · 10-09 10:55 AEST") });
  office.setLive({ qa: qa("Digest received · 10-09 10:55 AEST", "done", "") });
  assert.deepEqual(said(), []);
  office.setLive({ qa: qa("Digest silent · last received 10-09 10:55 AEST", "attention") });
  assert.deepEqual(said(), ["🔔 QA & release · Digest silent · last received 10-09 10:55 AEST"]);
  const line = office.chat.at(-1);
  assert.equal(line.name, office.deptLead.qa.name, "the room's lead says it");
  // A console line carries the time it was said, on the operator's clock.
  assert.match(line.time, /^\d{2}:\d{2} AEST$/);

  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.match(panel, /const LIVE_REFRESH_MS = 60_000;/);
  assert.match(panel, /document\.visibilityState === "visible"\) router\.refresh\(\)/);
  assert.match(panel, /window\.clearInterval\(id\)/);
});

test("the dashboard's three windows read the live rooms, not a demo day", () => {
  const row = (id, status) => ({ id, name: id, status, badge: id, line: `${id} line`, href: null });
  const brief = agentOfficeBrief([
    row("qa", "attention"),
    row("engineering", "working"),
    row("research", "done"),
    row("amux", "blocked"),
    row("review", "waiting"),
  ]);
  assert.deepEqual(brief.attention.map((item) => item.id), ["qa", "amux"]);
  assert.deepEqual(brief.working.map((item) => item.id), ["engineering"]);
  assert.equal(brief.quiet, 2);
  assert.deepEqual(agentOfficeBrief([]), { attention: [], working: [], quiet: 0 });

  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  const dashboard = panel.slice(panel.indexOf("function DashboardView"));
  // automation.status lists the live automations, the AMUX room and the review server.
  assert.match(dashboard, /data-testid="agent-office-automation"/);
  const rowsFor = panel.slice(panel.indexOf("function liveRowsFor"), panel.indexOf("type TeamRow"));
  assert.match(rowsFor, /id: "amux",[\s\S]*href: AGENT_OFFICE_AMUX_RECORD_HREF/);
  assert.match(rowsFor, /id: "review",[\s\S]*status: reviewView\.status/);
  assert.match(rowsFor, /id: "decision",[\s\S]*status: decisionView\.status,[\s\S]*href: AGENT_OFFICE_DECISION_RECORD_HREF/);
  assert.match(dashboard, /const liveRows = liveRowsFor\(teams, amuxView, reviewView, decisionView, m\)/);
  // The brief is the live rows' brief; the record store links each live team's screen.
  assert.match(dashboard, /const brief = agentOfficeBrief\(liveRows\)/);
  assert.match(dashboard, /data-testid="agent-office-latest-record"/);
  // None of the three reads the demo day.
  assert.doesNotMatch(dashboard, /snap\.clock|snap\.phase\b|snap\.dayComplete|snap\.approvalPending|PHASE\.|m\.phases/);
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale].dashboard;
    assert.doesNotMatch(copy.boardEyebrow, /SIMULATION/);
    assert.doesNotMatch(copy.note("x", 8, 26), /simulation|시뮬레이션/i);
    assert.match(copy.storageContentNote, locale === "en" ? /own screen/ : /각 에이전트 화면/);
  }
});

test("the operator's to-do counts the real queues an agent waits on, the same sets the sidebar badges count", () => {
  assert.deepEqual(operatorQueueTotal({ marketing: 2, amuxEscalations: 1, amuxHalts: 0, autoFix: 0 }), { total: 3, unknown: false });
  assert.deepEqual(operatorQueueTotal({ marketing: null, amuxEscalations: 1, amuxHalts: 0, autoFix: 4 }), { total: 5, unknown: true });
  assert.deepEqual(operatorQueueTotal({ marketing: null, amuxEscalations: null, amuxHalts: null, autoFix: null }), { total: 0, unknown: true });

  // Every queue links to a console screen that exists, and to its tab when it names one.
  for (const key of OPERATOR_QUEUE_KEYS) {
    const href = new URL(OPERATOR_QUEUE_HREFS[key], "https://tomverse.test");
    const entry = ADMIN_NAVIGATION.find((item) => item.href === href.pathname);
    assert.ok(entry, `${key}: ${href.pathname} is not a console entry`);
    const tab = href.searchParams.get("tab");
    if (tab) assert.ok(entry.tabs?.some((item) => item.id === tab), `${key}: no tab ${tab} on ${href.pathname}`);
  }
  // Read with the badges' own count functions, each on its own.
  const queue = readFunction("readOperatorQueue");
  for (const count of ["countPendingMarketingApprovals()", "countAwaitingAmuxEscalations()", "countOpenAmuxOrchestratorHalts()", "countAutoFixActionCases()"]) {
    assert.ok(queue.includes(count), count);
  }
  assert.match(queue, /Promise\.allSettled/);
  assert.match(queue, /return null;/);
  const badges = readFileSync("lib/adminNavigationCounts.ts", "utf8");
  for (const count of ["countPendingMarketingApprovals()", "countAutoFixActionCases()", "countAwaitingAmuxEscalations()", "countOpenAmuxOrchestratorHalts()"]) {
    assert.ok(badges.includes(count), `the sidebar counts ${count} too`);
  }

  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.match(panel, /const todo = operatorQueueTotal\(live\.queue\)/);
  assert.equal((panel.match(/<OperatorQueueList m=\{m\} queue=\{queue\} \/>/g) || []).length, 2);
  // The office approves nothing: no demo approval is reachable from the page.
  assert.doesNotMatch(panel, /engine\.approve\(|approve-button|agent-office-approve"/);
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale].queue;
    for (const key of OPERATOR_QUEUE_KEYS) assert.ok(copy.labels[key], `${locale}: ${key}`);
  }
});

test("the quota card shows each reviewer's quota as the review server read it, and says how old it is", () => {
  const copy = adminAgentOfficeMessages.ko.real.quota;
  const quotaProviders = [
    { id: "claude", vendor: "anthropic", enabled: true, running: 0, maxConcurrent: 2, quota: { state: "available", remaining: 62.4, unit: "percent" } },
    { id: "codex", vendor: "openai", enabled: true, running: 1, maxConcurrent: 2, quota: { state: "available", remaining: 12, unit: "percent" } },
    { id: "cursor", vendor: "xai", enabled: true, running: 0, maxConcurrent: 2, quota: { state: "exhausted", remaining: 0, unit: "usd" } },
    { id: "copilot", vendor: "moonshot", enabled: true, running: 0, maxConcurrent: 2, quota: { state: "available", remaining: 340, unit: "credits" } },
    { id: "devin", vendor: "cognition", enabled: false, running: 0, maxConcurrent: 2, quota: { state: "disabled", remaining: null, unit: null } },
  ];
  // The app takes the quota field and refuses one no probe could produce.
  assert.equal(reviewStatusSnapshotSchema.safeParse(reviewSnapshot({ providers: quotaProviders })).success, true);
  const withQuota = (quota) =>
    reviewStatusSnapshotSchema.safeParse(reviewSnapshot({ providers: [{ ...quotaProviders[0], quota }] })).success;
  for (const bad of [
    { state: "available", remaining: 150, unit: "percent" },
    { state: "available", remaining: 5, unit: null },
    { state: "available", remaining: null, unit: "usd" },
    { state: "disabled", remaining: 5, unit: "percent" },
    { state: "available", remaining: 5, unit: "tokens" },
    { state: "full", remaining: null, unit: null },
    { state: "available", remaining: 5, unit: "percent", account: "someone@example.com" },
  ]) {
    assert.equal(withQuota(bad), false, JSON.stringify(bad));
  }
  // A server older than the field sends none, and is still a report.
  assert.equal(reviewStatusSnapshotSchema.safeParse(reviewSnapshot()).success, true);

  const stored = (providers, receivedAt = "2026-10-09T01:04:00.000Z") =>
    JSON.stringify({ receivedAt, snapshot: reviewSnapshot({ providers }) });
  const state = (providers, receivedAt) =>
    agentOfficeReviewState({ stored: stored(providers, receivedAt), now: at("2026-10-09T01:05:00.000Z") });

  const fresh = reviewQuotaView(state(quotaProviders), copy);
  assert.deepEqual(
    fresh.rows.map((row) => [row.id, row.status, row.label, row.amount]),
    [
      ["claude", "done", "사용 가능", "62% 남음"],
      ["codex", "working", "얼마 안 남음", "12% 남음"],
      ["cursor", "attention", "소진", "$0.00 남음"],
      ["copilot", "done", "사용 가능", "340 credits 남음"],
      ["devin", "waiting", "꺼짐", "—"],
    ]
  );
  assert.equal(fresh.note, "검토 서버가 직접 조회한 값 · 10-09 11:04 AEST");
  // Old numbers keep their values but are drawn grey and dated.
  const silent = reviewQuotaView(state(quotaProviders, "2026-10-09T00:58:00.000Z"), copy);
  assert.ok(silent.rows.every((row) => row.status === "waiting"));
  assert.equal(silent.rows[0].amount, "62% 남음");
  assert.equal(silent.note, "10-09 10:58 AEST 기준 · 이후 보고 없음");
  // No quota field at all: the card says the server needs the update.
  assert.deepEqual(reviewQuotaView(state(reviewSnapshot().providers), copy), { rows: [], note: copy.notSent });
  assert.deepEqual(reviewQuotaView({ kind: "not_reporting" }, copy), { rows: [], note: copy.notReporting });
  assert.deepEqual(reviewQuotaView({ kind: "unread" }, copy), { rows: [], note: copy.unread });
  for (const locale of ["en", "ko"]) {
    const c = adminAgentOfficeMessages[locale].real.quota;
    for (const key of ["available", "low", "exhausted", "unknown", "disabled"]) assert.ok(c.states[key], `${locale}: ${key}`);
  }
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.match(panel, /<QuotaCard m=\{m\} view=\{quotaView\} \/>/);
});

test("the review room has a desk for each reviewer, and the entrance stays outside it", () => {
  assert.ok(REVIEW_ROOM.desks.length >= 5);
  assert.ok(ENTRANCE_MAT.y >= REVIEW_ROOM.y + REVIEW_ROOM.h, "the entrance is drawn in the review room");
  // Reading it selects the one row the review server may write.
  const review = readFunction("readReview");
  assert.match(review, /where: \{ key: REVIEW_ORCHESTRATOR_STATUS_KEY \}/);
  assert.match(review, /select: \{ value: true \}/);
  assert.match(review, /read: "review_orchestrator"/);
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  assert.match(world, /<SeatedLayer room=\{REVIEW_ROOM\} kind="review" people=\{review\.reviewers\} onPick=\{onPickSeated\} \/>/);
});

test("a seated figure opens a profile read from its room's record, dressed as it is drawn", () => {
  // The two rooms start at different places in the palette, and a figure's
  // profile wears what its sprite wears.
  assert.deepEqual(agentOfficeSeatedClothes("amux", 0), {
    hair: AGENT_OFFICE_WORKER_COLORS[0][0],
    shirt: AGENT_OFFICE_WORKER_COLORS[0][1],
    accent: AGENT_OFFICE_WORKER_COLORS[0][2],
    skin: AGENT_OFFICE_WORKER_SKINS[0],
  });
  assert.equal(agentOfficeSeatedClothes("review", 0).shirt, AGENT_OFFICE_WORKER_COLORS[3][1]);
  assert.equal(
    agentOfficeSeatedClothes("amux", AGENT_OFFICE_WORKER_COLORS.length).hair,
    AGENT_OFFICE_WORKER_COLORS[0][0],
    "the palette wraps"
  );
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  assert.match(world, /agentOfficeSeatedClothes\(kind, i\)/);
  assert.doesNotMatch(world, /AGENT_OFFICE_WORKER_COLORS|AGENT_OFFICE_WORKER_SKINS/);

  // The profile is looked up by name in the room's current view, so it follows
  // the minute refresh, and it offers nothing an engine agent's does: no task,
  // no line, no "ask".
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  const modal = panel.slice(panel.indexOf("function SeatedProfileModal"), panel.indexOf("function liveRowsFor"));
  assert.match(
    modal,
    /seated\.room === "amux" \? amuxView\.workers : seated\.room === "review" \? reviewView\.reviewers : decisionView\.members/
  );
  assert.match(modal, /findIndex\(\(person\) => person\.name === seated\.name\)/);
  assert.match(modal, /agentOfficeSeatedClothes\(seated\.room, desk >= 0 \? desk : Math\.max\(openedDesk, 0\)\)/);
  assert.match(modal, /const \[openedDesk\] = useState\(desk\);/);
  assert.match(modal, /quotaView\.rows\.find\(\(row\) => row\.id === seated\.name\)/);
  assert.match(modal, /m\.profile\.seatedGone/);
  assert.match(modal, /useOfficeDialog\(onClose, closeRef\)/);
  assert.match(modal, /aria-modal="true"/);
  assert.doesNotMatch(modal, /engine|onAsk|m\.profile\.ask|taskLabel|speech/);
  // Only the AMUX room and the Decision Maker have a record screen; a reviewer's lives on the review server.
  assert.match(
    modal,
    /seated\.room === "amux" \? AGENT_OFFICE_AMUX_RECORD_HREF : seated\.room === "decision" \? AGENT_OFFICE_DECISION_RECORD_HREF : null/
  );
  assert.match(panel, /onSelectSeated=\{onSelectSeated\}/);

  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.ok(copy.profile.seatedQuota && copy.profile.seatedGone);
    assert.deepEqual(Object.keys(copy.real.amux.facts), ["provider", "state", "heartbeat"]);
    assert.deepEqual(Object.keys(copy.real.review.facts), ["vendor", "state", "load", "lastReport"]);
  }
});

test("a record that needs a look is counted on its own, never as a decision", () => {
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.doesNotMatch(panel, /stats\.approval/);
  assert.match(panel, /m\.dashboard\.metricAttention/);
  assert.match(panel, /m\.live\.attention\(snap\.stats\.attention\)/);
  // The operator's to-do is the real queues, not a room status.
  assert.match(panel, /<strong>\{todo\.unknown \? `\$\{todo\.total\}\+\?` : todo\.total\}<\/strong>/);
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

test("a reviewer on credit says so, with the credit beside the spent pool", () => {
  const copy = adminAgentOfficeMessages.ko.real.quota;
  const cursor = (quota) => ({ id: "cursor", vendor: "xai", enabled: true, running: 0, maxConcurrent: 2, quota });
  // The app takes an optional credit, only on a quota that was read.
  const parses = (quota) => reviewStatusSnapshotSchema.safeParse(reviewSnapshot({ providers: [cursor(quota)] })).success;
  assert.equal(parses({ state: "available", remaining: 0, unit: "percent", credit: 100 }), true);
  assert.equal(parses({ state: "available", remaining: 0, unit: "percent", credit: -1 }), false);
  assert.equal(parses({ state: "unknown", remaining: null, unit: null, credit: 5 }), false);
  assert.equal(parses({ state: "available", remaining: 0, unit: "percent", credit: "100" }), false);

  const view = (quota) =>
    reviewQuotaView(
      agentOfficeReviewState({
        stored: JSON.stringify({ receivedAt: "2026-10-09T01:04:00.000Z", snapshot: reviewSnapshot({ providers: [cursor(quota)] }) }),
        now: at("2026-10-09T01:05:00.000Z"),
      }),
      copy
    ).rows[0];
  const onCredit = view({ state: "available", remaining: 0, unit: "percent", credit: 100 });
  assert.deepEqual([onCredit.status, onCredit.label, onCredit.amount], ["working", "크레딧 사용", "0% 남음 · 크레딧 $100.00"]);
  const spent = view({ state: "exhausted", remaining: 0, unit: "percent", credit: 0 });
  assert.deepEqual([spent.status, spent.label, spent.amount], ["attention", "소진", "0% 남음 · 크레딧 $0.00"]);
  const plenty = view({ state: "available", remaining: 70, unit: "percent", credit: 25.5 });
  assert.deepEqual([plenty.status, plenty.label, plenty.amount], ["done", "사용 가능", "70% 남음 · 크레딧 $25.50"]);
  // Without a credit reading the card reads as before.
  assert.equal(view({ state: "available", remaining: 12, unit: "percent" }).label, "얼마 안 남음");
  // An amount-shaped pool that is empty reads the same way as a spent share.
  const usdSpent = view({ state: "available", remaining: 0, unit: "usd", credit: 100 });
  assert.deepEqual([usdSpent.status, usdSpent.label, usdSpent.amount], ["working", "크레딧 사용", "$0.00 남음 · 크레딧 $100.00"]);
  assert.equal(view({ state: "available", remaining: 4, unit: "usd" }).label, "사용 가능");
  // Judged on what the card shows: $0.004 reads "$0.00 left", so it is low, not plenty.
  assert.equal(view({ state: "available", remaining: 0.004, unit: "usd" }).label, "얼마 안 남음");
  assert.equal(view({ state: "available", remaining: 0.4, unit: "credits" }).label, "얼마 안 남음", "shown as 0 credits");
  assert.equal(view({ state: "available", remaining: 0.6, unit: "credits" }).label, "사용 가능", "shown as 1 credit");
  // Credit with no pool amount stands on its own, without a dangling separator.
  assert.equal(view({ state: "available", remaining: null, unit: null, credit: 50 }).amount, "크레딧 $50.00");
  assert.equal(adminAgentOfficeMessages.en.real.quota.creditOnly("50.00"), "$50.00 credit");
  for (const locale of ["en", "ko"]) assert.ok(adminAgentOfficeMessages[locale].real.quota.states.onCredit);
});

test("every time the office draws is Brisbane time, the operator's own", async () => {
  const { aestStamp, aestClock, brisbaneIso } = await import("../lib/agentOffice/time.ts");
  // UTC+10 all year: Queensland keeps no daylight saving, so January and July agree.
  assert.equal(aestStamp("2026-01-15T03:00:00.000Z"), "01-15 13:00 AEST");
  assert.equal(aestStamp("2026-07-15T03:00:00.000Z"), "07-15 13:00 AEST");
  // The date turns over with Brisbane's midnight, not Greenwich's.
  assert.equal(aestStamp("2026-10-09T14:30:00.000Z"), "10-10 00:30 AEST");
  assert.equal(aestStamp("2026-12-31T20:00:00.000Z"), "01-01 06:00 AEST");
  assert.equal(aestClock("2026-10-09T14:30:00.000Z"), "00:30 AEST");
  assert.equal(brisbaneIso("2026-10-09T14:30:00.000Z"), "2026-10-10T00:30:00.000Z");
  // A broken instant is drawn as a dash, never as a guessed time or a thrown render.
  assert.equal(aestStamp("not a time"), "—");
  assert.equal(aestClock(""), "—");
  assert.equal(brisbaneIso("not a time"), null);

  // No drawn time is left in UTC: the records keep UTC, the screen does not.
  for (const file of ["lib/agentOffice/live.ts", "lib/agentOffice/sim.ts", "components/admin/AgentOfficePanel.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /utcStamp|\} UTC`|" UTC"/, file);
  }
});

test("the office has no lounge: nobody can be in it, so nothing is drawn or said about it", () => {
  assert.deepEqual(
    ROOMS.map((room) => room.kind).filter((kind) => !["dept", "operator", "decision", "amux", "review"].includes(kind)),
    []
  );
  assert.ok(!PROPS.some((prop) => prop.kind === "sofa" || prop.kind === "coffee"));
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.equal(copy.rooms.lounge, undefined);
    assert.equal(copy.sim.coffee, undefined);
    assert.equal(copy.sim.delayAway, undefined);
    assert.equal(copy.agentStatus.onBreak, undefined);
    assert.doesNotMatch(JSON.stringify(copy, (key, value) => (typeof value === "function" ? value(2, "x", "y") : value)), /lounge|라운지/i);
  }
  const css = readFileSync("components/admin/agentOffice.module.css", "utf8");
  assert.doesNotMatch(css, /lounge|pr-sofa|pr-coffee/);
});

// ── Decision Maker ────────────────────────────────────────────────────────

const dmSwitches = (overrides = {}) => ({
  killSwitch: false,
  instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "off" },
  ...overrides,
});

test("the Decision Maker room's state is its switches and its ledger's counts, never its content", () => {
  const state = agentOfficeDecisionState({
    switches: dmSwitches(),
    recent: [
      { route: "dm_proposal", instance: "decision-maker-openai", count: 3 },
      { route: "operator", instance: null, count: 2 },
      { route: "operator", instance: "decision-maker-anthropic", count: 1 },
    ],
    latest: [
      { route: "dm_proposal", instance: "decision-maker-openai", lastAt: at("2026-10-09T23:00:00Z") },
      { route: "operator", instance: null, lastAt: at("2026-10-10T00:30:00Z") },
    ],
    judgments: [{ instance: "decision-maker-openai", lastAt: at("2026-10-09T23:40:00Z") }],
  });
  assert.deepEqual(state, {
    kind: "observed",
    killSwitch: false,
    instances: [
      {
        instance: "decision-maker-openai",
        vendor: "openai",
        mode: "proposal",
        recent: 3,
        lastRoutedAt: "2026-10-09T23:00:00.000Z",
        lastJudgedAt: "2026-10-09T23:40:00.000Z",
      },
      {
        instance: "decision-maker-anthropic",
        vendor: "anthropic",
        mode: "off",
        recent: 0,
        lastRoutedAt: null,
        lastJudgedAt: null,
      },
    ],
    // A question sent to the operator counts there whatever instance it would have had.
    toOperator: 3,
  });
  assert.equal(AGENT_OFFICE_DECISION_WINDOW_MS, 24 * 60 * 60 * 1000);

  // The read selects counts and times through Prisma's aggregates, and the
  // switches through the Decision Maker's own reader; nothing else of the ledger.
  const decision = readFunction("readDecision");
  assert.match(decision, /readDecisionMakerSwitchesOrThrow\(prisma\)/);
  assert.match(decision, /amuxDecisionMakerRequest\.groupBy\(\{\s*by: \["route", "instance"\],\s*where: \{ createdAt: \{ gte: since \} \},\s*_count: \{ _all: true \},\s*\}\)/);
  assert.match(decision, /amuxDecisionMakerRequest\.groupBy\(\{ by: \["route", "instance"\], _max: \{ createdAt: true \} \}\)/);
  assert.match(decision, /amuxDecisionMakerJudgment\.groupBy\(\{ by: \["instance"\], _max: \{ createdAt: true \} \}\)/);
  assert.doesNotMatch(decision, /findMany|findFirst|findUnique|select:|cardId|Digest|actorUserId|body/i);
  assert.match(decision, /read: "decision_maker"/);
  const page = readFileSync("lib/agentOfficeLiveRead.ts", "utf8");
  assert.match(page, /readDecision\(now\),/);
});

test("the Decision Maker room says where questions go, in Brisbane time, and an unread switch needs a look", () => {
  const copy = adminAgentOfficeMessages.ko.real.decision;
  const observed = (switches, overrides = {}) => ({
    kind: "observed",
    killSwitch: switches.killSwitch,
    instances: [
      {
        instance: "decision-maker-openai",
        vendor: "openai",
        mode: switches.instances["decision-maker-openai"],
        recent: 3,
        lastRoutedAt: "2026-10-09T23:00:00.000Z",
        lastJudgedAt: null,
      },
      {
        instance: "decision-maker-anthropic",
        vendor: "anthropic",
        mode: switches.instances["decision-maker-anthropic"],
        recent: 0,
        lastRoutedAt: null,
        lastJudgedAt: null,
      },
    ],
    toOperator: 2,
    ...overrides,
  });

  const live = decisionRoomView(observed(dmSwitches()), copy);
  assert.equal(live.status, "done");
  assert.equal(live.note, null);
  assert.equal(live.summary, "제안 모드 1/2 · 최근 24시간 Decision Maker 3건 · 운영자 2건");
  assert.deepEqual(
    live.members.map((member) => [member.name, member.state, member.status, member.label, member.dim]),
    [
      ["decision-maker-openai", "proposal", "done", "제안 모드", false],
      ["decision-maker-anthropic", "off", "waiting", "꺼짐", true],
    ]
  );
  assert.deepEqual(live.members[0].facts, [
    { label: "공급사", value: "openai" },
    { label: "모드", value: "제안 모드" },
    { label: "최근 24시간 배정", value: "3" },
    { label: "마지막 배정", value: "10-10 09:00 AEST" },
    { label: "마지막 운영자 판단", value: "아직 없음" },
  ]);

  // The kill switch sends everything to the operator, whatever the instances say.
  const killed = decisionRoomView(observed(dmSwitches({ killSwitch: true })), copy);
  assert.equal(killed.status, "waiting");
  assert.equal(killed.note, copy.killed);
  assert.ok(killed.members.every((member) => member.state === "killed" && member.dim));
  assert.match(killed.summary, /^kill switch 켜짐/);

  const allOff = decisionRoomView(
    observed(dmSwitches({ instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "off" } })),
    copy
  );
  assert.equal(allOff.status, "waiting");
  assert.equal(allOff.note, copy.allOff);

  // An unreadable switch is not "off": it needs a look, and the room says where questions go.
  const unreadable = decisionRoomView(
    observed({ killSwitch: null, instances: { "decision-maker-openai": null, "decision-maker-anthropic": null } }),
    copy
  );
  assert.equal(unreadable.status, "attention");
  assert.equal(unreadable.note, copy.unreadable);
  assert.ok(unreadable.members.every((member) => member.state === "unread" && member.status === "attention"));

  const unread = decisionRoomView({ kind: "unread" }, copy);
  assert.deepEqual(unread, {
    status: "attention",
    summary: "Decision Maker 기록을 읽지 못함",
    note: copy.unread,
    members: [],
  });
});

test("the approval room is now the Decision Maker room, drawn from its record", () => {
  assert.equal(DECISION_ROOM.kind, "decision");
  assert.equal(DECISION_ROOM.desks.length, 2, "one desk for each instance");
  for (const desk of DECISION_ROOM.desks) {
    assert.ok(desk.seat.x > DECISION_ROOM.x && desk.seat.x < DECISION_ROOM.x + DECISION_ROOM.w - 1, "a desk outside the room");
    assert.ok(desk.seat.y > DECISION_ROOM.y && desk.seat.y < DECISION_ROOM.y + DECISION_ROOM.h - 1, "a desk outside the room");
  }
  assert.ok(!ROOMS.some((room) => room.kind === "meeting"));
  const world = readFileSync("components/admin/AgentOfficeWorld.tsx", "utf8");
  assert.match(
    world,
    /<SeatedLayer room=\{DECISION_ROOM\} kind="decision" people=\{decision\.members\} onPick=\{onPickSeated\} \/>/
  );
  assert.match(world, /const real = isAmux \? amux : isReview \? review : isDecision \? decision : null;/);
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    assert.equal(copy.rooms.meeting, undefined);
    assert.ok(copy.rooms.decision && copy.rooms.decisionRecord);
    assert.deepEqual(Object.keys(copy.real.decision.facts), ["vendor", "mode", "recent", "lastRouted", "lastJudged"]);
    // It promises nothing a proposal-only Decision Maker does not do.
    assert.doesNotMatch(JSON.stringify(copy.real.decision, (key, value) => (typeof value === "function" ? value(1, 2, 3, 4) : value)), /approv|승인|decides|결정합니다/i);
  }
});

// ── Digest desk ───────────────────────────────────────────────────────────

test("the digest desk counts each agent's digests and names the newest, never their content", () => {
  const state = agentOfficeDigestState({
    recent: [
      { agentKey: "qa-release", count: 2 },
      { agentKey: "billing-finance-ops", count: 1 },
    ],
    latest: [
      { agentKey: "qa-release", lastAt: at("2026-10-09T21:00:00Z") },
      { agentKey: "billing-finance-ops", lastAt: at("2026-10-09T23:30:00Z") },
    ],
  });
  assert.deepEqual(state, {
    kind: "observed",
    agents: [
      { agentKey: "qa-release", recent: 2, lastAt: "2026-10-09T21:00:00.000Z" },
      { agentKey: "billing-finance-ops", recent: 1, lastAt: "2026-10-09T23:30:00.000Z" },
      // An agent that has never sent one is still listed, at zero.
      { agentKey: "sre-ops", recent: 0, lastAt: null },
    ],
  });
  assert.equal(AGENT_OFFICE_DIGEST_WINDOW_MS, 24 * 60 * 60 * 1000);
  // Every sender the store accepts has a room to be named by.
  assert.deepEqual(Object.keys(AGENT_OFFICE_DIGEST_SENDERS).sort(), [...AGENT_DIGEST_AGENT_KEYS].sort());

  const copy = adminAgentOfficeMessages.ko.real.digest;
  const names = Object.fromEntries(
    Object.entries(AGENT_OFFICE_DIGEST_SENDERS).map(([key, dept]) => [key, adminAgentOfficeMessages.ko.depts[dept].name])
  );
  const desk = digestLiveDept(state, copy, names);
  assert.equal(desk.status, "done");
  assert.equal(desk.badge, "수신 중");
  assert.equal(desk.line, `최근 digest · ${names["billing-finance-ops"]} · 10-10 09:30 AEST`);
  assert.equal(
    desk.detail,
    `${names["qa-release"]} 24시간 2건 · ${names["billing-finance-ops"]} 24시간 1건 · ${names["sre-ops"]} 24시간 0건`
  );
  // Nothing in 24 hours is quiet, not a fault: an agent's lateness is its own room's call.
  const quiet = digestLiveDept(
    { kind: "observed", agents: state.agents.map((agent) => ({ ...agent, recent: 0 })) },
    copy,
    names
  );
  assert.equal(quiet.status, "waiting");
  assert.equal(quiet.badge, "24시간 수신 없음");
  assert.equal(quiet.line, desk.line, "the newest digest is still named");
  const never = digestLiveDept(agentOfficeDigestState({ recent: [], latest: [] }), copy, names);
  assert.equal(never.line, "아직 받은 digest 없음");
  assert.deepEqual(digestLiveDept({ kind: "unread" }, copy, names), {
    status: "attention",
    badge: "읽기 실패",
    line: "digest를 읽지 못함",
    detail: "",
  });

  // A new digest changes the line, so the desk's lead announces it once.
  const office = new AgentOffice(adminAgentOfficeMessages.ko, { digest: desk });
  const said = () => office.snapshot().chat.filter((line) => line.text.startsWith("🔔")).map((line) => line.text);
  office.setLive({ digest: { ...desk, detail: "" } });
  assert.deepEqual(said(), [], "a new read time alone is not news");
  const next = digestLiveDept(
    agentOfficeDigestState({
      recent: [{ agentKey: "sre-ops", count: 1 }],
      latest: [{ agentKey: "sre-ops", lastAt: at("2026-10-10T01:10:00Z") }],
    }),
    copy,
    names
  );
  office.setLive({ digest: next });
  assert.deepEqual(said(), [`🔔 ${office.roomName("digest")} · 최근 digest · ${names["sre-ops"]} · 10-10 11:10 AEST`]);
  // A second digest from the same sender in the same minute draws the same
  // line, status and badge; its revision still tells it apart.
  const sameMinute = digestLiveDept(
    agentOfficeDigestState({
      recent: [{ agentKey: "sre-ops", count: 2 }],
      latest: [{ agentKey: "sre-ops", lastAt: at("2026-10-10T01:10:40Z") }],
    }),
    copy,
    names
  );
  assert.equal(sameMinute.line, next.line);
  assert.notEqual(sameMinute.revision, next.revision);
  office.setLive({ digest: sameMinute });
  assert.equal(said().length, 2, "the same-minute digest is announced");
  office.setLive({ digest: { ...sameMinute, detail: "" } });
  assert.equal(said().length, 2, "a re-read of the same digests is not");

  // The read selects counts and times only.
  const digest = readFunction("readDigest");
  assert.match(digest, /agentDigestItem\.groupBy\(\{ by: \["agentKey"\], where: \{ createdAt: \{ gte: since \} \}, _count: \{ _all: true \} \}\)/);
  assert.match(digest, /agentDigestItem\.groupBy\(\{ by: \["agentKey"\], _max: \{ createdAt: true \} \}\)/);
  assert.doesNotMatch(digest, /payload|"kind"|kind: true|idempotencyKey|findMany|select:/);
  assert.match(digest, /read: "agent_digests"/);
  assert.match(readFileSync("lib/agentOfficeLiveRead.ts", "utf8"), /readDigest\(now\),/);
  // The desk is a live room in the panel, linked to the digest screen through its roster entry.
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  assert.match(panel, /digest: digestLiveDept\(\s*live\.digest,/);
  assert.equal(AGENT_OFFICE_DECLARED_RECORD_HREFS.digest, "/admin/agent-digests");
});

test("the screen says how fresh it is in one place, and says so when it stops refreshing", () => {
  for (const locale of ["en", "ko"]) {
    const copy = adminAgentOfficeMessages[locale];
    // No room copy carries a read time: every room was read at the same moment.
    for (const [room, block] of Object.entries(copy.real)) {
      if (block && typeof block === "object") assert.equal(block.readAt, undefined, `${locale} ${room}`);
    }
    assert.equal(copy.dashboard.briefAsOf, undefined);
    assert.ok(copy.live.stale);
  }
  assert.equal(adminAgentOfficeMessages.ko.live.clockReal, "마지막 갱신");
  const panel = readFileSync("components/admin/AgentOfficePanel.tsx", "utf8");
  // Two missed re-reads before it says so; the first render starts the clock
  // at the reading itself, so server and client agree.
  assert.match(panel, /export const LIVE_STALE_MS = 2 \* LIVE_REFRESH_MS;/);
  assert.match(panel, /const \[now, setNow\] = useState\(readMs\);/);
  assert.match(panel, /data-testid="agent-office-stale"/);
  // Coming back to the tab reads again at once instead of showing a stale screen.
  assert.match(panel, /addEventListener\("visibilitychange", onVisible\)/);
  const live = readFileSync("lib/agentOffice/live.ts", "utf8");
  assert.doesNotMatch(live, /copy\.readAt|readAt: string,\n\s*copy/);
});
