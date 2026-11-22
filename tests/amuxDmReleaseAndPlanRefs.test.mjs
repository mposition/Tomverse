import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Owner decision 2026-11-22 ("DM은 접근권한 막지 마세요"), from AMUX-CRAWL-003:
// the Decision Maker reads other cards by number, a result review it cannot
// settle goes to its settlement instead of waiting on the owner, and a card the
// app filed is not read for the routing terms (amuxFlowStoppedCardsDm.test.mjs).

const read = (path) => readFileSync(path, "utf8");

test("a plan's local card ids resolve to the registered cards' numbers; anything else is left as written", async () => {
  const { amuxPlanCardRefsOf, resolveAmuxPlanCardRefs, resolveAmuxPlanCardRefList, mentionsAmuxPlanCardRef,
    EMPTY_AMUX_PLAN_CARD_REFS } = await import("../lib/amux/planLocalRefCore.ts");
  const refs = amuxPlanCardRefsOf([
    { localRef: "c0:card-1", displayKey: "AMUX-CRAWL-002", workItemId: "w1" },
    { localRef: "c1:card-12", displayKey: null, workItemId: "w12" },
    { localRef: "c0:card-3", displayKey: "AMUX-CRAWL-004", workItemId: null },
    { localRef: null, displayKey: "AMUX-X-001", workItemId: "w9" },
  ]);
  assert.equal(refs.size, 2);
  // AMUX-CRAWL-003's fourth criterion, as registered.
  assert.equal(resolveAmuxPlanCardRefs("스크립트는 c0:card-1의 export 상수를 import해 목록을 중복 정의하지 않는다.", refs),
    "스크립트는 AMUX-CRAWL-002의 export 상수를 import해 목록을 중복 정의하지 않는다.");
  // No number yet: the Task ID. Not registered (c0:card-3) or not a card id: as written.
  assert.equal(resolveAmuxPlanCardRefs("after c1:card-12, then c0:card-3", refs), "after w12, then c0:card-3");
  for (const text of ["c0:node-1", "xc0:card-1", "c0:card-10", "c0:card-01", "c00:card-1", "c0:card-1x"])
    assert.equal(resolveAmuxPlanCardRefs(text, refs), text, text);
  assert.equal(resolveAmuxPlanCardRefs('{"a":"c0:card-1 and (c0:card-1)"}', refs),
    '{"a":"AMUX-CRAWL-002 and (AMUX-CRAWL-002)"}');
  assert.deepEqual(resolveAmuxPlanCardRefList(["c0:card-1", "none"], refs), ["AMUX-CRAWL-002", "none"]);
  assert.equal(resolveAmuxPlanCardRefs("c0:card-1", EMPTY_AMUX_PLAN_CARD_REFS), "c0:card-1");
  // The test that gates the read is stateless across calls (a global regex keeps lastIndex).
  assert.equal(mentionsAmuxPlanCardRef("c0:card-1"), true);
  assert.equal(mentionsAmuxPlanCardRef("c0:card-1"), true);
  assert.equal(mentionsAmuxPlanCardRef("AMUX-CRAWL-002"), false);
});

