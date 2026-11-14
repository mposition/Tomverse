import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminAmuxOwnerQueueMessages } from "../lib/adminMessages/amuxOwnerQueue.ts";
import {
  AMUX_DM_RELAY_STALE_AFTER_MS,
  AMUX_OWNER_QUEUE_DM_STATES,
  amuxDmRelayView,
  amuxOwnerQueueDmButton,
  amuxOwnerQueueDmView,
} from "../lib/amux/ownerQueueDmRequestCore.ts";
import { amuxOwnerQueueDmRequestResult } from "../lib/amux/ownerQueueDmRequestCore.ts";
import { amuxOwnerQueueWithDmStatus } from "../lib/amux/ownerQueueCore.ts";

const read = (path) => readFileSync(path, "utf8");
const on = { routing: true, killSwitch: false, resultReview: true, t2: true, settlement: true };
const off = { ...on, settlement: false };
const facts = (over = {}) => ({
  question: null, review: null, t2: null, settlement: null, escalationId: null, settlementEligible: false, ...over,
});
const question = (over = {}) => ({ id: "q1", localCardId: null, request: null, parked: true, taskBlocked: true,
  bodyAvailable: true, providerKnown: true, ...over });
const live = { state: "live", lastSeenAt: "2026-11-14T00:00:00.000Z" };
const stale = { state: "stale", lastSeenAt: "2026-11-09T00:30:00.000Z" };

test("the relay is live within five minutes of its last call, and stale after", () => {
  const now = new Date("2026-11-14T03:00:00.000Z");
  assert.deepEqual(amuxDmRelayView(null, now), { state: "never" });
  assert.equal(amuxDmRelayView(new Date(now.getTime() - 30_000), now).state, "live");
  assert.equal(amuxDmRelayView(new Date(now.getTime() - AMUX_DM_RELAY_STALE_AFTER_MS), now).state, "live");
  assert.equal(amuxDmRelayView(new Date(now.getTime() - AMUX_DM_RELAY_STALE_AFTER_MS - 1), now).state, "stale");
  assert.equal(amuxDmRelayView(new Date("2026-11-09T00:30:00.000Z"), now).lastSeenAt, "2026-11-09T00:30:00.000Z");
});

test("a worker question says how far it got and why it has no card", () => {
  assert.equal(amuxOwnerQueueDmView(facts({ question: question() }), on).state, "waiting_relay");
  for (const [over, reason] of [[{ parked: false }, "question_not_parked"], [{ taskBlocked: false }, "task_not_blocked"],
    [{ bodyAvailable: false }, "result_body_gone"], [{ providerKnown: false }, "provider_unknown"]]) {
    const dm = amuxOwnerQueueDmView(facts({ question: question(over) }), on);
    assert.deepEqual([dm.state, dm.reason, dm.action], ["not_eligible", reason, null]);
  }
  const filed = amuxOwnerQueueDmView(facts({ question: question({ localCardId: "card-1" }) }), on);
  assert.equal(filed.state, "card_filed");
  const asked = amuxOwnerQueueDmView(facts({ question: question({ localCardId: "card-1",
    request: { requestId: "r1", result: null } }) }), on);
  assert.deepEqual([asked.state, asked.requestId], ["asked", "r1"]);
  const proposed = amuxOwnerQueueDmView(facts({ question: question({ localCardId: "card-1",
    request: { requestId: "r1", result: "proposal" } }) }), on);
  assert.equal(proposed.state, "proposed");
  // No question can be sent again from here: the button is never offered.
  assert.equal(amuxOwnerQueueDmView(facts({ question: question() }), on).action, null);
});

