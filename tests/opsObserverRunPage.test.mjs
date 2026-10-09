// One page-service run, driven through every branch with an injected fetch
// (docs/policy/sre-ops.md §1 item 1, §3 rules 1, 3, 7 and 9, §5, decision
// T-1): the owner date is Brisbane's, an untrusted state sends nothing and
// beats nothing, the reservation is exactly what the budget admits, shadow
// confirms without a webhook, live stops before sending, a withheld heartbeat
// is withheld, and the log line carries no secret or URL.

import assert from "node:assert/strict";
import test from "node:test";

import { S2_PAGE_KEYS, initialKeyState } from "../scripts/ops-observer/classify-core.mjs";
import { OWNER_TIME_ZONE, ownerDateOf, planAdvance, runIdOf, runPage } from "../scripts/ops-observer/run-page-core.mjs";
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

const run = (fake, { now = () => START, log } = {}) => {
  const lines = [];
  return runPage({ env: ENV, fetchImpl: fake.fetchImpl, now, random: () => "abcdef0123456789abcdef", log: log ?? ((line) => lines.push(line)) })
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

test("a live chain stops before sending: no confirm, no heartbeat", async () => {
  const fake = fakeFetch({
    "/api/health": [200, {}],
    "/api/internal/ops-snapshot": [200, snapshot({ reconciliationStuck: true })],
    "/api/internal/ops-observer/state": [200, trusted({ mode: "live" })],
    "/api/internal/ops-observer/advance": [200, { result: "advanced", sendPermitted: true, deliveryId: DELIVERY, heartbeatWithheld: false, generation: 5 }],
  });
  const result = await run(fake);
  assert.deepEqual([result.exitCode, result.outcome], [1, "live_send_not_built"]);
  assert.equal(fake.paths().at(-1), "/api/internal/ops-observer/advance");
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
  const { parseAdvanceRequest } = await import("../scripts/ops-observer/advance-request-core.mjs");
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
