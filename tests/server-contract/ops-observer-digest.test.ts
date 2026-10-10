// The sre-ops digest route and intake (docs/policy/sre-ops.md §1 item 3,
// §3 rules 4, 7 and 8, §6): the digest service only, naming a closed owner
// date; the chain trusted for that date; the payload built by the app from its
// own reads (the date's reservations, the non-page readiness checks, the
// mode); the shared transaction armed with digest_submit and ended with this
// agent's run guard row; a late run 409; the answer only after the deadline
// check.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const PAGE = "p".repeat(40);
const DIGEST = "d".repeat(40);
const DAY = "2026-10-05"; // closed for any test clock after 2026-10-05T14:06:30Z
const ITEM = "33333333-3333-4333-8333-333333333333";
const reserved = [{ key: "P3#credit_reservation_reconciliation", kind: "new_open", capped: false }];
// The date's messages as the store reads them: each with its mode and status.
const dateItems = [{ ...reserved[0], mode: "shadow", status: "reserved" }];

class TestLateError extends Error {}

const world = {
  state: null as unknown,
  stateArgs: [] as unknown[],
  checks: null as unknown,
  record: null as unknown,
  submissions: [] as { idempotencyKey: string; payload: unknown }[],
  txCalls: [] as string[],
  armed: [] as unknown[],
  asserted: 0,
  commitError: null as unknown,
  prismaTimeouts: [] as number[],
  wrapped: [] as unknown[],
  assertThrows: false,
  kept: null as string | null,
  dateItems: dateItems as unknown,
  dateArgs: [] as unknown[],
};
let POST: (request: Request) => Promise<Response>;

before(async () => {
  mock.module(mod("lib/opsObserverStore.ts"), {
    namedExports: {
      readOpsObserverState: async (...args: unknown[]) => {
        world.stateArgs = args;
        return world.state;
      },
      readOpsObserverDateItems: async (ownerDate: string, deadline: Date) => {
        world.dateArgs = [ownerDate, deadline instanceof Date ? deadline.toISOString() : null];
        return world.dateItems;
      },
    },
  });
  mock.module(mod("lib/readinessChecks.ts"), {
    namedExports: { computeReadinessChecks: async () => ({ checks: world.checks, ready: true }) },
  });
  mock.module(mod("lib/opsObserverTransaction.ts"), {
    namedExports: {
      OpsObserverLateError: TestLateError,
      isBudgetInsufficient: () => false,
      // The kept-item read runs in the bounded wrapper, under the run's deadline.
      withOpsObserverTransaction: async (kind: string, deadline: Date, fn: (tx: unknown) => Promise<unknown>) => {
        world.wrapped.push([kind, deadline instanceof Date ? deadline.toISOString() : null]);
        const result = await fn({ $queryRaw: async () => (world.kept ? [{ id: world.kept }] : []) });
        return { result, armed: {} };
      },
      armOpsObserverTransaction: async (_tx: unknown, kind: string, deadline: Date) => {
        world.armed.push([kind, deadline instanceof Date ? deadline.toISOString() : null]);
        world.txCalls.push("arm");
        return {};
      },
      assertNotLate: async () => {
        world.asserted += 1;
        if (world.assertThrows) throw new TestLateError("late");
      },
    },
  });
  mock.module(mod("lib/agentDigestStore.ts"), {
    namedExports: {
      recordAgentDigestItem: async (
        submission: { idempotencyKey: string; payload: unknown },
        _db: unknown,
        admit: ((tx: unknown) => Promise<string | null>) | undefined,
        confirm: (tx: unknown) => Promise<string | null>,
        limits: { arm: (tx: unknown) => Promise<void>; prismaTimeoutMs: number },
      ) => {
        world.submissions.push(submission);
        world.prismaTimeouts.push(limits.prismaTimeoutMs);
        const tx = {
          $executeRaw: async (strings: TemplateStringsArray) => {
            world.txCalls.push(strings.join("?").includes('"OpsObserverRunGuard"') ? "run_guard" : "other");
            return 1;
          },
        };
        // The caller's arming is the transaction's first statement.
        await limits.arm(tx);
        assert.equal(admit, undefined);
        world.txCalls.push("insert_and_audit");
        assert.equal(await confirm(tx), null);
        // A deferred trigger refusing the COMMIT surfaces from the store.
        if (world.commitError) throw world.commitError;
        return world.record;
      },
    },
  });
  ({ POST } = await import(mod("app/api/internal/ops-observer/digest/route.ts")));
});

const trusted = () => ({ trust: "trusted", genesisId: "g", mode: "shadow", generation: 3, keys: {}, reservedOpen: false,
  budget: { ownerDate: DAY, reservedToday: reserved, channelCheckTaken: true } });

beforeEach(() => {
  process.env.OPS_OBSERVER_SECRET = PAGE;
  process.env.OPS_OBSERVER_DIGEST_SECRET = DIGEST;
  world.state = trusted();
  world.checks = { database: true, securityEnvironment: true, providerBudgets: true, emailSnapshotKeyring: true,
    emailSendingIdentity: true, imageProviderBudget: false, emailUnsubscribeKeyring: true };
  world.record = { status: "created", id: ITEM, auditLogId: "a", sizeBytes: 10, payloadSha256: "f".repeat(64) };
  world.submissions = [];
  world.txCalls = [];
  world.armed = [];
  world.asserted = 0;
  world.commitError = null;
  world.assertThrows = false;
  world.kept = null;
  world.prismaTimeouts = [];
  world.wrapped = [];
  world.dateItems = dateItems;
  world.dateArgs = [];
});