test("routing off, the kill switch, or unreadable switches hold every path", () => {
  for (const [switches, reason] of [[{ ...on, routing: false }, "dm_routing"], [{ ...on, killSwitch: true }, "kill_switch"],
    [{ ...on, killSwitch: null }, "switches_unreadable"]]) {
    for (const f of [facts({ question: question() }),
      facts({ review: { id: "v1", localCardId: null, request: null, handoffReason: null } }),
      facts({ escalationId: "e1", settlementEligible: true })]) {
      const dm = amuxOwnerQueueDmView(f, switches);
      assert.deepEqual([dm.state, dm.reason, dm.action], ["switch_off", reason, null]);
    }
  }
});

test("a result review sent back only when its evidence could not be read and it has no card", () => {
  const review = (over) => facts({ review: { id: "v1", localCardId: null, request: null, handoffReason: null, ...over } });
  const unreadable = amuxOwnerQueueDmView(review({ handoffReason: "evidence_unavailable" }), on);
  assert.deepEqual([unreadable.state, unreadable.action, unreadable.sourceId], ["unfilable", "resend", "v1"]);
  assert.equal(amuxOwnerQueueDmView(review({ handoffReason: "dm_undecided" }), on).action, null);
  // Not offered where the tick would not file it.
  assert.equal(amuxOwnerQueueDmView(review({ handoffReason: "evidence_unavailable" }), { ...on, resultReview: false }).action, null);
  assert.equal(amuxOwnerQueueDmView(review({ handoffReason: "evidence_unavailable" }), { ...on, killSwitch: true }).action, null);
  assert.equal(amuxOwnerQueueDmView(review({}), { ...on, resultReview: false }).reason, "result_review");
  assert.equal(amuxOwnerQueueDmView(review({ localCardId: "c" }), on).state, "card_filed");
});

test("a T2 draft whose patch does not fit is never offered again", () => {
  const dm = amuxOwnerQueueDmView(facts({ t2: { workItemId: "w1", localCardId: null, request: null, unfilable: true } }), on);
  assert.deepEqual([dm.state, dm.reason, dm.action], ["unfilable", "patch_does_not_fit", null]);
  assert.equal(amuxOwnerQueueDmView(facts({ t2: { workItemId: "w1", localCardId: null, request: null, unfilable: false } }),
    { ...on, t2: false }).reason, "t2_draft");
});

test("an escalation with no settlement is asked for while the switch is off, and waits while it is on", () => {
  const eligible = facts({ escalationId: "e1", settlementEligible: true });
  const ask = amuxOwnerQueueDmView(eligible, off);
  assert.deepEqual([ask.source, ask.state, ask.action, ask.sourceId], ["settlement", "switch_off", "request", "e1"]);
  assert.deepEqual([amuxOwnerQueueDmView(eligible, on).state, amuxOwnerQueueDmView(eligible, on).action],
    ["waiting_relay", null]);
  const held = amuxOwnerQueueDmView(facts({ escalationId: "e1", settlementEligible: false }), off);
  assert.deepEqual([held.state, held.reason, held.action], ["not_eligible", "settlement_not_eligible", null]);
  assert.equal(amuxOwnerQueueDmView(facts(), on).state, "none");
});

test("a settlement row: requested waits, unreadable is sent again, cancelled and applied are settled", () => {
  const row = (over) => facts({ escalationId: "e1", settlement: { id: "s1", state: "open", localCardId: null,
    request: null, handoffReason: null, cancelReason: null, requested: false, ...over } });
  assert.deepEqual([amuxOwnerQueueDmView(row({}), off).action, amuxOwnerQueueDmView(row({}), off).sourceId], ["request", "s1"]);
  assert.equal(amuxOwnerQueueDmView(row({ requested: true }), off).state, "waiting_relay");
  assert.equal(amuxOwnerQueueDmView(row({ handoffReason: "evidence_unavailable" }), off).action, "resend");
  assert.equal(amuxOwnerQueueDmView(row({ handoffReason: "evidence_unavailable" }), { ...off, routing: false }).action, null);
  assert.equal(amuxOwnerQueueDmView(row({ handoffReason: "dm_undecided" }), off).action, null);
  assert.deepEqual([amuxOwnerQueueDmView(row({ state: "cancelled", cancelReason: "task_moved" }), on).state,
    amuxOwnerQueueDmView(row({ state: "cancelled", cancelReason: "task_moved" }), on).reason], ["settled", "task_moved"]);
  assert.equal(amuxOwnerQueueDmView(row({ state: "applied" }), on).reason, "applied");
  assert.equal(amuxOwnerQueueDmView(row({ localCardId: "c", request: { requestId: "r", result: "proposal" } }), on).state,
    "proposed");
});

