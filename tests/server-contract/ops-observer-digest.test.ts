// The sre-ops digest route and intake (docs/policy/sre-ops.md §1 item 3,
// §3 rules 4 and 7, §6 item 5): the digest service only; a closed body; the
// chain trusted for that owner date; the payload's mode and reservations
// exactly what the app reads; the shared store's last statement refuses a
// late commit; and the answer only after the separate deadline check.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const PAGE = "p".repeat(40);
const DIGEST = "d".repeat(40);
const DAY = "2026-10-07";
const ITEM = "33333333-3333-4333-8333-333333333333";
const reserved = [{ key: "P3#credit_reservation_reconciliation", kind: "new_open", capped: false }];

class TestLateError extends Error {}

const world = {
  state: null as unknown,
  stateArgs: [] as unknown[],
  record: null as unknown,
  late: false,
  submissions: [] as unknown[],
  asserted: 0,
  assertThrows: false,
};
let POST: (request: Request) => Promise<Response>;

before(async () => {
  mock.module(mod("lib/opsObserverStore.ts"), {
    namedExports: {
      readOpsObserverState: async (...args: unknown[]) => {
        world.stateArgs = args;
        return world.state;
      },
    },
  });
  mock.module(mod("lib/opsObserverTransaction.ts"), {
    namedExports: {
      OpsObserverLateError: TestLateError,
      isBudgetInsufficient: () => false,
      assertNotLate: async () => {
        world.asserted += 1;
        if (world.assertThrows) throw new TestLateError("late");
      },
    },
  });
  mock.module(mod("lib/agentDigestStore.ts"), {
    namedExports: {
      recordAgentDigestItem: async (submission: unknown, _db: unknown, _admit: unknown, confirm: (tx: unknown) => Promise<string | null>) => {
        world.submissions.push(submission);
        // Run the caller's last statement against a fake transaction.
        const refusal = await confirm({ $queryRaw: async () => [{ late: world.late }] });
        if (refusal !== null) return { status: "not_admitted", reason: refusal };
        return world.record;
      },
    },
  });
  ({ POST } = await import(mod("app/api/internal/ops-observer/digest/route.ts")));
});

beforeEach(() => {
  process.env.OPS_OBSERVER_SECRET = PAGE;
  process.env.OPS_OBSERVER_DIGEST_SECRET = DIGEST;
  world.state = { trust: "trusted", genesisId: "g", mode: "shadow", generation: 3, keys: {}, reservedOpen: false,
    budget: { ownerDate: DAY, reservedToday: reserved, channelCheckTaken: false } };
  world.record = { status: "created", id: ITEM, auditLogId: "a", sizeBytes: 10, payloadSha256: "f".repeat(64) };
  world.late = false;
  world.submissions = [];
  world.asserted = 0;
  world.assertThrows = false;
});

const body = (overrides: Record<string, unknown> = {}) => ({
  runDeadline: new Date(Date.now() + 120_000).toISOString(),
  ownerDate: DAY,
  payload: { ownerDate: DAY, mode: "shadow", readiness: { imageProviderBudget: true }, reserved, channelCheckTaken: false },
  ...overrides,
});
const call = (bearer: string, payload: unknown = body()) =>
  POST(new Request("https://tomverse.app/api/internal/ops-observer/digest", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));

test("only the digest service may submit, and nothing is read for anyone else", async () => {
  const page = await call(PAGE);
  assert.equal(page.status, 403);
  assert.equal((await call("x".repeat(40))).status, 401);
  assert.deepEqual(world.submissions, []);
});

test("an agreeing payload on a trusted chain is kept under its date's key, and answered after the deadline check", async () => {
  const response = await call(DIGEST);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "created", itemId: ITEM });
  assert.equal(world.stateArgs[2], DAY);
  assert.deepEqual(world.submissions, [{
    agentKey: "sre-ops", kind: "daily_digest", schemaVersion: 1, idempotencyKey: `sre-ops:daily:${DAY}`,
    payload: body().payload,
  }]);
  assert.equal(world.asserted, 1);
  world.record = { status: "replayed", id: ITEM, payloadSha256: "f".repeat(64) };
  assert.deepEqual(await (await call(DIGEST)).json(), { result: "replayed", itemId: ITEM });
});

test("an untrusted chain, another mode or other reservations store nothing", async () => {
  world.state = { trust: "audit_unverified" };
  assert.deepEqual(await (await call(DIGEST)).json(), { result: "untrusted", trust: "audit_unverified" });
  beforeEachReset();
  assert.deepEqual(await (await call(DIGEST, body({ payload: { ...body().payload, mode: "live" } }))).json(), { result: "mode_mismatch" });
  assert.deepEqual(await (await call(DIGEST, body({ payload: { ...body().payload, reserved: [] } }))).json(), { result: "budget_mismatch" });
  assert.deepEqual(await (await call(DIGEST, body({ payload: { ...body().payload, channelCheckTaken: true } }))).json(), { result: "budget_mismatch" });
  assert.deepEqual(world.submissions, []);
});

function beforeEachReset() {
  world.state = { trust: "trusted", genesisId: "g", mode: "shadow", generation: 3, keys: {}, reservedOpen: false,
    budget: { ownerDate: DAY, reservedToday: reserved, channelCheckTaken: false } };
}

test("a late commit is refused by the transaction's last statement, and a late answer is 409", async () => {
  world.late = true;
  assert.deepEqual(await (await call(DIGEST)).json(), { result: "late" });
  assert.equal(world.asserted, 0);
  world.late = false;
  world.assertThrows = true;
  assert.equal((await call(DIGEST)).status, 409);
});

test("a body outside the closed shape is 400 before anything is read", async () => {
  for (const bad of [body({ extra: 1 }), body({ ownerDate: "2026-10-06" }), body({ payload: { ...body().payload, reserved: [{ key: "x", kind: "y", capped: 1 }] } })]) {
    assert.equal((await call(DIGEST, bad)).status, 400);
  }
  assert.deepEqual(world.submissions, []);
});
