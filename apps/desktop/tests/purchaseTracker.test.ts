import assert from "node:assert/strict";
import test from "node:test";
import { desktopBillingResponse, type BillingUsage } from "../src/billing-contract";
import {
  CHECK_AGAIN_ATTEMPTS, createPurchaseTracker, landedPacks, landedSubscription, PURCHASE_CHECK_ATTEMPTS, PURCHASE_CHECK_INTERVAL_MS,
  PURCHASE_RECORD_TTL_MS, REPEAT_HOLD_TTL_MS,
} from "../src/host/purchase-tracker";

const account = (plan: "Free" | "Pro" | "Max", purchased: number): BillingUsage => desktopBillingResponse.usage.parse({
  plan,
  subscription: { status: plan === "Free" ? null : "active", billingInterval: plan === "Free" ? null : "monthly",
    currentPeriodEnd: null, cancelAtPeriodEnd: false },
  balances: { dailyRemainingCredits: 30, dailyResetsAt: "2026-11-27T00:00:00.000Z", planRemainingCredits: 300,
    planResetsAt: "2026-12-01T00:00:00.000Z", purchasedRemainingCredits: purchased, purchasedEarliestExpiry: null },
});

const starter = { kind: "credits", packId: "starter_500" } as const;
const project = { kind: "credits", packId: "project_1500" } as const;
const pro = { kind: "subscription", planId: "pro" } as const;

/** A tracker over an account whose reads are scripted: `answers` are used in turn, then `now` is repeated. */
function harness() {
  const clock = { now: 1_000_000 };
  const server = { plan: "Free" as "Free" | "Pro" | "Max", purchased: 0, fail: false, reads: 0,
    /** Runs before each read is answered, with the read's number. */
    onRead: undefined as ((read: number) => void) | undefined };
  const waits: number[] = [];
  const signal = new AbortController();
  let changes = 0;
  let tokens = 0;
  const tracker = createPurchaseTracker({
    read: async () => {
      server.reads += 1;
      server.onRead?.(server.reads);
      if (server.fail) throw new TypeError("fetch failed");
      return account(server.plan, server.purchased);
    },
    changed: () => { changes += 1; },
    signal: signal.signal,
    now: () => clock.now,
    wait: async (ms) => { waits.push(ms); },
    token: () => `token-${++tokens}`,
  });
  const usage = () => account(server.plan, server.purchased);
  const stages = () => tracker.records().map(({ item, stage }) => `${item}:${stage}`);
  return { tracker, clock, server, waits, signal, usage, stages, changes: () => changes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a closed window is checked the same way whatever page it ended on, and a payment recorded late ends confirmed", async () => {
  for (const outcome of ["success", "cancelled", "closed", "returned"] as const) {
    const { tracker, server, waits, usage, stages } = harness();
    tracker.begin(starter, usage(), 500);
    assert.deepEqual(stages(), ["credits:starter_500:open"]);
    // The account shows the payment only on the third read after the window closed.
    server.onRead = (read) => { if (read === 3) server.purchased = 500; };
    tracker.windowClosed(outcome);
    assert.deepEqual(stages(), ["credits:starter_500:checking"]);
    await flush();
    assert.deepEqual(stages(), ["credits:starter_500:confirmed"], outcome);
    assert.equal(server.reads, 3, outcome);
    assert.equal(tracker.records()[0].cancelled, outcome === "cancelled");
    assert.deepEqual(waits, [PURCHASE_CHECK_INTERVAL_MS, PURCHASE_CHECK_INTERVAL_MS]);
  }
});

