import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { enqueueNotificationDeliveryOnce } from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import { runQaReleaseMonitor } from "@/lib/qaReleaseMonitor";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";

// The Monitor's silence check (lib/qaReleaseMonitor.ts) against PostgreSQL:
// its own secret, the newest control revision, then the freshness verdict
// over the database clock.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const MONITOR = "m".repeat(40);
const env = { QA_RELEASE_DIGEST_SECRET: "d".repeat(40), QA_RELEASE_MONITOR_SECRET: MONITOR };
const session = { user: { id: "qa-monitor-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };

const control = (digestEnabled: boolean) => ({
  digestEnabled,
  mergeLaneEnabled: false,
  developLaneOn: false,
  iacCommit: null,
  digestSecretRotatedAt: null,
  monitorSecretRotatedAt: null,
  mergeLaneSecretRotatedAt: null,
  githubAppKeyRotatedAt: null,
  railwayTokenRotatedAt: null,
  githubReadTokenRotatedAt: null,
});

let revision = 0;

const call = (
  overrides: { env?: Record<string, string>; headers?: Record<string, string>; clock?: () => number } = {},
) =>
  runQaReleaseMonitor(
    new Request("https://staging.tomverse.app/api/internal/agents/qa-release/monitor", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MONITOR}`,
        "x-qa-release-control-revision": String(revision),
        ...overrides.headers,
      },
    }),
    overrides.env ?? env,
    overrides.clock,
  );

const cleanup = async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" DISABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "QaReleaseOperatorControl"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "agentKey" = 'qa-release'`);
    await prisma.notificationDelivery.deleteMany({ where: { kind: { in: ["qa_release_digest_stale", "qa_release_monitor_failed", "qa_release_attention", "qa_release_digest_recorded"] } } });
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" ENABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
  }
};

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("an outsider is unauthorized; with no revision recorded the check is unavailable", async () => {
  assert.deepEqual(await call({ headers: { authorization: `Bearer ${"d".repeat(40)}` } }), {
    status: 401,
    body: { error: "unauthorized" },
  });
  assert.deepEqual(await call(), { status: 503, body: { error: "control_revision_unavailable" } });
});

test("recorded off is quiet; recorded on with no digest is stale; a stale revision is a mismatch", async () => {
  revision = (await recordQaReleaseOperatorControl({ session: session as never, control: control(false) })).revision;
  assert.deepEqual(await call(), { status: 200, body: { verdict: "operator_disabled" } });
  revision = (await recordQaReleaseOperatorControl({ session: session as never, control: control(true) })).revision;
  assert.deepEqual(await call(), { status: 200, body: { verdict: "stale", alerted: true } });
  assert.deepEqual(await call({ headers: { "x-qa-release-control-revision": String(revision - 1) } }), {
    status: 409,
    body: { error: "control_revision_mismatch", alerted: true },
  });
  // One needs-a-check alert a day, whichever mismatch found it first.
  assert.deepEqual(await call({ env: { QA_RELEASE_MONITOR_SECRET: MONITOR } }), {
    status: 200,
    body: { verdict: "control_mismatch", alerted: false },
  });
  assert.deepEqual(await call({ env: { QA_RELEASE_MONITOR_SECRET: MONITOR, QA_RELEASE_DIGEST_SECRET: "short" } }), {
    status: 200,
    body: { verdict: "control_mismatch", alerted: false },
  });
  const rows = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_attention" } });
  assert.equal(rows.length, 1);
  const [{ day }] = await prisma.$queryRaw<{ day: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`;
  assert.equal(rows[0].referenceId, `attention:${day}`);
  const audits = await prisma.adminAuditLog.findMany({
    where: { action: "qa_release.attention_alerted", targetId: rows[0].id },
    select: { metadata: true },
  });
  assert.equal(audits.length, 1);
  assert.equal((audits[0].metadata as Record<string, unknown>).reason, "control_revision_mismatch");

  // With no alert yet today, a control mismatch queues it under its own reason.
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_attention" } });
  assert.deepEqual(await call({ env: { QA_RELEASE_MONITOR_SECRET: MONITOR } }), {
    status: 200,
    body: { verdict: "control_mismatch", alerted: true },
  });
  const [again] = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_attention" } });
  const [audit] = await prisma.adminAuditLog.findMany({
    where: { action: "qa_release.attention_alerted", targetId: again.id },
    select: { metadata: true },
  });
  assert.equal((audit.metadata as Record<string, unknown>).reason, "control_mismatch");
});

test("a digest just stored is fresh, and the same digest 28 hours later is stale", async () => {
  const stored = await recordAgentDigestItem({
    agentKey: "qa-release",
    kind: "daily_digest",
    schemaVersion: 1,
    idempotencyKey: "qa-release:monitor-test:1",
    payload: { a: 1 },
  });
  assert.equal(stored.status, "created");
  // The first fresh round queues the digest's recorded notice, keyed by the
  // digest's own UTC day; every later fresh round finds it and writes nothing.
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: "qa_release.digest_recorded_alerted" } });
  assert.deepEqual(await call(), { status: 200, body: { verdict: "fresh", alerted: true } });
  assert.deepEqual(await call(), { status: 200, body: { verdict: "fresh" } });
  const recorded = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_digest_recorded" } });
  assert.equal(recorded.length, 1);
  const [{ digestDay }] = await prisma.$queryRaw<{ digestDay: string }[]>`
    SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "digestDay"
      FROM "AgentDigestItem" WHERE "idempotencyKey" = 'qa-release:monitor-test:1'`;
  assert.equal(recorded[0].referenceId, `recorded:${digestDay}`);
  assert.equal(
    await prisma.adminAuditLog.count({ where: { action: "qa_release.digest_recorded_alerted" } }),
    auditsBefore + 1,
  );

  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_update"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentDigestItem" SET "createdAt" = clock_timestamp() - INTERVAL '28 hours',
         "retentionUntil" = clock_timestamp() + INTERVAL '60 days' WHERE "idempotencyKey" = 'qa-release:monitor-test:1'`,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_update"`);
  }
  // Whether today's alert already exists is the next test's subject.
  const stale = await call();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.verdict, "stale");
});

