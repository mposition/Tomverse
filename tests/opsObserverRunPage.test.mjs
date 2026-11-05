// One page-service run, driven through every branch with an injected fetch
// (docs/policy/sre-ops.md §1 item 1, §3 rules 1, 3, 7 and 9, §5, decision
// T-1): the owner date is Brisbane's, an untrusted state sends nothing and
// beats nothing, the reservation is exactly what the budget admits, shadow
// confirms without a webhook, live posts once and never twice, a withheld
// heartbeat is withheld, and the log line carries no secret or URL.

import assert from "node:assert/strict";
import test from "node:test";

import { parseAdvanceRequest } from "../scripts/ops-observer/advance-request-core.mjs";
import { S2_PAGE_KEYS, initialKeyState } from "../scripts/ops-observer/classify-core.mjs";
import { renderChannelCheckMessage, renderPageMessage } from "../scripts/ops-observer/content-guard-core.mjs";
import { OWNER_TIME_ZONE, inChannelCheckWindow, ownerDateOf, planAdvance, runIdOf, runPage } from "../scripts/ops-observer/run-page-core.mjs";
import { buildSnapshot } from "../scripts/ops-observer/snapshot-core.mjs";

const APP = "https://tomverse.app";
const HEARTBEAT = "https://hc.example.test/ping/abc";
const SECRET = "s".repeat(40);
const ENV = { OPS_OBSERVER_APP_URL: APP, OPS_OBSERVER_SECRET: SECRET, OPS_OBSERVER_HEARTBEAT_URL: HEARTBEAT };
const START = Date.parse("2026-10-07T21:00:00.000Z"); // 07:00 on 2026-10-08 in Brisbane
const GENESIS = "11111111-1111-4111-8111-111111111111";
const DELIVERY = "22222222-2222-4222-8222-222222222222";
const P3 = "P3#credit_reservation_reconciliation";
const initial = () => Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));