test("an account that never shows the purchase is unconfirmed after every read; failed reads count as not shown", async () => {
  const { tracker, server, usage, stages } = harness();
  tracker.begin(pro, usage(), 0);
  server.fail = true;
  tracker.windowClosed("success");
  await flush();
  assert.equal(server.reads, PURCHASE_CHECK_ATTEMPTS);
  assert.deepEqual(stages(), ["subscription:unconfirmed"]);
  // "Check again" reads again, a little less often, and the plan the server now shows confirms it.
  server.fail = false;
  assert.equal(tracker.checkAgain("subscription"), true);
  await flush();
  assert.equal(server.reads, PURCHASE_CHECK_ATTEMPTS + CHECK_AGAIN_ATTEMPTS);
  server.plan = "Pro";
  assert.equal(tracker.checkAgain("subscription"), true);
  await flush();
  assert.deepEqual(stages(), ["subscription:confirmed"]);
  assert.equal(tracker.checkAgain("subscription"), false, "a confirmed record has nothing to check");
  assert.equal(tracker.checkAgain("credits:starter_500"), false);
});

test("each item keeps its own record: buying another pack or the subscription leaves pack A unconfirmed", async () => {
  const { tracker, usage, stages } = harness();
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("returned");
  await flush();
  tracker.begin(project, usage(), 1_500);
  tracker.windowClosed("closed");
  await flush();
  tracker.begin(pro, usage(), 0);
  tracker.windowClosed("success");
  await flush();
  assert.deepEqual(stages(), ["credits:starter_500:unconfirmed", "credits:project_1500:unconfirmed", "subscription:unconfirmed"]);
  assert.equal(tracker.admit(starter, usage()).kind, "held");
  assert.equal(tracker.admit({ kind: "subscription", planId: "max" }, usage()).kind, "held");
  // A pack bought for the first time is not held.
  assert.equal(tracker.admit({ kind: "credits", packId: "team_5000" }, usage()).kind, "proceed");
});

test("one balance increase confirms only the pack it can belong to", () => {
  const { tracker, server, usage, stages } = harness();
  server.purchased = 200;
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("closed");
  tracker.begin(project, usage(), 1_500);
  // Project lands: +1,500 is more than Starter alone could explain, and leaves nothing for Starter.
  server.purchased = 1_700;
  assert.equal(tracker.admit({ kind: "credits", packId: "team_5000" }, usage()).kind, "proceed");
  assert.deepEqual(stages(), ["credits:starter_500:checking", "credits:project_1500:confirmed"]);
  assert.equal(tracker.admit(starter, usage()).kind, "held");
  // Starter lands later: the next increase is its own.
  server.purchased = 2_200;
  assert.equal(tracker.admit(starter, usage()).kind, "settled");
  assert.deepEqual(stages(), ["credits:starter_500:confirmed", "credits:project_1500:confirmed"]);
});

test("an increase that either pending pack could explain confirms neither; both landing confirms both", () => {
  const first = harness();
  first.tracker.begin(starter, first.usage(), 500);
  first.tracker.windowClosed("closed");
  first.tracker.begin({ kind: "credits", packId: "starter_plus_500" }, first.usage(), 500);
  first.server.purchased = 500;
  first.tracker.admit(project, first.usage());
  assert.deepEqual(first.stages().map((stage) => stage.split(":").at(-1)), ["checking", "open"]);

  const both = harness();
  both.tracker.begin(starter, both.usage(), 500);
  both.tracker.windowClosed("closed");
  both.tracker.begin(project, both.usage(), 1_500);
  both.server.purchased = 2_000;
  both.tracker.admit({ kind: "credits", packId: "team_5000" }, both.usage());
  assert.deepEqual(both.stages(), ["credits:starter_500:confirmed", "credits:project_1500:confirmed"]);

  // A pack whose size is unknown could explain any increase, so it never lets another pack be confirmed by guesswork.
  const unknown = harness();
  unknown.tracker.begin(starter, unknown.usage(), 500);
  unknown.tracker.windowClosed("closed");
  unknown.tracker.begin(project, unknown.usage(), Infinity);
  unknown.server.purchased = 500;
  unknown.tracker.admit({ kind: "credits", packId: "team_5000" }, unknown.usage());
  assert.deepEqual(unknown.stages().map((stage) => stage.split(":").at(-1)), ["checking", "open"]);
});

