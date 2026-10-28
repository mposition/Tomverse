import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { handleSupportTriageHeartbeat, handleSupportTriageRetention } from "@/lib/supportTriageRoutes";

// The support-triage retention and heartbeat routes (docs/policy/support-triage.md §3, §5, §7).
//
// What needs a database: the retention route runs a real retention run and
// the heartbeat reads the run rows it leaves.

const RETENTION = "r".repeat(40);
const HEARTBEAT = "h".repeat(40);
const ENV = { SUPPORT_TRIAGE_RETENTION_SECRET: RETENTION, SUPPORT_TRIAGE_HEARTBEAT_SECRET: HEARTBEAT };

const post = (path: string, secret: string | null) =>
  new Request(`https://example.invalid/api/internal/support-triage/${path}`, {
    method: "POST",
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ ignored: true, deadlineAt: "2000-01-01T00:00:00.000Z" }),
  });

const clearRuns = async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_route_slow_delete" ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_route_slow_delete()`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_delete"`);
  }
  // This suite only reads SupportTriageRun. Cascading a global audit truncate
  // would cross into unrelated append-only AMUX history tables.
};

beforeEach(clearRuns);

after(async () => {
  await clearRuns();
  await prisma.$disconnect();
});

const COUNT_KEYS = ["batchesCompleted", "blocked", "deleted", "oldestOverdueAgeSeconds", "outcome", "overdueRemaining", "result"];

test("retention refuses a missing, wrong or other route's secret and starts no run", async () => {
  for (const secret of [null, "x".repeat(40), HEARTBEAT]) {
    const response = await handleSupportTriageRetention(post("retention", secret), { env: ENV });
    assert.deepEqual(response, { status: 401, body: { result: "unauthorized" } }, String(secret));
  }
  // A configured secret shorter than 32 characters closes the route.
  const short = "s".repeat(31);
  const response = await handleSupportTriageRetention(post("retention", short), {
    env: { SUPPORT_TRIAGE_RETENTION_SECRET: short },
  });
  assert.equal(response.status, 401);
  assert.equal(await prisma.supportTriageRun.count(), 0);
});

test("retention runs whatever the triage flag says and answers counts only", async () => {
  const response = await handleSupportTriageRetention(post("retention", RETENTION), {
    env: { ...ENV, SUPPORT_TRIAGE_ENABLED: "false" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), COUNT_KEYS);
  assert.equal(response.body.result, "ok");
  assert.equal(response.body.outcome, "success");
  const runs = await prisma.supportTriageRun.findMany({ select: { id: true, kind: true } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, "retention");
  // No run id or any other identifier leaves the route.
  assert.ok(!JSON.stringify(response.body).includes(runs[0].id));
});

test("retention answers non-2xx when a run makes no progress while rows are overdue", async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_insert"`);
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SupportTriageRun" ("id", "kind", "outcome", "createdAt", "deadlineAt", "finishedAt")
      SELECT 'stuck', 'worker', 'success', t.b, t.b, t.b
        FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '31 days' AS b) t`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_insert"`);
  }
  await prisma.$executeRawUnsafe(`CREATE FUNCTION test_route_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD."id" = 'stuck' THEN PERFORM pg_sleep(1); END IF; RETURN OLD; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_route_slow_delete" BEFORE DELETE ON "SupportTriageRun"
    FOR EACH ROW EXECUTE FUNCTION test_route_slow_delete()`);
  const response = await handleSupportTriageRetention(post("retention", RETENTION), { env: ENV });
  assert.equal(response.status, 503);
  assert.equal(response.body.result, "SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING");
  assert.equal(response.body.batchesCompleted, 0);
  assert.equal(response.body.overdueRemaining, 1);
  assert.deepEqual(Object.keys(response.body).sort(), COUNT_KEYS);
});

test("the heartbeat refuses the retention secret: the triage services never hold its secret", async () => {
  for (const secret of [null, RETENTION]) {
    const response = await handleSupportTriageHeartbeat(post("heartbeat", secret), { env: ENV });
    assert.deepEqual(response, { status: 401, body: { result: "unauthorized" } });
  }
});

test("the heartbeat is stale until a retention run succeeds, and then judges the worker only while enabled", async () => {
  const beat = (env: Record<string, string>) => handleSupportTriageHeartbeat(post("heartbeat", HEARTBEAT), { env });
  assert.deepEqual(await beat(ENV), { status: 200, body: { stale: true } });
  assert.equal((await handleSupportTriageRetention(post("retention", RETENTION), { env: ENV })).status, 200);
  assert.deepEqual(await beat(ENV), { status: 200, body: { stale: false } });
  // Enabled with no successful worker run: fail-closed.
  assert.deepEqual(await beat({ ...ENV, SUPPORT_TRIAGE_ENABLED: "true" }), { status: 200, body: { stale: true } });
});