test("every reader that hands a card's text on resolves its plan ids", () => {
  const review = read("lib/amux/v22ResultReviewService.ts");
  assert.match(review, /resolveAmuxPlanCardRefList\(texts, await readAmuxPlanCardRefs\(row\.ideaId\)\)/,
    "the result review, the owner settlement and the DM workspace's CRITERIA.md read openCompletionCriteria");
  const delivery = read("lib/amux/delivery.ts");
  assert.match(delivery, /formatAmuxV52ReviewScope\(titleText, resolveAmuxPlanCardRefList\(criteria, planRefs\)\)/);
  assert.match(delivery, /text: resolveAmuxPlanCardRefs\(plain\.toString\("utf8"\), planRefs\)/);
  // The read sits outside the delivery's transactions, so their statement budgets are unchanged.
  assert.ok(delivery.indexOf("await readAmuxPlanCardRefs(ideaId)") < delivery.indexOf("const deliveryContent = async"));
  const admin = read("lib/amux/adminExecutionRead.ts");
  assert.match(admin, /body = body === null \? null : resolveAmuxPlanCardRefs\(body, refs\)/);
  const store = read("lib/amux/planLocalRefRead.ts");
  assert.match(store, /AMUX_DB_BOUNDARIES\.planLocalRefRead/);
  assert.match(store, /u\."unitKind" = 'card'/);
  assert.match(read("lib/amux/dbBoundary.ts"), /planLocalRefRead: \{\s+operation: "plan_local_ref_read",\s+prismaCallCeiling: 3,\s+isolation: "read",/);
});

test("the settlement scan skips a card only while the Decision Maker still holds its result review", () => {
  const scan = read("lib/amux/dmOwnerSettlementRead.ts");
  assert.match(scan, /AND \(\(v\."state" = 'open' AND v\."handoffAt" IS NULL AND NOT \$\{amuxV22ResultReviewRequestEndedSql\}\)\s+OR \(v\."attemptId" = a\."id" AND v\."decision" = 'block'\)\)\)/);
  assert.doesNotMatch(scan, /AmuxDecisionMakerRequest/, "the request tables stay the store's own");
  const store = read("lib/amux/decisionMakerRequestStore.ts");
  const ended = store.slice(store.indexOf("export const amuxV22ResultReviewRequestEndedSql"),
    store.indexOf("export async function readNewestDecisionMakerRequestPerCard"));
  // Ended: the newest request only, routed to the operator, or closed with nothing to confirm.
  assert.match(ended, /q\."questionRevision" = \(SELECT max\(q2\."questionRevision"\)/);
  assert.match(ended, /q\."route" <> 'dm_proposal'/);
  assert.match(ended, /ev\."kind" IN \('assign_discarded', 'stale_close', 'direct_answer_close'\)/);
  assert.match(ended, /ev\."kind" = 'result' AND ev\."resultKind" IS DISTINCT FROM 'proposal'/);
  // A proposal waiting, a confirmation on its way and an owner's rejection still hold the card.
  assert.doesNotMatch(ended, /'confirm'|'edit_confirm'|'reject'/);
});

test("the owner queue shows the settlement once a result review no longer holds the card", async () => {
  const { amuxOwnerQueueDmView } = await import("../lib/amux/ownerQueueDmRequestCore.ts");
  const on = { killSwitch: false };
  const facts = (over) => ({ question: null, review: null, t2: null, settlement: null,
    escalationId: "e1", settlementEligible: false, ...over });
  const review = (over) => ({ id: "r1", localCardId: "card-r1", request: null, handoffReason: null, ...over });
  const closed = { requestId: "q1", result: "closed" };
  // CRAWL-003: the review's request ended; the scan would file the settlement.
  assert.deepEqual(amuxOwnerQueueDmView(facts({ review: review({ request: closed }), settlementEligible: true }), on),
    { source: "settlement", state: "waiting_relay", reason: null, requestId: null, action: null, sourceId: "e1" });
  // Once filed and asked, the settlement's own request is what the card shows.
  const settled = amuxOwnerQueueDmView(facts({ review: review({ request: closed }),
    settlement: { id: "s1", state: "open", localCardId: "card-s1", request: { requestId: "q2", result: null },
      handoffReason: null, cancelReason: null } }), on);
  assert.equal(settled.source, "settlement");
  assert.equal(settled.state, "asked");
  // Handed to a person by the walk: the same.
  assert.equal(amuxOwnerQueueDmView(facts({ review: review({ handoffReason: "answer_unreadable" }),
    settlementEligible: true }), on).source, "settlement");
  // Still the Decision Maker's (pending, or a confirmation the scan does not count as ended): the review.
  assert.equal(amuxOwnerQueueDmView(facts({ review: review({ request: { requestId: "q1", result: null } }),
    settlementEligible: true }), on).source, "result_review");
  assert.equal(amuxOwnerQueueDmView(facts({ review: review({ request: closed }), settlementEligible: false }), on)
    .source, "result_review", "a rejection or a confirmation the scan does not file stays the review's");
});