test("a hold is one-time, bound to its item and short-lived", () => {
  const { tracker, clock, usage } = harness();
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("closed");
  const held = tracker.admit(starter, usage());
  assert.deepEqual(held, { kind: "held", hold: "token-2" });
  assert.equal(tracker.admit(starter, usage(), "made-up").kind, "held");
  const next = tracker.admit(starter, usage());
  assert.equal(next.kind, "held");
  const hold = (next as { hold: string }).hold;
  assert.deepEqual(tracker.admit(starter, usage(), hold), { kind: "proceed" });
  assert.equal(tracker.admit(starter, usage(), hold).kind, "held", "a spent hold does not open a second checkout");
  const late = (tracker.admit(starter, usage()) as { hold: string }).hold;
  clock.now += REPEAT_HOLD_TTL_MS;
  assert.equal(tracker.admit(starter, usage(), late).kind, "held", "an answer to an old warning needs a fresh one");
});

test("a new checkout clears the confirmations shown and keeps every unconfirmed attempt, its own item's included", async () => {
  const { tracker, server, usage, stages } = harness();
  tracker.begin(starter, usage(), 500);
  server.purchased = 500;
  tracker.windowClosed("closed");
  await flush();
  tracker.begin(pro, usage(), 0);
  tracker.windowClosed("cancelled");
  await flush();
  assert.deepEqual(stages(), ["subscription:unconfirmed"]);
  const first = tracker.records()[0].id;
  tracker.begin(project, usage(), 1_500);
  assert.deepEqual(stages(), ["subscription:unconfirmed", "credits:project_1500:open"]);
  // The customer chose to repeat the subscription: a second attempt is added beside the first.
  tracker.begin({ kind: "subscription", planId: "max" }, usage(), 0);
  const attempts = tracker.records().filter(({ item }) => item === "subscription");
  assert.deepEqual(attempts.map(({ id, intent, stage }) => [id === first, intent, stage]), [
    [true, { kind: "subscription", planId: "pro" }, "unconfirmed"], [false, { kind: "subscription", planId: "max" }, "open"],
  ]);
});

test("an attempt that came back through the cancel page does not hold the next one back, and can still be confirmed", async () => {
  const { tracker, server, usage, stages } = harness();
  server.purchased = 100;
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("cancelled");
  // While the account is still being read, and after the reads ran out: no warning either way.
  assert.equal(tracker.admit(starter, usage()).kind, "proceed");
  await flush();
  assert.deepEqual(stages(), ["credits:starter_500:unconfirmed"]);
  assert.equal(tracker.admit(starter, usage()).kind, "proceed");
  // The second window is closed without a return page: that attempt's outcome is unknown, so a third is held.
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("closed");
  await flush();
  assert.equal(tracker.admit(starter, usage()).kind, "held");
  // One pack lands: the oldest attempt is confirmed, the unknown one keeps holding.
  server.purchased = 600;
  assert.equal(tracker.admit(starter, usage()).kind, "held");
  assert.deepEqual(stages(), ["credits:starter_500:confirmed", "credits:starter_500:unconfirmed"]);
});

test("a cancelled subscription checkout does not hold another plan's checkout back; a closed one does", async () => {
  const { tracker, usage } = harness();
  tracker.begin(pro, usage(), 0);
  tracker.windowClosed("cancelled");
  await flush();
  assert.equal(tracker.admit({ kind: "subscription", planId: "max" }, usage()).kind, "proceed");
  tracker.begin({ kind: "subscription", planId: "max" }, usage(), 0);
  tracker.windowClosed("closed");
  await flush();
  assert.equal(tracker.admit(pro, usage()).kind, "held");
});

/** Runs the warning and then the customer's choice for `intent`, and records a second attempt of it. */
function repeatAfterWarning(h: ReturnType<typeof harness>, intent: Parameters<ReturnType<typeof harness>["tracker"]["admit"]>[0],
  credits: number) {
  const held = h.tracker.admit(intent, h.usage());
  assert.equal(held.kind, "held");
  assert.deepEqual(h.tracker.admit(intent, h.usage(), (held as { hold: string }).hold), { kind: "proceed" });
  h.tracker.begin(intent, h.usage(), credits);
}

