import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_ATTENTION_GROUPS, amuxAestShort, amuxAgoText, amuxAttentionCounts, amuxAttentionGroup,
  amuxDurationParts, amuxMatchesSearch, amuxPastWorkKind, amuxStatusChip,
} from "../lib/adminAmuxBoardView.ts";
import {
  amuxUsageTotals, formatAmuxPercent, formatAmuxUsd, groupAmuxUsageByWorker,
} from "../lib/adminAmuxUsage.ts";
import { adminAmuxBoardViewsMessages } from "../lib/adminMessages/amuxBoardViews.ts";
import { adminAmuxExecutionMessages } from "../lib/adminMessages/amuxExecution.ts";

const card = (attentionReason = null, ownerQuestion = null) => ({ attentionReason, ownerQuestion });

test("a waiting card is a question, a decision, a recovery or a read, and an open question always wins", () => {
  assert.deepEqual(AMUX_ATTENTION_GROUPS, ["decision", "question", "recovery", "read"]);
  assert.equal(amuxAttentionGroup(card("human_review_required")), "decision");
  assert.equal(amuxAttentionGroup(card("review_server_rejected_twice")), "decision");
  assert.equal(amuxAttentionGroup(card("attempt_budget_exhausted")), "decision");
  assert.equal(amuxAttentionGroup(card("execution_blocked")), "recovery");
  assert.equal(amuxAttentionGroup(card("execution_lease_expired")), "recovery");
  assert.equal(amuxAttentionGroup(card("usage_outcome_unknown")), "read");
  assert.equal(amuxAttentionGroup(card(null)), "read", "blocked with no open escalation: read what happened first");
  assert.equal(amuxAttentionGroup(card("execution_blocked", "open")), "question");
  // An answered question is no longer the owner's to answer.
  assert.equal(amuxAttentionGroup(card("human_review_required", "answered")), "decision");
});

test("every escalation reason the board labels is in a group, and the groups add up to the cards", () => {
  const reasons = Object.keys(adminAmuxExecutionMessages.en.attentionReason);
  for (const reason of reasons) assert.ok(AMUX_ATTENTION_GROUPS.includes(amuxAttentionGroup(card(reason))), reason);
  const cards = [card("human_review_required"), card("local_card_closed"), card("execution_blocked"), card("usage_outcome_unknown"), card(null, "open")];
  const counts = amuxAttentionCounts(cards, 2);
  assert.deepEqual(counts, { decision: 4, question: 1, recovery: 1, read: 1 });
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), cards.length + 2);
});

test("the column's four labels exist in both languages", () => {
  for (const locale of ["en", "ko"]) {
    const v = adminAmuxBoardViewsMessages[locale];
    assert.deepEqual(Object.keys(v.attention.groups).sort(), [...AMUX_ATTENTION_GROUPS].sort());
    assert.equal(v.status.done.length > 0, true);
  }
  assert.deepEqual(Object.values(adminAmuxBoardViewsMessages.ko.attention.groups), ["결정", "질문", "복구", "읽기"]);
});

test("a stored status is drawn as one of the console's tones and never as English text", () => {
  assert.deepEqual(amuxStatusChip("done"), { group: "done", tone: "ok" });
  assert.deepEqual(amuxStatusChip("blocked"), { group: "blocked", tone: "bad" });
  assert.deepEqual(amuxStatusChip("doing"), { group: "running", tone: "info" });
  assert.deepEqual(amuxStatusChip("backlog"), { group: "waiting", tone: "idle" });
  assert.deepEqual(amuxStatusChip("something-new"), { group: "other", tone: "unknown" });
  const ko = adminAmuxBoardViewsMessages.ko.status;
  assert.deepEqual([ko.done, ko.blocked, ko.cancelled, ko.archived], ["완료", "막힘", "취소", "보관함"]);
});

test("past work groups an archived card as archived whatever its status", () => {
  assert.equal(amuxPastWorkKind({ status: "done", archived: false }), "done");
  assert.equal(amuxPastWorkKind({ status: "done", archived: true }), "archived");
  assert.equal(amuxPastWorkKind({ status: "blocked", archived: false }), "blocked");
  assert.equal(amuxPastWorkKind({ status: "cancelled", archived: false }), "cancelled");
  assert.equal(amuxPastWorkKind({ status: "doing", archived: true }), "archived");
  assert.equal(amuxPastWorkKind({ status: "doing", archived: false }), "other");
});

