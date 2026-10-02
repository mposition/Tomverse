import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
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

const call = (overrides: { env?: Record<string, string>; headers?: Record<string, string> } = {}) =>
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
  );

const cleanup = async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "QaReleaseOperatorControl" DISABLE TRIGGER "QaReleaseOperatorControl_before_delete"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "QaReleaseOperatorControl"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "agentKey" = 'qa-release'`);
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
  assert.deepEqual(await call(), { status: 200, body: { verdict: "stale" } });
  assert.deepEqual(await call({ headers: { "x-qa-release-control-revision": String(revision - 1) } }), {
    status: 409,
    body: { error: "control_revision_mismatch" },
  });
  assert.deepEqual(await call({ env: { QA_RELEASE_MONITOR_SECRET: MONITOR } }), {
    status: 200,
    body: { verdict: "control_mismatch" },
  });
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
  assert.deepEqual(await call(), { status: 200, body: { verdict: "fresh" } });

  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_update"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentDigestItem" SET "createdAt" = clock_timestamp() - INTERVAL '28 hours',
         "retentionUntil" = clock_timestamp() + INTERVAL '60 days' WHERE "idempotencyKey" = 'qa-release:monitor-test:1'`,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_update"`);
  }
  assert.deepEqual(await call(), { status: 200, body: { verdict: "stale" } });
});