test("the same pack paid twice through the warning: one pack's increase confirms one attempt and the warning stays", async () => {
  const h = harness();
  h.server.purchased = 100;
  h.tracker.begin(starter, h.usage(), 500);
  h.tracker.windowClosed("closed");
  await flush();
  repeatAfterWarning(h, starter, 500);
  h.tracker.windowClosed("closed");
  await flush();
  assert.deepEqual(h.stages(), ["credits:starter_500:unconfirmed", "credits:starter_500:unconfirmed"]);
  // The first payment lands late: one pack's worth. Which attempt it was cannot be told, so the oldest is
  // confirmed and the other stays unconfirmed; a third purchase of the pack is still held back.
  h.server.purchased = 600;
  assert.equal(h.tracker.admit(starter, h.usage()).kind, "held");
  assert.deepEqual(h.stages(), ["credits:starter_500:confirmed", "credits:starter_500:unconfirmed"]);
  // The same balance read again proves nothing more.
  assert.equal(h.tracker.admit(starter, h.usage()).kind, "held");
  // The second lands too: both are confirmed and the pack is free to buy again.
  h.server.purchased = 1_100;
  assert.deepEqual(h.tracker.admit(starter, h.usage()), { kind: "settled" });
  assert.deepEqual(h.stages(), ["credits:starter_500:confirmed", "credits:starter_500:confirmed"]);
  assert.deepEqual(h.tracker.admit(starter, h.usage()), { kind: "proceed" });
});

test("the same pack paid twice and both land at once: both attempts are confirmed by one read", async () => {
  const h = harness();
  h.tracker.begin(starter, h.usage(), 500);
  h.tracker.windowClosed("closed");
  await flush();
  repeatAfterWarning(h, starter, 500);
  h.server.purchased = 1_000;
  h.tracker.windowClosed("closed");
  await flush();
  assert.deepEqual(h.stages(), ["credits:starter_500:confirmed", "credits:starter_500:confirmed"]);
  assert.deepEqual(h.tracker.admit(starter, h.usage()), { kind: "proceed" });
});

test("the subscription tried twice through the warning: the plan change confirms one attempt and the warning stays", async () => {
  const h = harness();
  h.tracker.begin(pro, h.usage(), 0);
  h.tracker.windowClosed("success");
  await flush();
  repeatAfterWarning(h, pro, 0);
  h.tracker.windowClosed("success");
  await flush();
  assert.deepEqual(h.stages(), ["subscription:unconfirmed", "subscription:unconfirmed"]);
  h.server.plan = "Pro";
  assert.equal(h.tracker.admit(pro, h.usage()).kind, "held");
  assert.deepEqual(h.stages(), ["subscription:confirmed", "subscription:unconfirmed"]);
  // A second Session paid on top of an active plan would be a second subscription: the warning stays, for
  // another plan too, and reads of the same plan never confirm the remaining attempt.
  assert.equal(h.tracker.admit({ kind: "subscription", planId: "max" }, h.usage()).kind, "held");
  assert.equal(h.tracker.checkAgain("subscription"), true);
  await flush();
  assert.deepEqual(h.stages(), ["subscription:confirmed", "subscription:unconfirmed"]);
  // It ends when its own day is over.
  h.clock.now += PURCHASE_RECORD_TTL_MS;
  assert.equal(h.tracker.admit(pro, h.usage()).kind, "proceed");
});

test("each attempt expires a day after its own start", async () => {
  const h = harness();
  h.tracker.begin(starter, h.usage(), 500);
  h.tracker.windowClosed("closed");
  await flush();
  h.clock.now += PURCHASE_RECORD_TTL_MS / 2;
  repeatAfterWarning(h, starter, 500);
  h.tracker.windowClosed("closed");
  await flush();
  assert.equal(h.tracker.records().length, 2);
  h.clock.now += PURCHASE_RECORD_TTL_MS / 2;
  // The first is a day old and gone; the second is half a day old and still warns.
  assert.deepEqual(h.stages(), ["credits:starter_500:unconfirmed"]);
  assert.equal(h.tracker.admit(starter, h.usage()).kind, "held");
  h.clock.now += PURCHASE_RECORD_TTL_MS / 2;
  assert.deepEqual(h.stages(), []);
  assert.equal(h.tracker.admit(starter, h.usage()).kind, "proceed");
});

