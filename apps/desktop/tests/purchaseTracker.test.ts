import assert from "node:assert/strict";
import test from "node:test";
import { desktopBillingResponse, type BillingUsage } from "../src/billing-contract";
import {
  CHECK_AGAIN_ATTEMPTS, createPurchaseTracker, PURCHASE_CHECK_ATTEMPTS, PURCHASE_CHECK_INTERVAL_MS, PURCHASE_RECORD_TTL_MS,
  REPEAT_HOLD_TTL_MS,
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
  tracker.windowClosed("cancelled");
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
  tracker.windowClosed("cancelled");
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

test("a new checkout clears the confirmations shown, never another item's unconfirmed record, and replaces its own item", async () => {
  const { tracker, server, usage, stages } = harness();
  tracker.begin(starter, usage(), 500);
  server.purchased = 500;
  tracker.windowClosed("closed");
  await flush();
  tracker.begin(pro, usage(), 0);
  tracker.windowClosed("cancelled");
  await flush();
  assert.deepEqual(stages(), ["subscription:unconfirmed"]);
  const before = tracker.records()[0].id;
  tracker.begin(project, usage(), 1_500);
  assert.deepEqual(stages(), ["subscription:unconfirmed", "credits:project_1500:open"]);
  // The customer chose to repeat the subscription: its record starts again from now.
  tracker.begin({ kind: "subscription", planId: "max" }, usage(), 0);
  const replaced = tracker.records().find(({ item }) => item === "subscription")!;
  assert.notEqual(replaced.id, before);
  assert.deepEqual(replaced.intent, { kind: "subscription", planId: "max" });
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