test("a question goes before a review, a draft and a settlement", () => {
  const all = facts({ question: question(), review: { id: "v", localCardId: null, request: null, handoffReason: null },
    t2: { workItemId: "w", localCardId: null, request: null, unfilable: false }, escalationId: "e", settlementEligible: true });
  assert.equal(amuxOwnerQueueDmView(all, on).source, "question");
  assert.equal(amuxOwnerQueueDmView({ ...all, question: null }, on).source, "result_review");
  assert.equal(amuxOwnerQueueDmView({ ...all, question: null, review: null }, on).source, "t2_draft");
});

test("while the relay is not calling, the button gives way to the relay check", () => {
  const ask = amuxOwnerQueueDmView(facts({ escalationId: "e1", settlementEligible: true }), off);
  assert.equal(amuxOwnerQueueDmButton(ask, live), "request");
  assert.equal(amuxOwnerQueueDmButton(ask, stale), "relay_check");
  assert.equal(amuxOwnerQueueDmButton(ask, { state: "never" }), "relay_check");
  const waiting = amuxOwnerQueueDmView(facts({ question: question() }), on);
  assert.equal(amuxOwnerQueueDmButton(waiting, live), null);
  assert.equal(amuxOwnerQueueDmButton(waiting, stale), "relay_check");
  // Nothing the relay could change: no check, no button.
  const gone = amuxOwnerQueueDmView(facts({ question: question({ bodyAvailable: false }) }), on);
  assert.equal(amuxOwnerQueueDmButton(gone, stale), null);
});

test("the queue carries the view per card and says the relay is unknown when the read failed", () => {
  const queue = { items: [{ taskId: "a" }, { taskId: "b" }], total: 2, processedToday: 0, generatedAt: "x" };
  const view = amuxOwnerQueueDmView(facts(), on);
  const attached = amuxOwnerQueueWithDmStatus(queue, { relay: live, byTask: new Map([["a", view]]) });
  assert.deepEqual(attached.items[0].dmStatus, view);
  assert.equal("dmStatus" in attached.items[1], false);
  assert.deepEqual(attached.dmRelay, live);
  assert.equal(amuxOwnerQueueWithDmStatus(queue, null).dmRelay, null);
});

test("every state and reason the core names has words in both languages", () => {
  for (const locale of ["en", "ko"]) {
    const dm = adminAmuxOwnerQueueMessages[locale].dmRequest;
    for (const state of AMUX_OWNER_QUEUE_DM_STATES) assert.equal(typeof dm.state[state], "string", `${locale} ${state}`);
  }
  const core = read("lib/amux/ownerQueueDmRequestCore.ts");
  const reasons = new Set([...core.matchAll(/reason: "([a-z_]+)"/g)].map((match) => match[1]));
  for (const code of ["dm_routing", "kill_switch", "switches_unreadable", "evidence_unavailable", "task_moved",
    "question_not_parked", "task_not_blocked", "result_body_gone", "provider_unknown", "escalation_resolved",
    "applied", "claimed"]) reasons.add(code);
  for (const code of reasons) {
    assert.equal(typeof adminAmuxOwnerQueueMessages.en.dmRequest.reason[code], "string", code);
    assert.equal(typeof adminAmuxOwnerQueueMessages.ko.dmRequest.reason[code], "string", code);
  }
});