type PackCase = { name: string; balance: number; pending: Array<[id: string, item: string, before: number, credits: number]>;
  landed: string[]; before?: Record<string, number> };

test("credit-pack attribution: an increase confirms only the attempts it proves, oldest first per pack", () => {
  const cases: PackCase[] = [
    { name: "one attempt, any increase", balance: 600, pending: [["a1", "starter", 500, 500]], landed: ["a1"] },
    { name: "one attempt, a smaller increase (credits spent meanwhile)", balance: 550, pending: [["a1", "starter", 500, 500]],
      landed: ["a1"] },
    { name: "one attempt, no increase", balance: 500, pending: [["a1", "starter", 500, 500]], landed: [], before: { a1: 500 } },
    { name: "one attempt, the balance fell", balance: 300, pending: [["a1", "starter", 500, 500]], landed: [] },
    { name: "same pack twice, one pack's worth", balance: 500,
      pending: [["a1", "starter", 0, 500], ["a2", "starter", 0, 500]], landed: ["a1"], before: { a2: 500 } },
    { name: "same pack twice, two packs' worth", balance: 1_000,
      pending: [["a1", "starter", 0, 500], ["a2", "starter", 0, 500]], landed: ["a1", "a2"] },
    { name: "same pack twice, more than one pack can add", balance: 600,
      pending: [["a1", "starter", 0, 500], ["a2", "starter", 0, 500]], landed: ["a1", "a2"] },
    { name: "same pack three times, two packs' worth", balance: 1_000,
      pending: [["a1", "starter", 0, 500], ["a2", "starter", 0, 500], ["a3", "starter", 0, 500]], landed: ["a1", "a2"],
      before: { a3: 1_000 } },
    { name: "same pack twice, the second started after the first's baseline grew", balance: 2_500,
      pending: [["a1", "starter", 2_000, 500], ["a2", "starter", 2_000, 500]], landed: ["a1"], before: { a2: 2_500 } },
    { name: "two packs, the larger landed", balance: 1_500,
      pending: [["s", "starter", 0, 500], ["p", "project", 0, 1_500]], landed: ["p"], before: { s: 1_500 } },
    { name: "two packs, an increase either could explain", balance: 500,
      pending: [["s", "starter", 0, 500], ["p", "project", 0, 1_500]], landed: [] },
    { name: "two packs of one size, one pack's worth", balance: 500,
      pending: [["s", "starter", 0, 500], ["t", "starter_plus", 0, 500]], landed: [] },
    { name: "two packs, both landed", balance: 2_000,
      pending: [["s", "starter", 0, 500], ["p", "project", 0, 1_500]], landed: ["s", "p"] },
    { name: "two packs, more than the larger can add alone", balance: 1_600,
      pending: [["s", "starter", 0, 500], ["p", "project", 0, 1_500]], landed: ["s", "p"] },
    { name: "same pack twice beside another pack, only the other could add this much", balance: 1_500,
      pending: [["a1", "starter", 0, 500], ["a2", "starter", 0, 500], ["p", "project", 0, 1_500]], landed: ["p"],
      before: { a1: 1_500, a2: 1_500 } },
    { name: "same pack twice beside another pack, ambiguous", balance: 1_000,
      pending: [["a1", "starter", 0, 500], ["a2", "starter", 0, 500], ["p", "project", 0, 1_500]], landed: [] },
    { name: "an unknown size alone, any increase", balance: 100, pending: [["u", "team", 0, Infinity]], landed: ["u"] },
    { name: "an unknown size beside a known pack", balance: 500,
      pending: [["s", "starter", 0, 500], ["u", "team", 0, Infinity]], landed: [] },
    { name: "an unknown size twice, one proven at most", balance: 10_000,
      pending: [["u1", "team", 0, Infinity], ["u2", "team", 0, Infinity]], landed: ["u1"] },
    { name: "a known and an unknown attempt of one pack: counted with the larger size", balance: 600,
      pending: [["k", "starter", 0, 500], ["u", "starter", 0, Infinity]], landed: ["k"] },
  ];
  for (const { name, balance, pending, landed, before } of cases) {
    const result = landedPacks(balance, pending.map(([id, item, base, credits]) =>
      ({ id, item: `credits:${item}` as const, before: base, credits })));
    assert.deepEqual(result.landed, landed, name);
    assert.deepEqual(result.pending.map(({ id }) => id), pending.map(([id]) => id).filter((id) => !landed.includes(id)), name);
    for (const [id, value] of Object.entries(before ?? {})) {
      assert.equal(result.pending.find((attempt) => attempt.id === id)?.before, value, `${name}: ${id}`);
    }
  }
});

