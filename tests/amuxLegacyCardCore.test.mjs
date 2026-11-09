import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxIdeaInput, AMUX_IDEA_INPUT_MAX_BYTES } from "../lib/amux/ideaInputCore.ts";
import { amuxIdeaTitleFromText } from "../lib/amux/ideaTitleCore.ts";
import { isAmuxIdeaRequestId } from "../lib/amux/ideaRequestIdCore.ts";
import {
  amuxFirstSentence,
  amuxLegacyCardCloseRefusal,
  amuxLegacyCardIdeaText,
  amuxLegacyCardRecreateRequestId,
  amuxLegacyCardKind,
  isAmuxRecoveryInspectableCard,
  isAmuxV22RecoverableTask,
} from "../lib/amux/legacyCardCore.ts";

const card = (description, extra = {}) => ({ id: "cmlegacy0001", displayKey: "AMUX-WORKBOARD-061",
  description, executionBrief: null, ...extra });

const inspect = (text) =>
  inspectAmuxIdeaInput(JSON.stringify({ version: 1, idea: text, repositories: [], pullRequests: [] }));

const v4Task = (over = {}) => ({ sourceSystem: "admin-idea-v4", cardType: "task", status: "blocked",
  v22ReceiptId: null, taskRole: "investigate", executionGrade: null,
  lastAttempt: { endedAt: "2026-10-12T00:00:00.000Z", outcome: "expired", reason: "execution_lease_expired" }, ...over });

test("a workboard import and a pre-v22 Task with an unknown outcome are the cards the owner can only remake", () => {
  assert.equal(amuxLegacyCardKind({ ...v4Task(), sourceSystem: "tomverse_private_workboard", cardType: null }),
    "workboard");
  // AMUX-GITHUB-002's shape: a v4 Task with no v22 receipt, stopped after a lost run.
  assert.equal(amuxLegacyCardKind(v4Task()), "pre_v22_task");
  assert.equal(amuxLegacyCardKind(v4Task({ status: "review", lastAttempt: null })), "pre_v22_task");
  assert.equal(amuxLegacyCardKind(v4Task({ lastAttempt: { endedAt: "x", outcome: "failed",
    reason: "usage_outcome_unknown" } })), "pre_v22_task");
  // An open run is still a candidate; the close refuses it as running.
  assert.equal(amuxLegacyCardKind(v4Task({ lastAttempt: { endedAt: null, outcome: null, reason: null } })),
    "pre_v22_task");
  for (const card of [
    // The Ubuntu inspection takes it: the v22 recovery path decides.
    v4Task({ v22ReceiptId: "r", taskRole: "implement", executionGrade: "advanced" }),
    // A known outcome or a lane that is not stopped is not stuck.
    v4Task({ lastAttempt: { endedAt: "x", outcome: "succeeded", reason: "reported_result" } }),
    v4Task({ status: "todo" }), v4Task({ status: "done" }),
    v4Task({ cardType: "story" }), v4Task({ sourceSystem: "local-agent-intake" }), v4Task({ sourceSystem: null }),
  ]) assert.equal(amuxLegacyCardKind(card), null);
  // Missing any one of the three keeps a Task out of the v22 recovery path.
  for (const missing of ["v22ReceiptId", "taskRole", "executionGrade"]) {
    const full = v4Task({ v22ReceiptId: "r", taskRole: "implement", executionGrade: "advanced" });
    assert.equal(isAmuxV22RecoverableTask({ ...full, [missing]: null }), false);
    assert.equal(amuxLegacyCardKind({ ...full, [missing]: null }), "pre_v22_task");
  }
});

test("only a v4 Task is inspectable", () => {
  assert.equal(isAmuxRecoveryInspectableCard({ sourceSystem: "admin-idea-v4", cardType: "task" }), true);
  for (const value of [
    { sourceSystem: "admin-idea-v4", cardType: "story" },
    { sourceSystem: "tomverse_private_workboard", cardType: null },
    { sourceSystem: "tomverse_private_workboard", cardType: "task" },
    { sourceSystem: null, cardType: null },
  ]) assert.equal(isAmuxRecoveryInspectableCard(value), false);
});

