import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { DM_ANSWER_MAX_BYTES, irreversibleTermCategories, isDmOptionId } from "../lib/amux/decisionMakerCore.ts";
import {
  AMUX_IDEA_CARD_CLOSE_BLOCK_REASON_TEXT,
  AMUX_IDEA_CARD_CLOSE_DEFAULT_DAILY,
  AMUX_IDEA_CARD_CLOSE_DEFAULT_STALE_DAYS,
  AMUX_IDEA_CARD_CLOSE_DM_PROVIDER,
  AMUX_IDEA_CARD_CLOSE_DM_WORKER,
  AMUX_IDEA_CARD_CLOSE_QUESTION_MAX,
  AMUX_IDEA_CARD_CLOSE_TITLE_MAX,
  amuxIdeaCardCloseAskedCards,
  amuxIdeaCardCloseAskedFrom,
  amuxIdeaCardCloseCandidate,
  amuxIdeaCardCloseDailyLimit,
  amuxIdeaCardCloseDecisionFromAnswer,
  amuxIdeaCardCloseEnabled,
  amuxIdeaCardCloseReasonValid,
  amuxIdeaCardCloseRefusal,
  amuxIdeaCardCloseRelayCard,
  amuxIdeaCardCloseStaleDays,
  amuxIdeaCardCloseTargets,
} from "../lib/amux/ideaCardCloseCore.ts";
import { AMUX_IDEA_BLOCK_REASONS, amuxIdeaProgress } from "../lib/amux/ideaProgressCore.ts";

const ROOT = resolve(import.meta.dirname, "..");
const NOW = Date.parse("2026-11-05T00:00:00.000Z");
const DAY = 86_400_000;

const card = (over = {}) => ({
  id: "card-1", displayKey: "AMUX-CONT-002", cardType: "task", status: "backlog", assigned: false,
  updatedAtMs: NOW - 8 * DAY, liveAttempt: false, workerQuestion: false, foreignDependent: false, ...over,
});
const candidate = (cards, staleDays = 7) => amuxIdeaCardCloseCandidate(cards, { nowMs: NOW, staleDays });

test("the switch is off unless exactly enabled, and the limits fall back to their defaults", () => {
  assert.equal(amuxIdeaCardCloseEnabled({}), false);
  assert.equal(amuxIdeaCardCloseEnabled({ TOMVERSE_AMUX_CARD_CLOSE_DM: "true" }), false);
  assert.equal(amuxIdeaCardCloseEnabled({ TOMVERSE_AMUX_CARD_CLOSE_DM: "enabled" }), true);
  assert.equal(amuxIdeaCardCloseDailyLimit({}), AMUX_IDEA_CARD_CLOSE_DEFAULT_DAILY);
  assert.equal(AMUX_IDEA_CARD_CLOSE_DEFAULT_DAILY, 5);
  assert.equal(amuxIdeaCardCloseDailyLimit({ AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY: "0" }), 5);
  assert.equal(amuxIdeaCardCloseDailyLimit({ AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY: "many" }), 5);
  assert.equal(amuxIdeaCardCloseDailyLimit({ AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY: "2" }), 2);
  assert.equal(amuxIdeaCardCloseStaleDays({}), AMUX_IDEA_CARD_CLOSE_DEFAULT_STALE_DAYS);
  assert.equal(AMUX_IDEA_CARD_CLOSE_DEFAULT_STALE_DAYS, 7);
  assert.equal(amuxIdeaCardCloseStaleDays({ AMUX_IDEA_CARD_CLOSE_STALE_DAYS: "14" }), 14);
});

test("a blocked Task or remaining cards unchanged for the period make an idea one to ask about", () => {
  const blocked = candidate([card({ status: "blocked", updatedAtMs: NOW }), card({ id: "card-2", updatedAtMs: NOW })]);
  assert.equal(blocked?.reason, "blocked_task");
  assert.deepEqual(blocked?.targets.map((entry) => entry.id), ["card-1", "card-2"]);
  assert.equal(candidate([card()])?.reason, "stale_cards");
  assert.equal(candidate([card({ updatedAtMs: NOW - 2 * DAY })]), null, "changed recently");
  assert.equal(candidate([card(), card({ id: "card-2", updatedAtMs: NOW - DAY })]), null,
    "one recent card keeps the idea alive");
  assert.equal(candidate([card({ updatedAtMs: NOW - 2 * DAY })], 1)?.reason, "stale_cards", "the period is a setting");
  assert.equal(candidate([card({ cardType: "story", status: "blocked" })]), null, "no Task at all");
  assert.equal(candidate([card({ status: "blocked", updatedAtMs: NOW, cardType: "story" }),
    card({ id: "card-2", updatedAtMs: NOW })]), null, "a blocked Story is not a blocked Task");
});