const body = (overrides: Record<string, unknown> = {}) => ({
  runDeadline: new Date(Date.now() + 120_000).toISOString(),
  ownerDate: DAY,
  ...overrides,
});
const call = (bearer: string, payload: unknown = body()) =>
  POST(new Request("https://tomverse.app/api/internal/ops-observer/digest", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));

test("only the digest service may submit", async () => {
  assert.equal((await call(PAGE)).status, 403);
  assert.equal((await call("x".repeat(40))).status, 401);
  assert.deepEqual(world.submissions, []);
});

test("the app builds the digest from its own reads and keeps it under the date's key", async () => {
  const runDeadline = new Date(Date.now() + 120_000).toISOString();
  const response = await call(DIGEST, body({ runDeadline }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "created", itemId: ITEM });
  assert.equal(world.stateArgs[2], DAY);
  assert.deepEqual(world.submissions.map((s) => s.idempotencyKey), [`sre-ops:daily:${DAY}`]);
  assert.deepEqual(world.submissions[0].payload, {
    ownerDate: DAY,
    mode: "shadow",
    // Only the checks that are not page keys, from the app's own readiness.
    readiness: { emailUnsubscribeKeyring: true, imageProviderBudget: false },
    items: dateItems,
    counts: [{ mode: "shadow", status: "reserved", kind: "new_open", count: 1 }],
    channelCheckTaken: true,
  });
  // Armed first, the shared writes, then this agent's guard row last.
  // Armed with the request's own deadline, not any other.
  assert.deepEqual(world.armed, [["digest_submit", runDeadline]]);
  assert.deepEqual(world.wrapped, [["state_read", runDeadline]]);
  assert.deepEqual(world.txCalls, ["arm", "insert_and_audit", "run_guard"]);
  // digest_submit's Prisma timeout, not the shared default.
  assert.deepEqual(world.prismaTimeouts, [55_000]);
  assert.equal(world.asserted, 1);
});

test("the digest lists every message of the date, not only the head genesis's run budget", async () => {
  // The head is live by now; the date held shadow reservations and a message
  // the cap deferred. The head's own budget holds none of them.
  const shadowItems = [
    { key: "P3#credit_reservation_reconciliation", kind: "new_open", capped: false, mode: "shadow", status: "reserved" },
    { key: "P3#credit_reservation_reconciliation", kind: "recovery", capped: true, mode: "shadow", status: "deferred" },
  ];
  world.state = { ...trusted(), mode: "live", budget: { ownerDate: DAY, reservedToday: [], channelCheckTaken: false } };
  world.dateItems = shadowItems;
  const runDeadline = new Date(Date.now() + 120_000).toISOString();
  await call(DIGEST, body({ runDeadline }));
  assert.deepEqual(world.dateArgs, [DAY, runDeadline]);
  const payload = world.submissions[0].payload as { mode: string; items: unknown; counts: unknown; channelCheckTaken: unknown };
  assert.equal(payload.mode, "live");
  assert.deepEqual(payload.items, shadowItems);
  assert.deepEqual(payload.counts, [
    { mode: "shadow", status: "reserved", kind: "new_open", count: 1 },
    { mode: "shadow", status: "deferred", kind: "recovery", count: 1 },
  ]);
  assert.equal(payload.channelCheckTaken, false);
});

test("a readiness read that fails is reported unknown, not as all clear", async () => {
  world.checks = null;
  await call(DIGEST);
  assert.equal((world.submissions[0].payload as { readiness: unknown }).readiness, "unknown");
});

test("an untrusted chain stores nothing and answers its reason", async () => {
  world.state = { trust: "audit_unverified" };
  assert.deepEqual(await (await call(DIGEST)).json(), { result: "untrusted", trust: "audit_unverified" });
  assert.deepEqual(world.submissions, []);
});

test("a date that is not closed, or a body with a payload, is 400 before anything is read", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(new Date());
  for (const bad of [body({ ownerDate: today }), body({ payload: {} }), body({ ownerDate: "2026-02-30" })]) {
    assert.equal((await call(DIGEST, bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(world.submissions, []);
});

test("a commit the deferred check refuses, a start budget refusal and a late answer are all 409", async () => {
  for (const code of ["OB012", "OB001"]) {
    world.commitError = Object.assign(new Error("refused"), { code });
    assert.equal((await call(DIGEST)).status, 409, code);
  }
  world.commitError = null;
  world.assertThrows = true;
  assert.equal((await call(DIGEST)).status, 409);
});

test("a date already kept is answered with its item, never rebuilt or a conflict", async () => {
  world.kept = ITEM;
  const runDeadline = new Date(Date.now() + 90_000).toISOString();
  assert.deepEqual(await (await call(DIGEST, body({ runDeadline }))).json(), { result: "replayed", itemId: ITEM });
  assert.deepEqual(world.wrapped, [["state_read", runDeadline]]);
  assert.deepEqual(world.submissions, []);
  assert.equal(world.asserted, 1);
  // A concurrent run that kept it first between the read and the write.
  world.kept = null;
  world.record = { status: "conflict", id: ITEM };
  assert.deepEqual(await (await call(DIGEST)).json(), { result: "replayed", itemId: ITEM });
});

test("only this agent's deadline codes are late; a Prisma code is a plain failure", async () => {
  world.commitError = Object.assign(new Error("raw query failed"), { code: "P2010" });
  assert.equal((await call(DIGEST)).status, 500);
});