test("a pre-v22 investigation keeps its nature in the remade idea", () => {
  const built = amuxLegacyCardIdeaText({ ...card(JSON.stringify({ problem: "Can the PR check be reused? Look first.",
    scopeIn: ["Read the excerpt code"], scopeOut: ["Change code"], completionCriteria: ["A report"] })),
  displayKey: "AMUX-GITHUB-002", kind: "pre_v22_task", taskRole: "investigate" });
  assert.equal(built.ok && built.title, "Can the PR check be reused?");
  const text = built.ok ? built.text : "";
  assert.ok(text.startsWith("Can the PR check be reused?\n\n작업 성격: 조사 (코드 수정이 아닌 작업"));
  assert.ok(text.includes("원래 카드: AMUX-GITHUB-002 (v22 이전에 만든 Task를"));
  const implement = amuxLegacyCardIdeaText({ ...card(JSON.stringify({ problem: "Build it." })),
    kind: "pre_v22_task", taskRole: "implement" });
  assert.ok((implement.ok ? implement.text : "").includes("작업 성격: 구현\n"));
  assert.doesNotMatch(implement.ok ? implement.text : "", /코드 수정이 아닌/);
  assert.equal(inspect(built.ok ? built.text : "").ok, true);
});

test("the idea opens with the problem's first sentence as a readable title", () => {
  const built = amuxLegacyCardIdeaText(card(JSON.stringify({
    problem: "The billing page hides the renewal date. Users ask support for it every week.",
    scope: { scopeIn: ["Show the date on the plan card"], scopeOut: ["Change pricing"] },
    completionCriteria: ["The date shows in en and ko", "A render test covers it"],
  })));
  assert.equal(built.ok, true);
  assert.equal(built.title, "The billing page hides the renewal date.");
  assert.equal(amuxIdeaTitleFromText(built.text), "The billing page hides the renewal date.");
  assert.match(built.text, /완료 기준:\n- The date shows in en and ko\n- A render test covers it/);
  assert.match(built.text, /할 일:\n- Show the date on the plan card/);
  assert.match(built.text, /하지 않을 일:\n- Change pricing/);
  assert.match(built.text, /원래 카드: AMUX-WORKBOARD-061/);
  assert.equal(built.truncated, false);
  assert.equal(inspect(built.text).ok, true);
});

test("Korean sentence ends, a missing problem and plain text still give a title", () => {
  assert.equal(amuxFirstSentence("결제 화면이 깨집니다. 모바일에서만"), "결제 화면이 깨집니다.");
  assert.equal(amuxFirstSentence("  no stop here  \n next"), "no stop here next");
  const noProblem = amuxLegacyCardIdeaText(card(JSON.stringify({ completionCriteria: ["Ship the export button."] })));
  assert.equal(noProblem.ok && noProblem.title, "Ship the export button.");
  const plain = amuxLegacyCardIdeaText(card("\n\nFix the empty state on the inbox\nmore detail"));
  assert.equal(plain.ok && plain.title, "Fix the empty state on the inbox");
  assert.match(plain.ok ? plain.text : "", /more detail/);
  // The title keeps one sentence; the rest of that first line stays in the body.
  const several = amuxLegacyCardIdeaText(card("Add export. Include CSV and JSON.\nKeep the old button."));
  assert.equal(several.ok && several.title, "Add export.");
  assert.match(several.ok ? several.text : "", /Add export\. Include CSV and JSON\.\nKeep the old button\./);
});

test("no assigned work refuses; an approved brief is carried along", () => {
  assert.deepEqual(amuxLegacyCardIdeaText(card(null)), { ok: false, code: "no_assigned_work" });
  assert.deepEqual(amuxLegacyCardIdeaText(card("   ")), { ok: false, code: "no_assigned_work" });
  assert.deepEqual(amuxLegacyCardIdeaText(card(JSON.stringify({ problem: "" }))),
    { ok: false, code: "no_assigned_work" });
  const withBrief = amuxLegacyCardIdeaText(card(JSON.stringify({ problem: "Do X." }),
    { executionBrief: "Keep the API stable." }));
  assert.match(withBrief.ok ? withBrief.text : "", /승인된 실행 브리프:\nKeep the API stable\./);
});