test("anything still moving, or finished, leaves nothing to ask about", () => {
  assert.deepEqual(amuxIdeaCardCloseTargets([]), { ok: false, why: "no_task" });
  assert.deepEqual(amuxIdeaCardCloseTargets([card({ status: "done" }), card({ id: "b", status: "cancelled" })]),
    { ok: false, why: "all_finished" });
  for (const moving of [{ status: "doing" }, { status: "review" }, { status: "todo", assigned: true },
    { liveAttempt: true }, { status: "blocked", liveAttempt: true }]) {
    assert.deepEqual(amuxIdeaCardCloseTargets([card(), card({ id: "other", ...moving })]),
      { ok: false, why: "work_started" }, JSON.stringify(moving));
  }
  assert.deepEqual(amuxIdeaCardCloseTargets([card({ status: "blocked", workerQuestion: true })]),
    { ok: false, why: "worker_question" });
  assert.deepEqual(amuxIdeaCardCloseTargets([card({ foreignDependent: true })]),
    { ok: false, why: "foreign_dependent" });
  assert.deepEqual(amuxIdeaCardCloseTargets([card(), card({ id: "x", status: "needsyou" })]),
    { ok: false, why: "unknown_status" }, "an unknown status fails closed");
  // A dependent of a finished card does not hold anything back.
  const done = amuxIdeaCardCloseTargets([card(), card({ id: "x", status: "done", foreignDependent: true })]);
  assert.equal(done.ok, true);
});

test("backlog, blocked and an unassigned todo close; stories go with them; finished cards stay", () => {
  const verdict = amuxIdeaCardCloseTargets([
    card({ id: "a", status: "backlog" }), card({ id: "b", status: "blocked" }),
    card({ id: "c", status: "todo" }), card({ id: "d", status: "done" }),
    card({ id: "e", status: "cancelled" }), card({ id: "f", cardType: "story", status: "backlog" }),
  ]);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.targets.map((entry) => entry.id), ["a", "b", "c", "f"]);
});

test("a question closes nothing once the idea moved or its cards changed", () => {
  const asked = amuxIdeaCardCloseAskedFrom([card({ id: "a" }), card({ id: "b" })]);
  const same = [card({ id: "a" }), card({ id: "b", status: "blocked" })];
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: false, asked, cards: same }), null, "a status may differ");
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: true, asked, cards: same }), "idea_cancelled");
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: false, asked,
    cards: [card({ id: "a" }), card({ id: "b", status: "doing" })] }), "work_started");
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: false, asked,
    cards: [card({ id: "a" }), card({ id: "b", status: "todo", assigned: true })] }), "work_started");
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: false, asked,
    cards: [card({ id: "a" }), card({ id: "b", workerQuestion: true })] }), "work_started");
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: false, asked,
    cards: [card({ id: "a" }), card({ id: "b" }), card({ id: "new" })] }), "cards_changed", "a card added since");
  assert.equal(amuxIdeaCardCloseRefusal({ ideaCancelled: false, asked,
    cards: [card({ id: "a" }), card({ id: "b", status: "done" })] }), "cards_changed", "one finished since");
});

test("the row's cards are read back only in the shape it writes", () => {
  const cards = amuxIdeaCardCloseAskedFrom([card()]);
  assert.deepEqual(cards, [{ id: "card-1", displayKey: "AMUX-CONT-002", cardType: "task", status: "backlog",
    updatedAtMs: NOW - 8 * DAY }]);
  assert.deepEqual(amuxIdeaCardCloseAskedCards(cards), cards);
  // A row written before the reasons and dates reads as it did.
  const old = [{ id: "card-1", displayKey: "AMUX-CONT-002", cardType: "task", status: "blocked" }];
  assert.deepEqual(amuxIdeaCardCloseAskedCards(old), old);
  for (const bad of [null, "x", [], [null], [{ id: 1, status: "x", displayKey: null, cardType: null }],
    [{ id: "a", displayKey: null, cardType: null }]]) {
    assert.equal(amuxIdeaCardCloseAskedCards(bad), null, JSON.stringify(bad));
  }
});