const snapshot = ({ reconciliationStuck = false } = {}) =>
  buildSnapshot({
    readiness: { status: "fulfilled", value: { checks: { database: true, securityEnvironment: true, providerBudgets: true,
      emailSnapshotKeyring: true, emailSendingIdentity: true } } },
    jobs: { status: "fulfilled", value: [
      { key: "credit_reservation_reconciliation", status: reconciliationStuck ? "stuck" : "success", delayed: false,
        lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
      { key: "standard_email_drain", status: "success", delayed: false, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
    ] },
    budgets: { status: "fulfilled", value: { usageUnavailable: false, providers: [] } },
    now: new Date(START),
    commitSha: "a".repeat(40),
  }).snapshot;

const trusted = (overrides = {}) => ({
  trust: "trusted", genesisId: GENESIS, mode: "shadow", generation: 4, keys: initial(), reservedOpen: false,
  budget: { ownerDate: "2026-10-08", reservedToday: [], channelCheckTaken: false }, ...overrides,
});

/** A fake app: each path answers from `routes`, and every call is recorded. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.origin === APP ? `${parsed.pathname}${parsed.search}` : url;
    calls.push({ path, method: init.method, auth: init.headers.authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    const answer = routes[path];
    if (answer === undefined) throw new Error(`unexpected ${path}`);
    if (answer instanceof Error) throw answer;
    const [status, json] = typeof answer === "function" ? answer(calls.at(-1).body) : answer;
    return { status, text: async () => (json === undefined ? "" : JSON.stringify(json)) };
  };
  return { fetchImpl, calls, paths: () => calls.map((call) => call.path) };
}

const run = (fake, { env = ENV, now = () => START, log, sleep = async () => {} } = {}) => {
  const lines = [];
  return runPage({ env, fetchImpl: fake.fetchImpl, now, random: () => "abcdef0123456789abcdef", log: log ?? ((line) => lines.push(line)), sleep })
    .then((result) => ({ ...result, lines }));
};

test("the owner date is the calendar date in Australia/Brisbane, which has no daylight saving", () => {
  assert.equal(OWNER_TIME_ZONE, "Australia/Brisbane");
  const brisbane = new Intl.DateTimeFormat("en-CA", { timeZone: OWNER_TIME_ZONE });
  for (const iso of ["2026-10-07T13:59:59.999Z", "2026-10-07T14:00:00.000Z", "2026-01-15T03:00:00.000Z",
    "2026-07-01T20:00:00.000Z", "2026-12-31T14:30:00.000Z"]) {
    assert.equal(ownerDateOf(Date.parse(iso)), brisbane.format(new Date(iso)), iso);
  }
  assert.equal(ownerDateOf(Date.parse("2026-10-07T13:59:59.999Z")), "2026-10-07");
  assert.equal(ownerDateOf(Date.parse("2026-10-07T14:00:00.000Z")), "2026-10-08");
  assert.match(runIdOf(START, "ABCDEF-0123-xyz"), /^[0-9a-z][0-9a-z:_-]{0,127}$/);
});

test("an untrusted state ends the run with no advance, nothing sent and no heartbeat", async () => {
  const fake = fakeFetch({
    "/api/health": [200, { ok: true }],
    "/api/internal/ops-snapshot": [200, snapshot()],
    "/api/internal/ops-observer/state": [200, { trust: "audit_unverified" }],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [1, "untrusted"]);
  assert.deepEqual(fake.paths(), ["/api/health", "/api/internal/ops-snapshot", "/api/internal/ops-observer/state"]);
  assert.equal(JSON.parse(result.lines[0]).reason, "audit_unverified");
});

test("a quiet run advances with no reservation and beats", async () => {
  const fake = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot()],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "noop", sendPermitted: false, heartbeatWithheld: false, generation: 4 }],
    [HEARTBEAT]: [200],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [0, "noop"]);
  const state = fake.calls[2];
  assert.equal(state.auth, `Bearer ${SECRET}`);
  assert.deepEqual(state.body, { runDeadline: "2026-10-07T21:03:00.000Z", ownerDate: "2026-10-08" });
  const advance = fake.calls[3].body;
  assert.equal(advance.reservation, null);
  assert.deepEqual([advance.baseGenesisId, advance.baseGeneration], [GENESIS, 4]);
  // Health and heartbeat carry no bearer; the internal routes do.
  assert.deepEqual(fake.calls.map((call) => call.auth !== null), [false, true, true, true, false]);
  assert.equal(fake.calls[4].method, "GET");
});

test("an owed page is reserved, held to the content guard and, in shadow, confirmed without a webhook", async () => {
  const fake = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot({ reconciliationStuck: true })],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }],
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
    [HEARTBEAT]: [200],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [0, "advanced"]);
  const advance = fake.calls[3].body;
  assert.equal(advance.keys[P3].status, "open");
  assert.deepEqual(advance.reservation, {
    ownerDate: "2026-10-08", channelCheck: false,
    items: [{ signal: "P3", scope: "credit_reservation_reconciliation", kind: "new_open", origin: "new", openedAt: START }],
  });
  assert.deepEqual(fake.calls[4].body, { runDeadline: "2026-10-07T21:03:00.000Z", deliveryId: DELIVERY, runId: advance.runId });
  assert.deepEqual(fake.paths(), ["/api/health", "/api/internal/ops-snapshot", "/api/internal/ops-observer/state",
    "/api/internal/ops-observer/advance", "/api/internal/ops-observer/confirm", HEARTBEAT]);
  const line = JSON.parse(result.lines[0]);
  assert.deepEqual([line.reservedItems, line.deferred, line.shadowed, line.mode], [1, 0, true, "shadow"]);
});

const WEBHOOK = "https://hooks.slack.com/services/T/B/x";
const LIVE_ENV = { ...ENV, OPS_OBSERVER_PAGE_WEBHOOK_URL: WEBHOOK };
const permitted = [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }];
const liveRoutes = (overrides = {}) => ({
  "/api/health": [200, {}],
  "/api/internal/ops-snapshot": [200, snapshot({ reconciliationStuck: true })],
  "/api/internal/ops-observer/state": [200, trusted({ mode: "live" })],
  "/api/internal/ops-observer/advance": permitted,
  [WEBHOOK]: [200],
  "/api/internal/ops-observer/confirm": [200, { result: "confirmed" }],
  [HEARTBEAT]: [200],
  ...overrides,
});

test("a live page is posted once with the fixed sentence and link, confirmed, then beats", async () => {
  const fake = fakeFetch(liveRoutes());
  const result = await run(fake, { env: LIVE_ENV });
  assert.deepEqual([result.exitCode, result.outcome], [0, "advanced"]);
  assert.deepEqual(fake.paths(), ["/api/health", "/api/internal/ops-snapshot", "/api/internal/ops-observer/state",
    "/api/internal/ops-observer/advance", WEBHOOK, "/api/internal/ops-observer/confirm", HEARTBEAT]);
  const post = fake.calls.find((call) => call.path === WEBHOOK);
  assert.equal(post.auth, null, "the app secret never goes to the webhook");
  assert.equal(post.body.text, renderPageMessage({ itemId: DELIVERY, withChannelCheck: false }));
  assert.deepEqual(Object.keys(post.body).sort(), ["text", "unfurl_links", "unfurl_media"]);
  assert.equal(JSON.parse(result.lines[0]).sent, true);
});

test("a failed post is not retried and not confirmed; the next run abandons it", async () => {
  for (const answer of [[500], [404], new Error("connection reset")]) {
    const fake = fakeFetch(liveRoutes({ [WEBHOOK]: answer }));
    const result = await run(fake, { env: LIVE_ENV });
    assert.deepEqual([result.exitCode, result.outcome], [1, "send_failed"]);
    assert.equal(fake.paths().filter((path) => path === WEBHOOK).length, 1);
    assert.equal(fake.paths().at(-1), WEBHOOK, "no confirm and no heartbeat");
  }
});

test("a sent page whose confirm fails beats nothing and posts nothing more", async () => {
  const fake = fakeFetch(liveRoutes({ "/api/internal/ops-observer/confirm": [200, { result: "abandoned" }] }));
  const result = await run(fake, { env: LIVE_ENV });
  assert.deepEqual([result.exitCode, result.outcome], [1, "confirm_refused"]);
  assert.equal(fake.paths().filter((path) => path === WEBHOOK).length, 1);
  assert.equal(fake.paths().includes(HEARTBEAT), false);
});

test("a live chain without a Slack webhook reserves nothing and beats nothing", async () => {
  for (const env of [ENV, { ...ENV, OPS_OBSERVER_PAGE_WEBHOOK_URL: "https://evil.example.test/hook" }]) {
    const fake = fakeFetch(liveRoutes());
    const result = await run(fake, { env });
    assert.deepEqual([result.exitCode, result.outcome], [1, "webhook_not_slack"]);
    assert.equal(fake.paths().at(-1), "/api/internal/ops-observer/state");
  }
});

test("a shadow chain never touches the webhook, even when one is configured", async () => {
  const fake = fakeFetch(liveRoutes({
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
  }));
  const result = await run(fake, { env: LIVE_ENV });
  assert.deepEqual([result.exitCode, result.outcome], [0, "advanced"]);
  assert.equal(fake.paths().includes(WEBHOOK), false);
});

test("the channel check window is Tuesday 10:00-12:00 in Brisbane", () => {
  assert.equal(inChannelCheckWindow(Date.parse("2026-11-03T00:00:00.000Z")), true, "Tue 10:00");
  assert.equal(inChannelCheckWindow(Date.parse("2026-11-03T01:59:59.000Z")), true, "Tue 11:59");
  assert.equal(inChannelCheckWindow(Date.parse("2026-11-02T23:59:59.000Z")), false, "Mon-to-Tue 09:59");
  assert.equal(inChannelCheckWindow(Date.parse("2026-11-03T02:00:00.000Z")), false, "Tue 12:00");
  assert.equal(inChannelCheckWindow(Date.parse("2026-11-04T00:00:00.000Z")), false, "Wed 10:00");
});

test("in the window a quiet live chain posts the check alone, with no link", async () => {
  const fake = fakeFetch(liveRoutes({ "/api/internal/ops-snapshot": [200, snapshot()] }));
  const result = await run(fake, { env: LIVE_ENV, now: () => Date.parse("2026-11-03T00:10:00.000Z") });
  assert.deepEqual([result.exitCode, result.outcome], [0, "advanced"]);
  const advance = fake.calls.find((call) => call.path === "/api/internal/ops-observer/advance");
  assert.deepEqual([advance.body.reservation.channelCheck, advance.body.reservation.items], [true, []]);
  assert.equal(fake.calls.find((call) => call.path === WEBHOOK).body.text, renderChannelCheckMessage());
});

test("in the window a page carries the check; a check already taken or a shadow chain asks for none", async () => {
  const inWindow = () => Date.parse("2026-11-03T00:10:00.000Z");
  const withPage = fakeFetch(liveRoutes());
  await run(withPage, { env: LIVE_ENV, now: inWindow });
  assert.equal(withPage.calls.find((call) => call.path === WEBHOOK).body.text, renderPageMessage({ itemId: DELIVERY, withChannelCheck: true }));

  const quiet = { "/api/internal/ops-snapshot": [200, snapshot()], "/api/internal/ops-observer/advance": [200, { result: "noop", heartbeatWithheld: false, generation: 4 }] };
  const taken = fakeFetch(liveRoutes({ ...quiet, "/api/internal/ops-observer/state": [200, trusted({ mode: "live",
    budget: { ownerDate: "2026-11-03", reservedToday: [], channelCheckTaken: true } })] }));
  await run(taken, { env: LIVE_ENV, now: inWindow });
  assert.equal(taken.calls.find((call) => call.path === "/api/internal/ops-observer/advance").body.reservation, null);

  const shadow = fakeFetch(liveRoutes({ ...quiet, "/api/internal/ops-observer/state": [200, trusted()] }));
  await run(shadow, { env: LIVE_ENV, now: inWindow });
  assert.equal(shadow.calls.find((call) => call.path === "/api/internal/ops-observer/advance").body.reservation, null);
});

const budgetSnapshot = (band) => {
  const used = { ">=95": 96, exhausted: 100, "<70": 10 }[band];
  return buildSnapshot({
    readiness: { status: "fulfilled", value: { checks: { database: true, securityEnvironment: true, providerBudgets: true,
      emailSnapshotKeyring: true, emailSendingIdentity: true } } },
    jobs: { status: "fulfilled", value: [
      { key: "credit_reservation_reconciliation", status: "success", delayed: false, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
      { key: "standard_email_drain", status: "success", delayed: false, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
    ] },
    budgets: { status: "fulfilled", value: { usageUnavailable: false, providers: [{ provider: "openai", periods: [
      { period: "day", usedMicroUsd: used, limitMicroUsd: 100, resetAt: new Date(START + 3_600_000).toISOString() },
    ] }] } },
    now: new Date(START),
    commitSha: "a".repeat(40),
  }).snapshot;
};
const BUDGET_KEY = "P-B#openai_day";

test("budget pages are off without the switch, and a bad window opens one with it", async () => {
  const routes = liveRoutes({
    "/api/internal/ops-snapshot": [200, budgetSnapshot(">=95")],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
  });
  const off = fakeFetch(routes);
  await run(off);
  const offBody = off.calls.find((call) => call.path.endsWith("/advance")).body;
  assert.equal(Object.hasOwn(offBody.keys, BUDGET_KEY), false);
  assert.equal(offBody.reservation, null);

  const on = fakeFetch(routes);
  await run(on, { env: { ...ENV, OPS_OBSERVER_S3_BUDGET_PAGES: "true" } });
  const onBody = on.calls.find((call) => call.path.endsWith("/advance")).body;
  assert.equal(onBody.keys[BUDGET_KEY].status, "open");
  assert.deepEqual(onBody.reservation.items.map((item) => [item.signal, item.scope, item.kind]), [["P-B", "openai_day", "new_open"]]);
  const parsed = parseAdvanceRequest(JSON.stringify(onBody), START);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

test("a budget key worsens at exhausted, recovers after two good runs, and holds when the report is gone", () => {
  const plan = (keys, band) => planAdvance({
    state: trusted({ keys }),
    observations: band === null ? {} : { [BUDGET_KEY]: band === "<70" ? "ok" : band },
    nowMs: START,
    ownerDate: "2026-10-08",
    budgetPages: true,
  });
  const opened = plan(initial(), ">=95");
  assert.equal(opened.keys[BUDGET_KEY].status, "open");
  const worse = plan(opened.keys, "exhausted");
  assert.deepEqual(worse.reservation.items.map((item) => item.kind), ["worsening"]);
  const held = plan(worse.keys, null);
  assert.equal(held.keys[BUDGET_KEY].status, "open");
  assert.equal(held.reservation, null);
  const first = plan(held.keys, "<70");
  assert.equal(first.keys[BUDGET_KEY].status, "open");
  const second = plan(first.keys, "<70");
  assert.deepEqual(second.reservation.items.map((item) => item.kind), ["recovery"]);
});

test("switching budget pages off keeps an open key, and switching back on does not announce it again", () => {
  const plan = (keys, budgetPages, band) => planAdvance({
    state: trusted({ keys }),
    observations: band ? { [BUDGET_KEY]: band } : {},
    nowMs: START,
    ownerDate: "2026-10-08",
    budgetPages,
  });
  const opened = plan(initial(), true, ">=95");
  assert.deepEqual(opened.reservation.items.map((item) => item.kind), ["new_open"]);
  const off = plan(opened.keys, false, ">=95");
  assert.deepEqual(off.keys[BUDGET_KEY], opened.keys[BUDGET_KEY]);
  assert.equal(off.reservation, null);
  const on = plan(off.keys, true, ">=95");
  assert.deepEqual(on.keys[BUDGET_KEY].openedAt, opened.keys[BUDGET_KEY].openedAt);
  assert.equal(on.reservation, null);
});

test("a held budget key survives past the limit; only new windows are left out", () => {
  const held = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`P-B#p${i}_day`, initialKeyState()]));
  const planned = planAdvance({
    state: trusted({ keys: { ...initial(), ...held } }),
    observations: { "P-B#aaa_day": ">=95" },
    nowMs: START,
    ownerDate: "2026-10-08",
    budgetPages: true,
  });
  assert.equal(Object.keys(planned.keys).filter((key) => key.startsWith("P-B#")).length, 64);
  assert.equal(Object.hasOwn(planned.keys, "P-B#aaa_day"), false);
});

test("a reservation for a budget key the body does not hold is refused, not a crash", async () => {
  const fake = fakeFetch(liveRoutes({
    "/api/internal/ops-snapshot": [200, budgetSnapshot(">=95")],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
  }));
  await run(fake, { env: { ...ENV, OPS_OBSERVER_S3_BUDGET_PAGES: "true" } });
  const body = fake.calls.find((call) => call.path.endsWith("/advance")).body;
  delete body.keys[BUDGET_KEY];
  const parsed = parseAdvanceRequest(JSON.stringify(body), START);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "reservation_invalid");
});

test("a stalled read is retried once on a new attempt; writes and answers are not", async () => {
  // A failed state read followed by a good one finishes the run.
  let stateCalls = 0;
  const flaky = fakeFetch(liveRoutes({
    "/api/internal/ops-observer/state": () => {
      stateCalls += 1;
      if (stateCalls === 1) throw new Error("stalled");
      return [200, trusted()];
    },
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
  }));
  const slept = [];
  const ok = await run(flaky, { sleep: async (ms) => slept.push(ms) });
  assert.deepEqual([ok.exitCode, ok.outcome], [0, "advanced"]);
  assert.equal(stateCalls, 2);
  assert.equal(slept.length, 1);
  assert.equal(JSON.parse(ok.lines[0]).readRetries, 1);

  // Two failures end the run the old way, and say it was the connection.
  const dead = fakeFetch(liveRoutes({ "/api/internal/ops-observer/state": new Error("stalled") }));
  const stopped = await run(dead);
  assert.deepEqual([stopped.exitCode, stopped.outcome], [1, "untrusted"]);
  assert.equal(JSON.parse(stopped.lines[0]).httpStatus, null);
  assert.equal(dead.paths().filter((path) => path.endsWith("/state")).length, 2);

  // An answer is an answer: a 503 is not retried, and its status is logged.
  const refused = fakeFetch(liveRoutes({ "/api/internal/ops-observer/state": [503] }));
  const answered = await run(refused);
  assert.equal(refused.paths().filter((path) => path.endsWith("/state")).length, 1);
  assert.equal(JSON.parse(answered.lines[0]).httpStatus, 503);

  // Advance is a write: a failed connection is an unknown outcome, never retried.
  const lost = fakeFetch(liveRoutes({ "/api/internal/ops-observer/state": [200, trusted()], "/api/internal/ops-observer/advance": new Error("reset") }));
  const unknown = await run(lost);
  assert.deepEqual([unknown.exitCode, unknown.outcome], [1, "advance_refused"]);
  assert.equal(lost.paths().filter((path) => path.endsWith("/advance")).length, 1);
});

test("a failed heartbeat ping is retried once and a second failure still fails the run", async () => {
  let beats = 0;
  const once = fakeFetch(liveRoutes({
    "/api/internal/ops-snapshot": [200, snapshot()],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "noop", heartbeatWithheld: false, generation: 4 }],
    [HEARTBEAT]: () => {
      beats += 1;
      if (beats === 1) throw new Error("stalled");
      return [200];
    },
  }));
  const ok = await run(once);
  assert.deepEqual([ok.exitCode, ok.outcome, beats], [0, "noop", 2]);

  const dead = fakeFetch(liveRoutes({
    "/api/internal/ops-snapshot": [200, snapshot()],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "noop", heartbeatWithheld: false, generation: 4 }],
    [HEARTBEAT]: [500],
  }));
  const failed = await run(dead);
  assert.deepEqual([failed.exitCode, failed.outcome], [1, "heartbeat_failed"]);
  assert.equal(JSON.parse(failed.lines[0]).httpStatus, 500);
});

test("a capped message past the day's budget is not reserved, and the keys still advance", () => {
  const prev = initial();
  prev[P3] = { status: "open", streak: 1, openedAt: START - 3_600_000, lastBand: "stuck", recoveredAt: null, newOpenOwnerDate: "2026-10-08" };
  const full = Array.from({ length: 6 }, () => ({ key: "P1a#database", kind: "reopen", capped: true }));
  const observations = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, "ok"]));
  const plan = planAdvance({ state: { keys: prev, budget: { reservedToday: full, channelCheckTaken: false } }, observations,
    nowMs: START, ownerDate: "2026-10-08" });
  assert.equal(plan.keys[P3].status, "closed");
  assert.deepEqual([plan.reservation, plan.deferred], [null, 1]);
  // With room in the day the same recovery is reserved.
  const room = planAdvance({ state: { keys: prev, budget: { reservedToday: [], channelCheckTaken: false } }, observations,
    nowMs: START, ownerDate: "2026-10-08" });
  assert.deepEqual(room.reservation.items.map((item) => item.kind), ["recovery"]);
});

test("a health failure makes every key unknown, so nothing opens", async () => {
  const fake = fakeFetch({
    "/api/health": new Error("connect ECONNREFUSED"),
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": (body) => {
      assert.deepEqual(body.keys, initial());
      return [200, { result: "noop", sendPermitted: false, heartbeatWithheld: false, generation: 4 }];
    },
    [HEARTBEAT]: [200],
  });
  const result = await run(fake);
  assert.equal(result.exitCode, 0);
  assert.ok(!fake.paths().includes("/api/internal/ops-snapshot"));
});

test("a withheld heartbeat is withheld, a refused advance beats nothing, and a late run asks nothing", async () => {
  const withheld = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot()],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: false, deliveryId: null, heartbeatWithheld: true, generation: 5 }],
  });
  assert.deepEqual(Object.values(await run(withheld)).slice(0, 2), [0, "heartbeat_withheld"]);
  assert.ok(withheld.paths().every((path) => path !== HEARTBEAT));

  const conflict = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot()],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "conflict", sendPermitted: false }],
  });
  const refused = await run(conflict);
  assert.deepEqual([refused.exitCode, refused.outcome, JSON.parse(refused.lines[0]).result], [1, "advance_refused", "conflict"]);

  // A clock past the deadline margin: no request is started at all after health.
  let tick = 0;
  const late = fakeFetch({ "/api/health": [503] });
  const result = await run(late, { now: () => (tick++ === 0 ? START : START + 176_000) });
  assert.deepEqual([result.exitCode, result.outcome], [1, "late"]);
  assert.deepEqual(late.paths(), []);
});

test("the run's log line carries enums and counts, never the secret or a URL", async () => {
  const fake = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot({ reconciliationStuck: true })],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }],
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
    [HEARTBEAT]: [500],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [1, "heartbeat_failed"]);
  const text = result.lines.join("\n");
  for (const leaked of [SECRET, APP, HEARTBEAT, "hc.example", DELIVERY, GENESIS]) assert.ok(!text.includes(leaked), leaked);
});

test("what the run sends is what the routes' own parsers accept", async () => {

  const { parseOpsObserverRequest } = await import("../scripts/ops-observer/request-schema-core.mjs");
  const fake = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot({ reconciliationStuck: true })],
    "/api/internal/ops-observer/state": [200, trusted()],
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }],
    "/api/internal/ops-observer/confirm": [200, { result: "shadowed" }],
    [HEARTBEAT]: [200],
  });
  await run(fake);
  const at = START + 1_000;
  const [, , state, advance, confirm] = fake.calls;
  assert.equal(parseOpsObserverRequest("state", JSON.stringify(state.body), at).ok, true);
  const parsed = parseAdvanceRequest(JSON.stringify(advance.body), at);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.reservation.items[0].kind, "new_open");
  assert.equal(parseOpsObserverRequest("confirm", JSON.stringify(confirm.body), at).ok, true);
});

test("every message of one incident names how it began: a worsening or recovery after a reopen is a reopen", async () => {
  const { incidentOrigin } = await import("../scripts/ops-observer/advance-request-core.mjs");
  const ownerDate = "2026-10-08";
  const observations = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, "unknown"]));
  const budget = { reservedToday: [], channelCheckTaken: false };
  const reservedKinds = (prev, observation) =>
    planAdvance({ state: { keys: { ...initial(), [P3]: prev }, budget }, observations: { ...observations, [P3]: observation },
      nowMs: START, ownerDate }).reservation?.items.map((item) => [item.kind, item.origin]);

  // Reopened two hours after a recovery: the opening, a worsening and the recovery are all "reopen".
  const reopenedAt = START - 3_600_000;
  const reopened = { status: "open", streak: 0, openedAt: reopenedAt, lastBand: "delayed", recoveredAt: reopenedAt - 7_200_000,
    newOpenOwnerDate: "2026-10-07" };
  assert.equal(incidentOrigin(reopened), "reopen");
  assert.deepEqual(reservedKinds(reopened, "stuck"), [["worsening", "reopen"]]);
  assert.deepEqual(reservedKinds({ ...reopened, streak: 1 }, "ok"), [["recovery", "reopen"]]);
  // Opened a day and more after its last recovery, or never recovered: "new" throughout.
  const fresh = { ...reopened, recoveredAt: reopenedAt - 25 * 3_600_000 };
  assert.equal(incidentOrigin(fresh), "new");
  assert.deepEqual(reservedKinds(fresh, "stuck"), [["worsening", "new"]]);
  assert.deepEqual(reservedKinds({ ...fresh, recoveredAt: null, streak: 1 }, "ok"), [["recovery", "new"]]);
});

test("an unusable permitted answer, a 409 and an unlisted string are logged as closed enums", async () => {
  const base = {
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot({ reconciliationStuck: true })],
    "/api/internal/ops-observer/state": [200, trusted()],
  };
  // A permitted reservation whose id the link cannot carry: no crash, no confirm, no heartbeat.
  const bad = fakeFetch({ ...base,
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: "NOT-A-UUID", heartbeatWithheld: false, generation: 5 }] });
  const unusable = await run(bad);
  assert.deepEqual([unusable.exitCode, unusable.outcome], [1, "delivery_unusable"]);
  assert.equal(bad.paths().at(-1), "/api/internal/ops-observer/advance");

  // A 409 on the state and on the confirm is the deadline.
  const lateState = fakeFetch({ ...base, "/api/internal/ops-observer/state": [409, { error: "late" }] });
  assert.equal((await run(lateState)).outcome, "late");
  const lateConfirm = fakeFetch({ ...base,
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }],
    "/api/internal/ops-observer/confirm": [409, { error: "late" }] });
  assert.equal((await run(lateConfirm)).outcome, "late");

  // Strings from the app reach the log only as known enums.
  const odd = fakeFetch({ ...base,
    "/api/internal/ops-observer/state": [200, { trust: "rm -rf <script>" }],
  });
  const oddRun = await run(odd);
  assert.equal(JSON.parse(oddRun.lines[0]).reason, "state_unavailable");
  const oddAdvance = fakeFetch({ ...base, "/api/internal/ops-observer/advance": [200, { result: "<injected>" }] });
  assert.equal(JSON.parse((await run(oddAdvance)).lines[0]).result, "unknown");
  const oddConfirm = fakeFetch({ ...base,
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }],
    "/api/internal/ops-observer/confirm": [200, { result: "<injected>" }] });
  const confirmRun = await run(oddConfirm);
  assert.deepEqual([confirmRun.outcome, JSON.parse(confirmRun.lines[0]).result], ["confirm_refused", "unknown"]);
});