test("search matches any field, ignores case and treats an empty search as everything", () => {
  assert.equal(amuxMatchesSearch("", ["a"]), true);
  assert.equal(amuxMatchesSearch("  ", []), true);
  assert.equal(amuxMatchesSearch("AUTOFILE", [null, "autofile-004"]), true);
  assert.equal(amuxMatchesSearch("seed", ["Seed rule", undefined]), true);
  assert.equal(amuxMatchesSearch("nope", ["Seed rule", "AMUX-1"]), false);
});

test("times are Brisbane (AEST) and the relative text counts from the read clock", () => {
  // 2026-11-07T04:20:00Z is 14:20 in Brisbane (UTC+10, no daylight saving).
  assert.equal(amuxAestShort("2026-11-07T04:20:00.000Z"), "11-07 14:20");
  assert.equal(amuxAestShort("not a time"), null);
  assert.equal(amuxAestShort(null), null);
  const now = Date.parse("2026-11-07T05:20:00.000Z");
  assert.equal(amuxAgoText("2026-11-07T04:20:00.000Z", now, "ko"), "1시간 전");
  assert.equal(amuxAgoText("2026-11-07T04:20:00.000Z", null, "ko"), null, "no clock yet: no text");
  assert.equal(amuxAgoText("garbage", now, "ko"), null);
});

test("a duration is the largest whole unit and an unreadable one is null", () => {
  assert.deepEqual(amuxDurationParts(42_000), { value: 42, unit: "second" });
  assert.deepEqual(amuxDurationParts(19 * 60_000), { value: 19, unit: "minute" });
  assert.deepEqual(amuxDurationParts(3 * 3_600_000), { value: 3, unit: "hour" });
  assert.equal(amuxDurationParts(null), null);
  assert.equal(amuxDurationParts(Number.NaN), null);
  assert.equal(amuxDurationParts(-1), null);
});

const usageRow = (over) => ({
  worker: "codex-contract", executor: "codex", source: "cli", model: "gpt-6", round: 1, recorded: 10, usageUnknown: 1,
  noReceiptAttempts: 1, unmeasuredRateLowerBound: 0, reportedInputTokens: "100", reportedOutputTokens: "50",
  reportedCacheReadTokens: "0", reportedCacheWriteTokens: "0", cacheWriteReports: 0,
  knownProjectedApiCostMicrousd: "1500000", pricedCalls: 10, ...over,
});

test("usage is grouped by worker, an unreported call is never zero, and an estimate says when it is partial", () => {
  const workers = groupAmuxUsageByWorker([
    usageRow({}),
    usageRow({ model: "gpt-6-mini", round: 2, recorded: 2, usageUnknown: 0, noReceiptAttempts: 0, pricedCalls: 0, knownProjectedApiCostMicrousd: "0" }),
    usageRow({ worker: "claude-impl", executor: "claude", recorded: 4, usageUnknown: 0, noReceiptAttempts: 0, pricedCalls: 0, knownProjectedApiCostMicrousd: "0" }),
  ]);
  assert.deepEqual(workers.map((worker) => worker.worker), ["codex-contract", "claude-impl"]);
  const [codex, claude] = workers;
  assert.equal(codex.recorded, 12);
  assert.equal(codex.rows.length, 2);
  assert.equal(codex.unmeasured, 2, "unknown usage plus attempts with no report");
  // (unknown + no report) / (recorded + no report) = 2 / 13, a lower bound
  assert.ok(Math.abs(codex.rate - 2 / 13) < 1e-9);
  assert.equal(codex.partialPricing, true, "two recorded calls have no known price");
  assert.equal(claude.pricedCalls, 0);
  const totals = amuxUsageTotals(workers);
  assert.equal(totals.recorded, 16);
  assert.equal(totals.unmeasured, 2);
  assert.equal(totals.pricedCalls, 10);
  assert.equal(totals.knownCostMicrousd, BigInt(1_500_000));
  assert.equal(totals.partialPricing, true);
  assert.equal(formatAmuxUsd(totals.knownCostMicrousd), "US$ 1.50");
  assert.equal(formatAmuxPercent(totals.rate), "11.8%");
});

test("an empty window is zero calls, not an error, and money rounds to the cent", () => {
  const totals = amuxUsageTotals(groupAmuxUsageByWorker([]));
  assert.deepEqual([totals.recorded, totals.unmeasured, totals.rate], [0, 0, 0]);
  assert.equal(formatAmuxUsd(BigInt(24_495_000)), "US$ 24.50");
  assert.equal(formatAmuxUsd(BigInt(4_999)), "US$ 0.00");
  assert.equal(formatAmuxUsd(BigInt(5_000)), "US$ 0.01");
});