test("a fresh digest of an earlier UTC day gets no recorded notice", async () => {
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_digest_recorded" } });
  const stored = await recordAgentDigestItem({
    agentKey: "qa-release",
    kind: "daily_digest",
    schemaVersion: 1,
    idempotencyKey: "qa-release:monitor-test:yesterday",
    payload: { a: 2 },
  });
  assert.equal(stored.status, "created");
  // Moved to one second before the current UTC day began: under 28 hours old,
  // so fresh, but of the previous day, so never announced.
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_update"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentDigestItem"
          SET "createdAt" = date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - INTERVAL '1 second'
        WHERE "idempotencyKey" = 'qa-release:monitor-test:yesterday'`,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_update"`);
  }
  const answered = await call();
  assert.deepEqual(answered, { status: 200, body: { verdict: "fresh" } });
  assert.equal(await prisma.notificationDelivery.count({ where: { kind: "qa_release_digest_recorded" } }), 0);
  // Remove it so the newest digest is the earlier test's again.
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "idempotencyKey" = 'qa-release:monitor-test:yesterday'`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
  }
});

test("a stale verdict queues one silence alert per UTC date, however often the Monitor runs", async () => {
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_digest_stale" } });
  assert.deepEqual(await call(), { status: 200, body: { verdict: "stale", alerted: true } });
  assert.deepEqual(await call(), { status: 200, body: { verdict: "stale", alerted: false } });
  const rows = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_digest_stale" } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].referenceId, /^stale:\d{4}-\d{2}-\d{2}$/);
  // The key is the database clock's UTC date, not this process's.
  const [{ day }] = await prisma.$queryRaw<{ day: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`;
  assert.equal(rows[0].referenceId, `stale:${day}`);
  const audits = await prisma.adminAuditLog.count({ where: { action: "qa_release.digest_stale_alerted", targetId: rows[0].id } });
  assert.equal(audits, 1);
});

test("the round deadline follows the database clock, so app clock skew neither drops nor admits an alert", async () => {
  // The application clock ten minutes behind, then ten minutes ahead, of the
  // database: either way the round is fresh by the database's own clock.
  for (const skewMs of [-600_000, 600_000]) {
    await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_digest_stale" } });
    const skewed = () => Date.now() + skewMs;
    assert.deepEqual(await call({ clock: skewed }), { status: 200, body: { verdict: "stale", alerted: true } }, String(skewMs));
    assert.deepEqual(await call({ clock: skewed }), { status: 200, body: { verdict: "stale", alerted: false } }, String(skewMs));
  }
});

