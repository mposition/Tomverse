import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminAmuxExecutionMessages } from "../lib/adminMessages/amuxExecution.ts";
import { adminAmuxOwnerQueueMessages } from "../lib/adminMessages/amuxOwnerQueue.ts";
import { ADMIN_NAVIGATION } from "../lib/adminNavigation.ts";
import { localizeAdminTabs } from "../lib/adminNavigationLocale.ts";
import {
  AMUX_OWNER_QUEUE_GROUPS,
  amuxAestDayStartMs,
  amuxOwnerQueueGroup,
  amuxOwnerQueueGroupCounts,
  amuxOwnerQueueVisible,
  amuxOwnerQueueWhere,
} from "../lib/amux/ownerQueueCore.ts";

const read = (path) => readFileSync(path, "utf8");

const card = (taskId, over = {}) => ({
  taskId, displayKey: `AMUX-${taskId.toUpperCase()}`, sourceKey: null, title: `Card ${taskId}`, status: "blocked",
  worker: null, channel: null, attentionReason: "human_review_required", ownerQuestion: null,
  escalationId: `esc-${taskId}`, waitingSince: "2026-11-08T00:00:00.000Z", ...over,
});

test("a card is listed under the one group that says what the owner does with it", () => {
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "human_review_required", ownerQuestion: null }), "decide");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "attempt_budget_exhausted", ownerQuestion: null }), "decide");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "review_server_rejected_twice", ownerQuestion: null }), "decide");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "execution_lease_expired", ownerQuestion: null }), "recover");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "execution_blocked", ownerQuestion: null }), "recover");
  // An unknown outcome is read first; so is a card with no open reason at all.
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "usage_outcome_unknown", ownerQuestion: null }), "read");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: null, ownerQuestion: null }), "read");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: null, ownerQuestion: "answered" }), "read");
  // An open question is answered first, whatever else the card says.
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "human_review_required", ownerQuestion: "open" }), "question");
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "execution_lease_expired", ownerQuestion: "open" }), "question");
  // A reason this list does not know still asks the owner; it is never filed as something to skip.
  assert.equal(amuxOwnerQueueGroup({ attentionReason: "a_reason_added_later", ownerQuestion: null }), "decide");
  // Every reason the board names lands in a group.
  for (const reason of Object.keys(adminAmuxExecutionMessages.en.attentionReason)) {
    assert.ok(AMUX_OWNER_QUEUE_GROUPS.includes(amuxOwnerQueueGroup({ attentionReason: reason, ownerQuestion: null })), reason);
  }
});

test("every group has a count and the counts add up to the cards", () => {
  const items = [
    card("a"), card("b"), card("c", { attentionReason: "execution_lease_expired" }),
    card("d", { attentionReason: null, escalationId: null, ownerQuestion: "open" }),
    card("e", { attentionReason: "usage_outcome_unknown" }),
  ];
  const counts = amuxOwnerQueueGroupCounts(items);
  assert.deepEqual(counts, { decide: 2, question: 1, recover: 1, read: 1 });
  assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), items.length);
  assert.deepEqual(AMUX_OWNER_QUEUE_GROUPS, ["decide", "question", "recover", "read"]);
});

test("the list order is the group order, then the read's own order, and a search narrows it", () => {
  const items = [
    card("a", { attentionReason: "execution_lease_expired", worker: "worker-claude" }),
    card("b"),
    card("c", { attentionReason: null, escalationId: null, ownerQuestion: "open", title: "Image size ceiling" }),
    card("d"),
  ];
  const order = (filter) => amuxOwnerQueueVisible(items, filter).map((item) => item.taskId);
  assert.deepEqual(order({ group: null, query: "" }), ["b", "d", "c", "a"]);
  assert.deepEqual(order({ group: "decide", query: "" }), ["b", "d"]);
  assert.deepEqual(order({ group: null, query: "  IMAGE " }), ["c"]);
  assert.deepEqual(order({ group: null, query: "worker-claude" }), ["a"]);
  assert.deepEqual(order({ group: "question", query: "worker-claude" }), []);
  // A card with no title still matches by its number.
  assert.deepEqual(amuxOwnerQueueVisible([card("z", { title: null })], { group: null, query: "amux-z" }).length, 1);
});

test("the queue is the attention lane, open questions in any lane and open escalations, as one set of cards", () => {
  const where = amuxOwnerQueueWhere();
  assert.equal(where.OR.length, 3);
  const [lane, escalation, question] = where.OR;
  // The attention lane: blocked, not archived.
  assert.deepEqual(lane, { archivedAt: null, status: "blocked" });
  // An open or acknowledged escalation, on a card that is not archived: an
  // archived card is not shown even with one still open (owner decision 2026-11-09).
  assert.deepEqual(escalation, { archivedAt: null,
    humanEscalations: { some: { status: { in: ["open", "acknowledged"] } } } });
  for (const term of where.OR) assert.equal(term.archivedAt, null);
  // An open worker question, in any lane, on a card that is not archived.
  assert.deepEqual(question, { archivedAt: null, v22OwnerQuestions: { some: { state: "open" } } });
  // The lane clause of the board is the same lane the first term names.
  const lanes = read("lib/amux/adminExecutionViewCore.ts");
  assert.match(lanes, /\{ status: "blocked" \}/);
  assert.match(lanes, /humanEscalations: \{ some: \{ status: \{ in: \["open", "acknowledged"\] \} \} \}/);
});