test("a card whose only readable work is its approved brief is remade from the brief under its title", () => {
  const brief = "Keep the starter guidance sentence visible on the first screen. Do not move the composer.";
  const titled = amuxLegacyCardIdeaText(card(null, { executionBrief: brief, title: "Starter guidance stays visible" }));
  assert.equal(titled.ok && titled.title, "Starter guidance stays visible");
  assert.match(titled.ok ? titled.text : "", /^Starter guidance stays visible\n\n승인된 실행 브리프:\nKeep the starter/);
  assert.match(titled.ok ? titled.text : "", /원래 카드: AMUX-WORKBOARD-061/);
  assert.equal(inspect(titled.ok ? titled.text : "").ok, true);
  // Without a title, the brief's first sentence is the title.
  const untitled = amuxLegacyCardIdeaText(card("  ", { executionBrief: brief }));
  assert.equal(untitled.ok && untitled.title, "Keep the starter guidance sentence visible on the first screen.");
  // Neither work nor brief still refuses, whatever the title.
  assert.deepEqual(amuxLegacyCardIdeaText(card(null, { title: "Only a title" })),
    { ok: false, code: "no_assigned_work" });
});

test("an over-long card keeps its head within the idea limit and still passes the gate", () => {
  const long = "가".repeat(5_000);
  const built = amuxLegacyCardIdeaText(card(JSON.stringify({ problem: `Long work. ${long}` })));
  assert.equal(built.ok, true);
  assert.equal(built.truncated, true);
  assert.ok(Buffer.byteLength(built.text, "utf8") <= AMUX_IDEA_INPUT_MAX_BYTES);
  assert.match(built.text, /…\n\n원래 카드: AMUX-WORKBOARD-061/);
  assert.equal(inspect(built.text).ok, true);
});

test("content the idea gate refuses stays refused", () => {
  const built = amuxLegacyCardIdeaText(card(JSON.stringify({ problem: "Mail the result to someone@example.com when done." })));
  assert.equal(built.ok, true);
  assert.equal(inspect(built.text).ok, false);
});

test("the recreate request id is a stable v4 UUID per card and idea text", () => {
  const a = amuxLegacyCardRecreateRequestId("cmlegacy0001", "Do X.");
  assert.equal(a, amuxLegacyCardRecreateRequestId("cmlegacy0001", "Do X."));
  assert.notEqual(a, amuxLegacyCardRecreateRequestId("cmlegacy0002", "Do X."));
  // A card whose assigned work changed saves the new text, not the old idea read back.
  assert.notEqual(a, amuxLegacyCardRecreateRequestId("cmlegacy0001", "Do Y."));
  assert.equal(isAmuxIdeaRequestId(a), true);
});

test("a close refuses a running, closed, changed or non-legacy card", () => {
  const base = { ...v4Task(), sourceSystem: "tomverse_private_workboard", archivedAt: null, revision: 3,
    status: "review", activeDelivery: false, liveAttempt: false, openEscalation: false };
  assert.equal(amuxLegacyCardCloseRefusal(base, 3), null);
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, status: "blocked" }, 3), null);
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, sourceSystem: "admin-idea-v4" }, 3), null);
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, sourceSystem: "admin-idea-v4", v22ReceiptId: "r",
    executionGrade: "advanced" }, 3), "not_legacy");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, sourceSystem: "local-agent-intake" }, 3), "not_legacy");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, archivedAt: new Date() }, 3), "already_closed");
  // An archived card still in the owner queue closes: only its escalation is resolved.
  const archivedOpen = { ...base, archivedAt: new Date(), openEscalation: true };
  assert.equal(amuxLegacyCardCloseRefusal(archivedOpen, 3), null);
  assert.equal(amuxLegacyCardCloseRefusal(archivedOpen, 2), "changed");
  assert.equal(amuxLegacyCardCloseRefusal({ ...archivedOpen, activeDelivery: true }, 3), "running");
  assert.equal(amuxLegacyCardCloseRefusal({ ...archivedOpen, sourceSystem: "local-agent-intake" }, 3), "not_legacy");
  assert.equal(amuxLegacyCardCloseRefusal(base, 2), "changed");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, activeDelivery: true }, 3), "running");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, liveAttempt: true }, 3), "running");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, status: "doing" }, 3), "running");
});