test("a round that ran past its budget during the read is refused on both paths, and records nothing", async () => {
  // The clock reads 0 until the read has returned, then 200 s: the remaining
  // budget is already negative, so the deadline lies in the database's past.
  const jumpAfterRead = () => {
    let calls = 0;
    return () => (++calls >= 4 ? 200_000 : 0);
  };
  await prisma.notificationDelivery.deleteMany({ where: { kind: "qa_release_digest_stale" } });
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: "qa_release.digest_stale_alerted" } });
  assert.deepEqual(await call({ clock: jumpAfterRead() }), {
    status: 503,
    body: { verdict: "stale", error: "monitor_deadline_passed", failureRecorded: false },
  });
  assert.equal(await prisma.notificationDelivery.count({ where: { kind: "qa_release_digest_stale" } }), 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.digest_stale_alerted" } }), auditsBefore);

  // With today's alert already queued, a late round is still not a success.
  assert.deepEqual(await call(), { status: 200, body: { verdict: "stale", alerted: true } });
  assert.deepEqual(await call({ clock: jumpAfterRead() }), {
    status: 503,
    body: { verdict: "stale", error: "monitor_deadline_passed", failureRecorded: false },
  });
});

test("a round that fails with room left records the day's monitor-failure alert once and audits every failure", async () => {
  // Late for the silence alert (the clock jumps after the read), then back
  // to 0, so the failure write still fits the round and its own deadline.
  const lateThenBack = () => {
    let calls = 0;
    return () => (++calls === 4 ? 200_000 : 0);
  };
  await prisma.notificationDelivery.deleteMany({ where: { kind: { in: ["qa_release_digest_stale", "qa_release_monitor_failed", "qa_release_attention", "qa_release_digest_recorded"] } } });
  const before = await prisma.adminAuditLog.count({ where: { action: "qa_release.monitor_failed" } });
  for (let round = 0; round < 2; round += 1) {
    assert.deepEqual(await call({ clock: lateThenBack() }), {
      status: 503,
      body: { verdict: "stale", error: "monitor_deadline_passed", failureRecorded: true },
    });
  }
  assert.equal(await prisma.notificationDelivery.count({ where: { kind: "qa_release_digest_stale" } }), 0);
  const rows = await prisma.notificationDelivery.findMany({ where: { kind: "qa_release_monitor_failed" } });
  assert.equal(rows.length, 1);
  const [{ day }] = await prisma.$queryRaw<{ day: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`;
  assert.equal(rows[0].referenceId, `monitor-failure:${day}`);
  const audits = await prisma.adminAuditLog.findMany({
    where: { action: "qa_release.monitor_failed", targetId: rows[0].id },
    select: { metadata: true },
  });
  assert.equal(audits.length, 2);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.monitor_failed" } }), before + 2);
  for (const audit of audits) {
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.failure, "monitor_deadline_passed");
    assert.equal(metadata.referenceId, `monitor-failure:${day}`);
    assert.equal(metadata.systemActor, "qa-release-intake");
  }
});

test("the one-statement enqueue inserts once, leaves an existing row as it is, and stamps UTC", async () => {
  const kind = "qa_release_monitor_failed" as const;
  const referenceId = "monitor-failure:2000-01-01";
  await prisma.notificationDelivery.deleteMany({ where: { kind, referenceId } });
  const first = await prisma.$transaction((tx) => enqueueNotificationDeliveryOnce(tx, { kind, referenceId }));
  assert.equal(first?.inserted, true);
  await prisma.notificationDelivery.update({ where: { id: first!.id }, data: { attempts: 3 } });
  const second = await prisma.$transaction((tx) => enqueueNotificationDeliveryOnce(tx, { kind, referenceId }));
  assert.deepEqual(second, { id: first!.id, inserted: false });
  const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: first!.id } });
  assert.equal(row.attempts, 3);
  assert.equal(row.status, "pending");
  // Read back through Prisma (UTC), the stamp is the database clock within seconds.
  assert.ok(Math.abs(row.createdAt.getTime() - Date.now()) < 60_000, row.createdAt.toISOString());
  await prisma.notificationDelivery.deleteMany({ where: { kind, referenceId } });
});