test("the sync records the relay's call after authorization and before anything else", () => {
  const route = read("app/api/internal/amux/decision-maker/v22-questions/sync/route.ts");
  const auth = route.indexOf("isAmuxSyncAuthorized(request)");
  const seen = route.indexOf("await recordAmuxDmRelaySeen()");
  const routing = route.indexOf("if (!dmInternalRoutesEnabled())");
  assert.ok(auth > 0 && auth < seen && seen < routing);
  // With the switch off the settlement still opens what the owner asked for.
  assert.doesNotMatch(route, /if \(!settlementOn\) return \{ pending: \[\]/);
  const service = read("lib/amux/dmOwnerSettlementService.ts");
  assert.match(service, /readAmuxDmOwnerSettlementRequestedIds\(tx, AMUX_DM_OWNER_SETTLEMENT_PENDING_SCAN\)/);
  assert.match(service, /\$\{requested === null\} OR s\."id" = ANY/);
});

test("the owner's press is one transaction under the audit chain lock, with the person's audit entry", () => {
  const service = read("lib/amux/ownerQueueDmRequestService.ts");
  assert.match(service, /takeAuditChainLock\(tx\)/);
  assert.equal((service.match(/await audit\(/g) ?? []).length, 4);
  assert.match(service, /writeAdminAuditLog\(\{ tx, session: input\.session/);
  // A resend only clears a once-unreadable handoff on a row with no card.
  assert.equal((service.match(/"localCardId" IS NULL AND "handoffReason" = \$\{AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF\}/g) ?? []).length, 2);
  const route = read("app/api/admin/amux/owner-queue/dm-request/route.ts");
  assert.match(route, /hasAdminPermission\(session, "ops:write"\)/);
  assert.match(route, /hasValidMutationOrigin\(request\)/);
});

test("only an unjudged proposal is one to confirm; any other ending is closed", () => {
  assert.equal(amuxOwnerQueueDmRequestResult({ resultKind: null, judged: false }), null);
  assert.equal(amuxOwnerQueueDmRequestResult({ resultKind: "proposal", judged: false }), "proposal");
  assert.equal(amuxOwnerQueueDmRequestResult({ resultKind: "proposal", judged: true }), "closed");
  assert.equal(amuxOwnerQueueDmRequestResult({ resultKind: "escalation", judged: false }), "closed");
  assert.equal(amuxOwnerQueueDmRequestResult({ resultKind: "failed", judged: false }), "closed");
  const closed = amuxOwnerQueueDmView(facts({ question: question({ localCardId: "c",
    request: { requestId: "r9", result: "closed" } }) }), on);
  assert.deepEqual([closed.state, closed.requestId], ["dm_closed", "r9"]);
});

test("a relay read that failed is unknown: it neither hides the button nor claims the relay is down", () => {
  const ask = amuxOwnerQueueDmView(facts({ escalationId: "e1", settlementEligible: true }), off);
  assert.equal(amuxOwnerQueueDmButton(ask, null), "request");
  const read = readFileSync("lib/amux/ownerQueueDmStatusRead.ts", "utf8");
  assert.match(read, /readAmuxDmRelaySeenAt\(\)\.then\(\(at\) => amuxDmRelayView\(at, now\), \(\) => null\)/);
});

test("the DM approver never applies a settlement or result review the owner sent from the owner queue", () => {
  const auto = readFileSync("lib/amux/dmAutoApplyService.ts", "utf8");
  const body = auto.slice(auto.indexOf("export async function readAmuxDmAutoApplyCandidate"));
  assert.ok(body.indexOf("readAmuxOwnerQueueDmAskedAmong(tx, {") <
    body.indexOf("readNextDecisionMakerOpenProposal(tx"), "filtered before a proposal is picked");
  assert.match(body, /const cards = sampled\.filter\(\(card\) => !ownerAsked\.has\(card\.id\)\);/);
  assert.match(readFileSync("lib/amux/dbBoundary.ts", "utf8"),
    /decisionMakerAutoApplyRead: \{\s+operation: "decision_maker_auto_apply_read",\s+prismaCallCeiling: 10,/);
});
