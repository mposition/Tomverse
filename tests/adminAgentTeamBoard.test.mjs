import assert from "node:assert/strict";
import test from "node:test";

import { adminAgentPageMessages } from "../lib/adminMessages/agentPage.ts";
import {
  TEAM_BOARD_HREFS,
  TEAM_BOARD_KEYS,
  teamBoardCards,
  teamBoardTotals,
} from "../lib/adminAgentTeamBoardCore.ts";

const en = adminAgentPageMessages.en;
const ko = adminAgentPageMessages.ko;

const unread = { kind: "unread" };
const allUnread = {
  readAt: "2026-11-07T01:00:00.000Z",
  review: unread,
  decision: unread,
  digest: unread,
  queue: { marketing: null, amuxEscalations: null, amuxHalts: null },
  research: unread,
  qa: unread,
  finance: unread,
  routing: unread,
  sre: unread,
  support: unread,
  marketing: unread,
  trust: unread,
  engineering: unread,
  amux: unread,
};
const noExtras = { researchOpen: null, marketingCost: null, researchNextAt: null };

const cardsOf = (rooms, extras = noExtras, copy = en) =>
  Object.fromEntries(teamBoardCards(rooms, extras, copy.board, copy.status).map((card) => [card.key, card]));

test("the board has the ten teams, each pointing at a console address", () => {
  assert.equal(TEAM_BOARD_KEYS.length, 10);
  assert.equal(TEAM_BOARD_HREFS.trust, "/admin/agent-digests?tab=trust-safety");
  for (const key of TEAM_BOARD_KEYS) assert.match(TEAM_BOARD_HREFS[key], /^\/admin\//);
  const cards = teamBoardCards(allUnread, noExtras, en.board, en.status);
  assert.deepEqual(cards.map((card) => card.key), [...TEAM_BOARD_KEYS]);
});

test("a room that could not be read is unavailable, never off and never healthy", () => {
  const cards = cardsOf(allUnread);
  for (const key of TEAM_BOARD_KEYS) {
    assert.equal(cards[key].tone, "unknown", key);
    assert.equal(cards[key].running, "unknown", key);
    assert.equal(cards[key].dim, false, key);
  }
  const totals = teamBoardTotals(Object.values(cards));
  // Nothing was read: nothing is counted as running, and both totals say they are floors.
  assert.equal(totals.running, 0);
  assert.equal(totals.runningFloor, true);
  assert.equal(totals.waitingFloor, true);
  assert.equal(totals.cost, null);
});

test("waiting counts come from each team's own read and an unread count is a floor, not zero", () => {
  const rooms = {
    ...allUnread,
    queue: { marketing: 3, amuxEscalations: 1, amuxHalts: null },
    marketing: {
      kind: "observed",
      drafts: "on",
      publish: "off",
      pending: { count: 3, oldestAt: null },
      lastRun: { at: "2026-11-07T00:00:00.000Z" },
      calls: 4,
    },
    engineering: {
      kind: "observed",
      mode: "t1",
      frozen: false,
      killSwitch: false,
      halt: "none",
      pending: { t2Draft: 1, decision: 1, stateMismatch: 0 },
      activeRuns: 2,
      activeSince: null,
      lastRun: null,
      runnerLastFinishAt: null,
      publisherLastFinishAt: null,
    },
    amux: { kind: "no_catalog" },
  };
  const cards = cardsOf(rooms, { ...noExtras, researchOpen: 2 });
  assert.equal(cards.marketing.waiting, 3);
  assert.equal(cards.marketing.tone, "ok");
  assert.equal(cards.engineering.waiting, 2);
  assert.equal(cards.engineering.activity, "2 runs in progress");
  assert.equal(cards.research.waiting, 2);
  // One AMUX count is unknown, so the card has no number and says so.
  assert.equal(cards.amux.waiting, null);
  assert.equal(cards.amux.waitingUnread, true);
  const totals = teamBoardTotals(Object.values(cards));
  assert.equal(totals.waiting, 7);
  assert.equal(totals.waitingFloor, true);
});

test("off, halted and failing teams are told apart", () => {
  const rooms = {
    ...allUnread,
    marketing: { kind: "observed", drafts: "off", publish: "off", pending: { count: 0, oldestAt: null }, lastRun: null, calls: 0 },
    engineering: {
      kind: "observed", mode: "t1", frozen: false, killSwitch: false, halt: "circuit_open",
      pending: { t2Draft: 0, decision: 0, stateMismatch: 0 }, activeRuns: 0, activeSince: null, lastRun: null,
      runnerLastFinishAt: null, publisherLastFinishAt: null,
    },
    sre: { kind: "observed", head: { generation: 1, mode: "live" }, trustReason: "chain_broken", latestDigestAt: null },
    research: { kind: "disabled" },
    trust: { kind: "not_permitted" },
  };
  const cards = cardsOf(rooms);
  assert.equal(cards.marketing.tone, "idle");
  assert.equal(cards.marketing.dim, true);
  assert.equal(cards.engineering.tone, "warn");
  assert.equal(cards.sre.tone, "warn");
  assert.equal(cards.research.tone, "idle");
  assert.equal(cards.trust.tone, "unknown");
  assert.equal(cards.trust.activity, en.board.activity.notPermitted);
});

test("cost is summed only over teams that keep a record, and a missing cap is not zero", () => {
  const rooms = {
    ...allUnread,
    marketing: { kind: "observed", drafts: "on", publish: "on", pending: { count: 0, oldestAt: null }, lastRun: null, calls: 1 },
    routing: {
      kind: "observed", last: null, spentTodayMicroUsd: 0, spentMonthMicroUsd: 2_500_000,
      dayCapMicroUsd: 1_000_000, monthCapMicroUsd: 10_000_000, lastPromotedAt: null,
    },
  };
  const both = teamBoardTotals(
    Object.values(cardsOf(rooms, { ...noExtras, marketingCost: { spentMicroUsd: 4_100_000, capMicroUsd: 20_000_000 } })),
  );
  assert.deepEqual(both.cost, { spentMicroUsd: 6_600_000, capMicroUsd: 30_000_000, teams: 2 });
  const noCap = teamBoardTotals(
    Object.values(cardsOf(rooms, { ...noExtras, marketingCost: { spentMicroUsd: 4_100_000, capMicroUsd: null } })),
  );
  assert.equal(noCap.cost?.capMicroUsd, null);
  // An unreadable marketing month is "unknown" on its card and adds nothing to the sum.
  const unknown = cardsOf(rooms, noExtras);
  assert.equal(unknown.marketing.cost.kind, "unknown");
  const unknownTotals = teamBoardTotals(Object.values(unknown));
  assert.equal(unknownTotals.cost?.teams, 1);
  // The unread marketing month is carried to the total, which is then a floor, not the whole.
  assert.equal(unknownTotals.costUnread, 1);
  assert.equal(both.costUnread, 0);
  // A team with no cost record says so rather than showing 0.
  assert.equal(unknown.sre.cost.kind, "none");
});

test("the Korean copy fills every card in Korean", () => {
  const cards = cardsOf(allUnread, noExtras, ko);
  assert.equal(cards.marketing.name, "마케팅");
  assert.equal(cards.marketing.statusLabel, "확인 불가");
  assert.equal(cards.sre.activity, "읽지 못했어요.");
});

test("an unread room keeps its team's cost as unavailable, never as 'no record', and an off agent has no next run", () => {
  const cards = cardsOf(allUnread, { ...noExtras, researchNextAt: "2026-11-07T23:00:00.000Z" });
  // Marketing and the router keep a monthly record, so an unread room cannot erase it.
  assert.equal(cards.marketing.cost.kind, "unknown");
  assert.equal(cards.routing.cost.kind, "unknown");
  assert.equal(cards.sre.cost.kind, "none");
  const totals = teamBoardTotals(Object.values(cards));
  assert.equal(totals.cost, null);
  assert.equal(totals.costUnread, 2);
  // The generator's month is its own read: an unread marketing room still shows it.
  const kept = cardsOf(allUnread, { ...noExtras, marketingCost: { spentMicroUsd: 1_000_000, capMicroUsd: null } });
  assert.deepEqual(kept.marketing.cost, { kind: "known", spentMicroUsd: 1_000_000, capMicroUsd: null });
  // The research agent being off, or unread, draws no next-run time; only a running one does.
  const off = cardsOf({ ...allUnread, research: { kind: "disabled" } }, { ...noExtras, researchNextAt: "2026-11-07T23:00:00.000Z" });
  assert.equal(off.research.nextAt, null);
  assert.equal(cards.research.nextAt, null);
  const on = cardsOf(
    {
      ...allUnread,
      research: {
        kind: "observed", slot: "2026-11-07T21:30:00.000Z", slotState: "ok", failureStage: null,
        windowOpen: false, lastSuccessAt: null, silence: "recent", silenceHours: null,
      },
    },
    { ...noExtras, researchNextAt: "2026-11-07T23:00:00.000Z" },
  );
  assert.equal(on.research.nextAt, "2026-11-07T23:00:00.000Z");
});
