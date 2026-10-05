// The ops-snapshot route (docs/policy/sre-ops.md §1, §3 rule 7, §7, §8): 404
// with no usable secret and no source called; both services may read; a
// failing source makes only its section unknown; the answer is the closed
// snapshot, no-store; and each read is logged without a body.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const PAGE = "p".repeat(40);
const DIGEST = "d".repeat(40);

const world = { calls: [] as string[], failJobs: false, hangBudgets: false };
let POST: (request: Request) => Promise<Response>;

before(async () => {
  mock.module(mod("lib/readinessChecks.ts"), {
    namedExports: {
      computeReadinessChecks: async () => {
        world.calls.push("readiness");
        return { checks: { database: true, securityEnvironment: true, providerBudgets: true }, ready: true };
      },
    },
  });
  mock.module(mod("lib/scheduledJobs.ts"), {
    namedExports: {
      getScheduledJobsDashboard: async () => {
        world.calls.push("jobs");
        if (world.failJobs) throw new Error("db down: password=hunter2");
        return [{ key: "standard_email_drain", status: "failure", delayed: false, lastRunAt: "2026-10-05T01:20:10.000Z",
          lastSuccessAt: null, consecutiveFailures: 4, lastError: "smtp said no to bob@example.com" }];
      },
    },
  });
  mock.module(mod("lib/providerBudgetStatus.ts"), {
    namedExports: {
      getProviderBudgetStatuses: async () => {
        world.calls.push("budgets");
        if (world.hangBudgets) return new Promise(() => {});
        return { usageUnavailable: false, providers: [{ provider: "anthropic", periods: [
          { period: "day", usedMicroUsd: 10, limitMicroUsd: 1000, resetAt: "2026-10-06T00:00:00.000Z" },
        ] }] };
      },
    },
  });
  ({ POST } = await import(mod("app/api/internal/ops-snapshot/route.ts")));
});

beforeEach(() => {
  world.calls = [];
  world.failJobs = false;
  world.hangBudgets = false;
  process.env.OPS_OBSERVER_SECRET = PAGE;
  process.env.OPS_OBSERVER_DIGEST_SECRET = DIGEST;
});

const call = (bearer: string | null) =>
  POST(new Request("https://tomverse.app/api/internal/ops-snapshot", {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  }));

test("with no usable secret it is 404 and no source is read", async () => {
  delete process.env.OPS_OBSERVER_SECRET;
  delete process.env.OPS_OBSERVER_DIGEST_SECRET;
  const response = await call(PAGE);
  assert.deepEqual([response.status, await response.json()], [404, { error: "not_found" }]);
  assert.deepEqual(world.calls, []);
  assert.equal((await (async () => { process.env.OPS_OBSERVER_SECRET = PAGE; return call("x".repeat(40)); })()).status, 401);
  assert.deepEqual(world.calls, []);
});

test("both services read the closed snapshot, no-store, readiness first, and the read is logged without a body", async () => {
  const logged: string[] = [];
  const original = console.info;
  console.info = (line: string) => logged.push(line);
  try {
    for (const bearer of [PAGE, DIGEST]) {
      world.calls = [];
      const response = await call(bearer);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.deepEqual(body.scheduledJobs, [{ key: "standard_email_drain", delayed: false, stuck: false,
        lastRunAt: "2026-10-05T01:20:00.000Z", lastSuccessAt: null, consecutiveFailuresBand: "3+" }]);
      assert.deepEqual(body.providerBudgets, [{ provider: "anthropic", scope: "day", utilisationBand: "<70", resetAt: "2026-10-06T00:00:00.000Z" }]);
      assert.ok(!JSON.stringify(body).includes("bob@example.com"));
      assert.equal(world.calls[0], "readiness");
    }
  } finally {
    console.info = original;
  }
  const events = logged.map((line) => JSON.parse(line)).filter((e) => e.event === "ops_snapshot_read");
  assert.deepEqual(events.map((e) => [e.service, e.result]), [["page", "ok"], ["digest", "ok"]]);
});

test("a failing source makes only its section unknown, and its error never leaves", async () => {
  world.failJobs = true;
  const response = await call(PAGE);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scheduledJobs, "unknown");
  assert.notEqual(body.readiness, "unknown");
  assert.notEqual(body.providerBudgets, "unknown");
  assert.ok(!JSON.stringify(body).includes("hunter2"));
});

test("a source that never answers costs only its own section", async () => {
  world.hangBudgets = true;
  const started = Date.now();
  const response = await call(PAGE);
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providerBudgets, "unknown");
  assert.notEqual(body.readiness, "unknown");
  assert.notEqual(body.scheduledJobs, "unknown");
  assert.ok(elapsed < 8_000, String(elapsed));
});
