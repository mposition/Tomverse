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
  isAmuxLegacyWorkboardCard,
  isAmuxRecoveryInspectableCard,
} from "../lib/amux/legacyCardCore.ts";

const card = (description, extra = {}) => ({ id: "cmlegacy0001", displayKey: "AMUX-WORKBOARD-061",
  description, executionBrief: null, ...extra });

const inspect = (text) =>
  inspectAmuxIdeaInput(JSON.stringify({ version: 1, idea: text, repositories: [], pullRequests: [] }));

test("only a workboard import is a legacy card; only a v4 Task is inspectable", () => {
  assert.equal(isAmuxLegacyWorkboardCard({ sourceSystem: "tomverse_private_workboard" }), true);
  for (const sourceSystem of ["admin-idea-v4", "local-agent-intake", null]) {
    assert.equal(isAmuxLegacyWorkboardCard({ sourceSystem }), false);
  }
  assert.equal(isAmuxRecoveryInspectableCard({ sourceSystem: "admin-idea-v4", cardType: "task" }), true);
  for (const value of [
    { sourceSystem: "admin-idea-v4", cardType: "story" },
    { sourceSystem: "tomverse_private_workboard", cardType: null },
    { sourceSystem: "tomverse_private_workboard", cardType: "task" },
    { sourceSystem: null, cardType: null },
  ]) assert.equal(isAmuxRecoveryInspectableCard(value), false);
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

test("the recreate request id is a stable v4 UUID per card", () => {
  const a = amuxLegacyCardRecreateRequestId("cmlegacy0001");
  assert.equal(a, amuxLegacyCardRecreateRequestId("cmlegacy0001"));
  assert.notEqual(a, amuxLegacyCardRecreateRequestId("cmlegacy0002"));
  assert.equal(isAmuxIdeaRequestId(a), true);
});

test("a close refuses a running, closed, changed or non-legacy card", () => {
  const base = { sourceSystem: "tomverse_private_workboard", archivedAt: null, revision: 3, status: "review",
    activeDelivery: false, liveAttempt: false };
  assert.equal(amuxLegacyCardCloseRefusal(base, 3), null);
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, status: "blocked" }, 3), null);
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, sourceSystem: "admin-idea-v4" }, 3), "not_legacy");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, archivedAt: new Date() }, 3), "already_closed");
  assert.equal(amuxLegacyCardCloseRefusal(base, 2), "changed");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, activeDelivery: true }, 3), "running");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, liveAttempt: true }, 3), "running");
  assert.equal(amuxLegacyCardCloseRefusal({ ...base, status: "doing" }, 3), "running");
});