test("subscription attribution: a plan change confirms the oldest attempt for that plan, and no other", () => {
  const cases: Array<{ name: string; plan: "Free" | "Pro" | "Max"; pending: Array<[string, "Pro" | "Max", "Free" | "Pro" | "Max"]>;
    landed: string | null; before: Array<"Free" | "Pro" | "Max"> }> = [
    { name: "no change", plan: "Free", pending: [["s1", "Pro", "Free"]], landed: null, before: ["Free"] },
    { name: "the plan bought", plan: "Pro", pending: [["s1", "Pro", "Free"]], landed: "s1", before: [] },
    { name: "another plan", plan: "Max", pending: [["s1", "Pro", "Free"]], landed: null, before: ["Free"] },
    { name: "already on the plan when it began", plan: "Pro", pending: [["s1", "Pro", "Pro"]], landed: null, before: ["Pro"] },
    { name: "two attempts for one plan", plan: "Pro", pending: [["s1", "Pro", "Free"], ["s2", "Pro", "Free"]], landed: "s1",
      before: ["Pro"] },
    { name: "two attempts, the newer one's plan", plan: "Max", pending: [["s1", "Pro", "Free"], ["s2", "Max", "Free"]], landed: "s2",
      before: ["Max"] },
  ];
  for (const { name, plan, pending, landed, before } of cases) {
    const result = landedSubscription(plan, pending.map(([id, tier, base]) => ({ id, tier, before: base })));
    assert.equal(result.landed, landed, name);
    assert.deepEqual(result.pending.map((attempt) => attempt.before), before, name);
  }
});

test("records older than a day are dropped, and none outlives the account session", async () => {
  const { tracker, clock, signal, usage, stages, changes } = harness();
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("closed");
  await flush();
  clock.now += PURCHASE_RECORD_TTL_MS - 1;
  assert.deepEqual(stages(), ["credits:starter_500:unconfirmed"]);
  clock.now += 1;
  assert.deepEqual(stages(), []);
  assert.equal(tracker.admit(starter, usage()).kind, "proceed");
  assert.equal(PURCHASE_RECORD_TTL_MS, 24 * 60 * 60_000);

  tracker.begin(project, usage(), 1_500);
  const published = changes();
  signal.abort();
  assert.deepEqual(tracker.records(), []);
  assert.equal(changes(), published + 1, "the emptied list is published once");
  // After the session ends nothing is recorded or checked.
  tracker.begin(starter, usage(), 500);
  tracker.windowClosed("closed");
  assert.equal(tracker.checkAgain("credits:starter_500"), false);
  assert.deepEqual(tracker.records(), []);
});

test("a check still running when the account session ends reports nothing", async () => {
  const { tracker, server, signal, usage, changes } = harness();
  tracker.begin(starter, usage(), 500);
  server.fail = true;
  tracker.windowClosed("closed");
  signal.abort();
  const published = changes();
  await flush();
  assert.equal(changes(), published);
  assert.deepEqual(tracker.records(), []);
  assert.ok(server.reads <= 1);
});