// The local AMUX's own bounds on a filed question, read from its source so the
// two cannot part (vendor/amux/crates/amux-server/src/api/dm_relay_v22.rs), and
// the session name's from the relay and the ledger.
test("the relay card is what the local AMUX files without a redeploy", () => {
  const source = readFileSync(resolve(ROOT, "vendor/amux/crates/amux-server/src/api/dm_relay_v22.rs"), "utf8");
  const bound = (name) => Number(new RegExp(`const ${name}: usize = ([\\d_]+);`).exec(source)[1].replaceAll("_", ""));
  assert.equal(AMUX_IDEA_CARD_CLOSE_QUESTION_MAX, bound("QUESTION_MAX"));
  assert.equal(AMUX_IDEA_CARD_CLOSE_TITLE_MAX, bound("TITLE_MAX"));
  assert.ok(new RegExp(`V22_PROVIDERS: \\[&str; 4\\] = \\[[^\\]]*"${AMUX_IDEA_CARD_CLOSE_DM_PROVIDER}"`).test(source));
  assert.match(AMUX_IDEA_CARD_CLOSE_DM_WORKER, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

  const id = "00000000-0000-4000-8000-00000000000a";
  // A long list of long ids: the local AMUX refuses a question over its bound.
  const cards = Array.from({ length: 300 }, (_, index) => ({ id: `${"x".repeat(60)}-${index}`, displayKey: null,
    cardType: "task", status: "backlog" }));
  for (const list of [cards, cards.slice(0, 1)]) {
    const relay = amuxIdeaCardCloseRelayCard({ questionId: id, reasonCode: "stale_cards", cards: list });
    assert.deepEqual(Object.keys(relay).sort(),
      ["options", "provider", "question", "question_id", "title", "unblocks", "worker"]);
    assert.equal(relay.question_id, id);
    assert.ok(relay.question.length <= bound("QUESTION_MAX"), `${relay.question.length}`);
    assert.ok(relay.title.length <= bound("TITLE_MAX"));
    assert.ok(relay.unblocks.length <= bound("UNBLOCKS_MAX"));
    assert.ok(relay.options.length <= bound("OPTIONS_MAX"));
    for (const option of relay.options) {
      assert.ok(isDmOptionId(option.id));
      assert.ok(option.label.length <= bound("LABEL_MAX"));
    }
    assert.deepEqual(relay.options.map((option) => option.id), ["close", "keep"]);
  }
  const long = amuxIdeaCardCloseRelayCard({ questionId: id, reasonCode: "stale_cards", cards });
  assert.match(long.question, /and \d+ more\n/);
});

test("the question says only numbers, statuses and the reason, and hits no routing term by itself", () => {
  const relay = amuxIdeaCardCloseRelayCard({ questionId: "00000000-0000-4000-8000-00000000000a",
    reasonCode: "blocked_task", cards: [
      { id: "card-a", displayKey: "AMUX-CONT-002", cardType: "task", status: "blocked" },
      { id: "card-b", displayKey: null, cardType: "story", status: "backlog" },
    ] });
  assert.match(relay.question, /reason code: blocked_task/);
  assert.match(relay.question, /AMUX-CONT-002 \(task, blocked\)/);
  assert.match(relay.question, /card-b \(story, backlog\)/);
  assert.match(relay.title, /AMUX-CONT-002/);
  const text = [relay.title, relay.question, relay.unblocks, ...relay.options.map((option) => option.label)].join("\n");
  assert.deepEqual(irreversibleTermCategories(text), [],
    "these words alone must not send every question to the operator");
  // A card's own number can still hit the list; the owner's panel is then the way.
  assert.deepEqual(irreversibleTermCategories("AMUX-PROD-001"), ["release"]);
  assert.ok(text.length < DM_ANSWER_MAX_BYTES * 2, "well inside the card text cap");
});

test("a blocked card records why, as the idea's detail picks it, and every card when it last changed", () => {
  const [blocked, open] = amuxIdeaCardCloseAskedFrom([
    card({ id: "a", status: "blocked", escalationReason: "free text", lastAttemptReason: "usage_outcome_unknown" }),
    card({ id: "b", status: "backlog", escalationReason: "human_review_required" }),
  ]);
  assert.equal(blocked.blockReason, "usage_outcome_unknown", "an unknown escalation reason falls to the attempt's");
  assert.equal(open.blockReason, undefined, "only a blocked card says why");
  assert.equal(amuxIdeaCardCloseAskedFrom([card({ status: "blocked" })])[0].blockReason, null, "not known");
  assert.equal(amuxIdeaCardCloseAskedFrom([card({ status: "blocked", escalationReason: "attempts",
    lastAttemptReason: "outcome_unknown" })])[0].blockReason, "attempts", "the open review's reason first");
  // Context only: a value the row cannot vouch for is dropped, the card is kept.
  const base = { id: "a", displayKey: null, cardType: "task", status: "blocked" };
  assert.deepEqual(amuxIdeaCardCloseAskedCards([{ ...base, blockReason: "rm -rf", updatedAtMs: "x" }]), [base]);
  assert.deepEqual(amuxIdeaCardCloseAskedCards([{ ...base, blockReason: null, updatedAtMs: 5 }]),
    [{ ...base, blockReason: null, updatedAtMs: 5 }]);
});

test("each block reason is a fixed sentence that hits no routing term, and the codes are not written", () => {
  assert.deepEqual(Object.keys(AMUX_IDEA_CARD_CLOSE_BLOCK_REASON_TEXT).sort(), [...AMUX_IDEA_BLOCK_REASONS].sort());
  for (const reason of AMUX_IDEA_BLOCK_REASONS) {
    const text = AMUX_IDEA_CARD_CLOSE_BLOCK_REASON_TEXT[reason];
    assert.deepEqual(irreversibleTermCategories(text), [], reason);
    const relay = amuxIdeaCardCloseRelayCard({ questionId: "00000000-0000-4000-8000-00000000000a",
      reasonCode: "blocked_task", nowMs: NOW, cards: [{ id: "card-a", displayKey: "AMUX-CONT-002", cardType: "task",
        status: "blocked", blockReason: reason, updatedAtMs: NOW - 7 * DAY }] });
    assert.ok(relay.question.includes(`blocked: ${text}`), reason);
    assert.ok(!relay.question.includes(reason), `${reason} is not written as a code`);
    const all = [relay.title, relay.question, relay.unblocks, ...relay.options.map((option) => option.label)].join("\n");
    assert.deepEqual(irreversibleTermCategories(all), [], reason);
  }
});

test("the question says why each blocked card is blocked and how long the cards have not changed", () => {
  const relay = amuxIdeaCardCloseRelayCard({ questionId: "00000000-0000-4000-8000-00000000000a",
    reasonCode: "blocked_task", nowMs: NOW, cards: [
      { id: "s", displayKey: "AMUX-STARTERCHK-001", cardType: "story", status: "backlog", updatedAtMs: NOW - 8 * DAY },
      { id: "t", displayKey: "AMUX-STARTERCHK-001-T002", cardType: "task", status: "blocked",
        blockReason: "usage_outcome_unknown", updatedAtMs: NOW - 7 * DAY - 3_600_000 },
      { id: "u", displayKey: "AMUX-STARTERCHK-001-T003", cardType: "task", status: "blocked", blockReason: null,
        updatedAtMs: NOW - DAY },
    ] });
  assert.equal(relay.question, [
    "An AMUX idea has stopped moving (reason code: blocked_task). None of its cards is running, in review or assigned to a worker.",
    "None of its remaining cards has changed for 1 day.",
    "Remaining cards:",
    "AMUX-STARTERCHK-001 (story, backlog; unchanged for 8 days)",
    "AMUX-STARTERCHK-001-T002 (task, blocked: the run's result and cost are unknown; unchanged for 7 days)",
    "AMUX-STARTERCHK-001-T003 (task, blocked: reason not recorded; unchanged for 1 day)",
    "Should the remaining cards be closed?",
  ].join("\n"));
  const fresh = amuxIdeaCardCloseRelayCard({ questionId: "00000000-0000-4000-8000-00000000000a",
    reasonCode: "blocked_task", nowMs: NOW, cards: [{ id: "t", displayKey: "AMUX-X-001", cardType: "task",
      status: "blocked", updatedAtMs: NOW - 60_000 }] });
  assert.match(fresh.question, /One of its remaining cards changed within the last day\./);
  assert.match(fresh.question, /AMUX-X-001 \(task, blocked; changed within the last day\)/,
    "a row with no reason recorded reads as before");
  // A row written before the dates, or a card without one, says no age for the idea.
  const mixed = amuxIdeaCardCloseRelayCard({ questionId: "00000000-0000-4000-8000-00000000000a",
    reasonCode: "stale_cards", nowMs: NOW, cards: [
      { id: "a", displayKey: "AMUX-X-002", cardType: "task", status: "backlog" },
      { id: "b", displayKey: "AMUX-X-003", cardType: "task", status: "todo", updatedAtMs: NOW - 9 * DAY },
    ] });
  assert.doesNotMatch(mixed.question, /None of its remaining cards/);
  assert.match(mixed.question, /AMUX-X-002 \(task, backlog\)\nAMUX-X-003 \(task, todo; unchanged for 9 days\)/);
});

test("a long list with reasons and dates still fits the local AMUX's bound", () => {
  const cards = Array.from({ length: 300 }, (_, index) => ({ id: `${"x".repeat(60)}-${index}`, displayKey: null,
    cardType: "task", status: "blocked", blockReason: "canonical_deadline_review_required", updatedAtMs: NOW - 400 * DAY }));
  const relay = amuxIdeaCardCloseRelayCard({ questionId: "00000000-0000-4000-8000-00000000000a",
    reasonCode: "blocked_task", nowMs: NOW, cards });
  assert.ok(relay.question.length <= AMUX_IDEA_CARD_CLOSE_QUESTION_MAX, `${relay.question.length}`);
  assert.match(relay.question, /and \d+ more\nShould the remaining cards be closed\?$/);
});

test("only the fixed words of a confirmed answer count, by the delivery candidate's precedence", () => {
  const read = (over) => amuxIdeaCardCloseDecisionFromAnswer({ judgmentKind: "confirm", outputKind: "select",
    optionId: "close", ...over });
  assert.equal(read({}), "close");
  assert.equal(read({ optionId: "keep" }), "keep");
  assert.equal(read({ optionId: "other" }), null);
  assert.equal(read({ optionId: null }), null);
  assert.equal(read({ outputKind: "free_text", optionId: null, dmAnswer: " Close\n" }), "close");
  assert.equal(read({ outputKind: "free_text", optionId: null, dmAnswer: "keep" }), "keep");
  assert.equal(read({ outputKind: "free_text", optionId: null, dmAnswer: "keep them, I think" }), null);
  assert.equal(read({ outputKind: "free_text", optionId: null, dmAnswer: "close or keep" }), null);
  assert.equal(read({ outputKind: "free_text", optionId: null }), null);
  // An edited confirmation is the person's text, whatever the DM proposed.
  assert.equal(read({ judgmentKind: "edit_confirm", operatorAnswer: "keep" }), "keep");
  assert.equal(read({ judgmentKind: "edit_confirm", operatorAnswer: "유지" }), "keep");
  assert.equal(read({ judgmentKind: "edit_confirm", operatorAnswer: "닫기" }), "close");
  assert.equal(read({ judgmentKind: "edit_confirm", operatorAnswer: "닫아 주세요" }), null);
  assert.equal(read({ judgmentKind: "edit_confirm" }), null, "an erased body is no answer");
  assert.equal(read({ judgmentKind: "edit_confirm", operatorAnswer: "constructor" }), null, "no inherited key");
});

test("the owner's reason has the bounds of an idea close", () => {
  assert.equal(amuxIdeaCardCloseReasonValid("no longer needed"), true);
  for (const bad of ["no", " spaced ", "x".repeat(501), null, 12]) {
    assert.equal(amuxIdeaCardCloseReasonValid(bad), false, String(bad));
  }
});

test("an idea whose cards all closed shows as cancelled, and one with a merged Task as done", () => {
  const facts = (cards) => amuxIdeaProgress({ state: "completed", cancelled: false, chunks: [], proposedUnits: 0, cards });
  const closed = { cardType: "task", status: "cancelled", reviewPrNumber: null, merged: false };
  const merged = { cardType: "task", status: "done", reviewPrNumber: 7, merged: true };
  const blocked = { cardType: "task", status: "blocked", reviewPrNumber: null, merged: false };
  assert.equal(facts([closed, closed]).stage, "cancelled");
  assert.equal(facts([closed, merged]).stage, "done");
  assert.equal(facts([closed, blocked]).stage, "execution");
  assert.deepEqual(facts([closed, merged]).tasks, { total: 2, done: 1, inReview: 0 });
});

test("the progress read counts only a done card as merged, though a closed one is terminal too", () => {
  const read = readFileSync(resolve(ROOT, "lib/amux/ideaProgressRead.ts"), "utf8");
  assert.match(read, /'terminal', \(w\."v4TerminalAt" IS NOT NULL AND w\."status" = 'done'\)/);
  const service = readFileSync(resolve(ROOT, "lib/amux/ideaCardCloseService.ts"), "utf8");
  assert.match(service, /status: "cancelled", revision: \{ increment: 1 \}, v4TerminalAt: input\.now/);
  // The dependents' gate needs done as well, so a closed card opens none of them.
  const ready = readFileSync(resolve(ROOT, "lib/amux/v4TaskReadyCore.ts"), "utf8");
  assert.match(ready, /item\.status !== "done" \|\| !item\.terminal/);
});

test("the owner's panel sits on the idea's detail, in both languages, and appears only with an open question", async () => {
  const summary = readFileSync(resolve(ROOT, "components/admin/AmuxIdeaDetailSummary.tsx"), "utf8");
  assert.match(summary, /<AmuxIdeaCardClosePanel key=\{`card-close-\$\{row\.ideaId\}`\} ideaId=\{row\.ideaId\} \/>/);
  const panel = readFileSync(resolve(ROOT, "components/admin/AmuxIdeaCardClosePanel.tsx"), "utf8");
  assert.match(panel, /return view \? <AmuxIdeaCardCloseForm ideaId=\{ideaId\} view=\{view\} \/> : null;/);
  // With no question open, the direct close posts no question and offers no keep.
  assert.match(panel, /\{ ideaId, direct: true, decision: "close", reason: trimmed, ownerConfirmed: true \}/);
  assert.match(panel, /ownerConfirmed: true/);
  assert.match(panel, /adminRecentAuthenticationHref/);
  const { adminAmuxIdeaCardCloseMessages: catalog } = await import("../lib/adminMessages/amuxIdeaCardClose.ts");
  assert.deepEqual(Object.keys(catalog.en).sort(), Object.keys(catalog.ko).sort());
  for (const reason of ["blocked_task", "stale_cards"]) {
    assert.ok(catalog.en.reasons[reason], reason);
    assert.ok(catalog.ko.reasons[reason], reason);
  }
  assert.match(catalog.ko.closed(2), /2/);
});

test("the boundaries stay within the policy's twelve statements, and the confirmed answer goes nowhere near a session", () => {
  const boundaries = readFileSync(resolve(ROOT, "lib/amux/dbBoundary.ts"), "utf8");
  for (const [name, ceiling] of [["decisionMakerIdeaCardCloseScan", 3], ["decisionMakerIdeaCardCloseOpen", 10],
    ["decisionMakerIdeaCardCloseRead", 4], ["decisionMakerIdeaCardCloseApply", 12],
    ["decisionMakerIdeaCardCloseHandoff", 8], ["decisionMakerIdeaCardCloseOwnerRead", 4],
    ["decisionMakerV22QuestionResolve", 10], ["decisionMakerV22QuestionWrite", 8]]) {
    const match = new RegExp(`${name}: \\{[^}]*prismaCallCeiling: (\\d+)`).exec(boundaries);
    assert.equal(Number(match?.[1]), ceiling, name);
  }
  const dm = readFileSync(resolve(ROOT, "lib/amux/v22OwnerQuestionDmService.ts"), "utf8");
  assert.match(dm, /UNION ALL\s+SELECT 1 AS "found" FROM "AmuxIdeaCardCloseQuestion"\s+WHERE "localCardId" = \$\{cardId\}/);
});