test("today begins at midnight in Brisbane, with no daylight saving", () => {
  // 2026-11-08 03:00 UTC is 13:00 AEST; the day began at 2026-11-07 14:00 UTC.
  assert.equal(new Date(amuxAestDayStartMs(Date.parse("2026-11-08T03:00:00.000Z"))).toISOString(), "2026-11-07T14:00:00.000Z");
  // 2026-11-07 15:00 UTC is already 01:00 on the 8th in Brisbane.
  assert.equal(new Date(amuxAestDayStartMs(Date.parse("2026-11-07T15:00:00.000Z"))).toISOString(), "2026-11-07T14:00:00.000Z");
  assert.equal(new Date(amuxAestDayStartMs(Date.parse("2026-11-07T13:59:59.999Z"))).toISOString(), "2026-11-06T14:00:00.000Z");
});

test("the read is read only and says when it could not count today's work", () => {
  const source = read("lib/amux/adminOwnerQueueRead.ts");
  assert.match(source, /^import "server-only";/);
  assert.doesNotMatch(source, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction/);
  // Today's number is null (unknown) when either read fails, never 0.
  assert.match(source, /catch \{\s*return null;/);
  // The list is bounded.
  assert.match(source, /take: AMUX_OWNER_QUEUE_LIMIT/);
});

test("the route is a read for any admin role, rate limited, with no write verb", () => {
  const route = read("app/api/admin/amux/owner-queue/route.ts");
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(route, /export async function (POST|PATCH|PUT|DELETE)/);
  assert.match(route, /!session\?\.user\?\.id \|\| !isAdminSession\(session\)/);
  assert.match(route, /status: 404/);
  assert.match(route, /consumeApiRateLimit\(request, session\.user\.id, "admin-amux-owner-queue"/);
  assert.match(route, /"Cache-Control": "no-store"/);
});

test("the screen decides nothing itself: every write is the existing review and answer parts", () => {
  for (const file of ["components/admin/AmuxOwnerQueueScreen.tsx", "components/admin/AmuxOwnerQueueDecision.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /method:\s*"(POST|PATCH|PUT|DELETE)"/, file);
    assert.doesNotMatch(source, /api\/admin\/amux\/(escalations|v22-owner-question|execution-view)/, file);
    assert.doesNotMatch(source, /dark:/, file);
  }
  const screen = read("components/admin/AmuxOwnerQueueScreen.tsx");
  const decision = read("components/admin/AmuxOwnerQueueDecision.tsx");
  assert.match(screen, /useAmuxOwnerReview\(/);
  assert.match(decision, /<AmuxOwnerReviewDetail controller=\{controller\}/);
  assert.match(decision, /<AmuxTaskQuestionSection /);
  assert.match(decision, /<AmuxPendingDecisionNotice /);
  // The only read it adds.
  assert.match(screen, /adminFetch\("\/api\/admin\/amux\/owner-queue"/);
  // A legacy card is remade or closed through the existing legacy card panel,
  // read from the card detail the execution board uses, for the owner only.
  assert.match(decision, /<AmuxLegacyCardPanel /);
  assert.match(decision, /useAmuxLegacyCardRead\(item\.taskId,\s*canInspectCards && /);
  assert.match(read("components/admin/AmuxLegacyCardPanel.tsx"),
    /\/api\/admin\/amux\/execution-view\?view=detail&taskId=/);
});

test("a key never skips a confirmation: numbers pick, Enter is not bound, typing is left alone", () => {
  const screen = read("components/admin/AmuxOwnerQueueScreen.tsx");
  assert.doesNotMatch(screen, /"Enter"/);
  assert.doesNotMatch(screen, /prepareProposal|confirmDecision/);
  assert.match(screen, /isEditable\(event\.target\)/);
  // A number is ignored while a decision is being recorded or its step-up is open.
  assert.match(screen, /if \(busy \|\| reauthenticationRequired \|\| unknown\) return;/);
  // Leaving a card is not offered while a decision is being read or recorded.
  assert.match(screen, /const navLocked = reviewBusy \|\| decisionStatusUnknown \|\| decisionStatusChecking \|\| pendingDecision !== null;/);
});

test("the copy is in both languages, and every reason the board names has a sentence", () => {
  const en = adminAmuxOwnerQueueMessages.en;
  const ko = adminAmuxOwnerQueueMessages.ko;
  assert.deepEqual(Object.keys(ko.why.byReason).sort(), Object.keys(en.why.byReason).sort());
  for (const reason of Object.keys(adminAmuxExecutionMessages.en.attentionReason)) {
    assert.ok(reason in en.why.byReason, `no sentence for ${reason}`);
  }
  assert.match(ko.label, /내 확인 대기/);
  for (const text of Object.values(ko.why.byReason)) assert.match(text, /[가-힣]/);
  assert.equal(ko.list.ago("3시간"), "3시간 전");
  assert.equal(en.list.ago("3h"), "3h ago");
});

test("the tab keeps its address and takes the new name in both languages", () => {
  const execution = ADMIN_NAVIGATION.find((item) => item.id === "amux-execution");
  const tab = execution.tabs.find((candidate) => candidate.id === "review");
  assert.equal(tab.label, "Waiting on me");
  const ko = localizeAdminTabs("amux-execution", execution.tabs, "ko").find((candidate) => candidate.id === "review");
  assert.equal(ko.label, "내 확인 대기");
  assert.match(ko.description, /한곳에서 차례로/);
});
