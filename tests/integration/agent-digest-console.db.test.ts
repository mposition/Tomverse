import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { prisma } from "@/lib/prisma";
import { buildQaReleaseDigest } from "@/lib/qaReleaseDigestBuildCore";

// The Admin Agent digest reader (lib/agentDigestConsoleRead.ts): a parsed
// body becomes counts and codes, an expired body says so, and a body that no
// longer matches the closed schema is shown as unreadable, never half-drawn.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const cleanup = async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "agentKey" = 'qa-release'`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
  }
};
before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const store = (payload: unknown) =>
  recordAgentDigestItem({
    agentKey: "qa-release",
    kind: "daily_digest",
    schemaVersion: 1,
    idempotencyKey: `qa-release:console:${randomUUID()}`,
    payload,
  });

test("present, expired and unreadable bodies are each shown for what they are", async () => {
  const digest = buildQaReleaseDigest({
    digestDate: "2026-10-03",
    baseSha: "c".repeat(40),
    generatedAt: "2026-10-03T21:00:00.000Z",
    runDeadline: "2026-10-03T21:15:00.000Z",
    gateReport: { classified: [{ id: "ROUTE-01", status: "pending", verdict: "implemented_unmeasured" }] },
    hypotheticalReports: [],
    issueReport: null,
    checks: [{ name: "check:release-records", result: "fail" }],
    ci: [],
    releaseLane: [],
    notChecked: [],
  });
  const present = await store(digest);
  const unreadable = await store({ not: "a digest" });
  const expired = await store({ soon: "gone" });
  assert.equal(present.status, "created");
  assert.equal(unreadable.status, "created");
  assert.equal(expired.status, "created");
  if (expired.status !== "created") return;

  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_update"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentDigestItem" SET "payload" = NULL, "bodyDeletedAt" = clock_timestamp() WHERE "id" = $1::uuid`,
      expired.id,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_update"`);
  }

  const console = await readAgentDigestConsole(false);
  assert.equal(console.canWrite, false);
  // No latch event and no attempt: the lane reads as free with nothing open.
  assert.deepEqual(console.mergeLane, { latched: false, latch: null, latchAttempt: null, openAttempt: null });
  const byId = new Map(console.digests.map((row) => [row.id, row]));
  const shown = byId.get(present.status === "created" ? present.id : "");
  assert.equal(shown?.body, "present");
  assert.equal(shown?.digestDate, "2026-10-03");
  assert.equal(shown?.summary?.failedChecks, 1);
  assert.equal(shown?.summary?.issuesAvailable, false);
  assert.deepEqual(shown?.summary?.notChecked, ["issue_backlog_unavailable", "gates_changed_not_compared"]);
  assert.equal(byId.get(unreadable.status === "created" ? unreadable.id : "")?.body, "unreadable");
  assert.equal(byId.get(expired.id)?.body, "expired");
  assert.equal(console.limit, 14);
  assert.equal(JSON.stringify(console).includes("a digest"), false, "an unreadable body is never echoed");
});
