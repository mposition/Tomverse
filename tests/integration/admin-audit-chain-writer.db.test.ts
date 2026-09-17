import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { verifyAdminAuditIntegrity } from "@/lib/adminAuditIntegrity";
import { prisma } from "@/lib/prisma";

// The audit writer against a real table: rows it writes form a chain the
// verifier accepts.
//
// Contract: docs/policy/marketing-automation.md §6 -- human and system actions
// share this chain, and the system writer shares this writer's lock and hash
// path. The unit-level characterization lives in
// tests/server-contract/admin-audit-chain-writer.test.ts and pins *how* the
// writer talks to the database; this suite is the half a fake client cannot
// prove: that `clock_timestamp()` ordering, the `previousHash` read and the
// verifier agree on real rows, inside and outside a caller's transaction, and
// for human and system entries in the same chain.

const SECRET = "admin-audit-chain-writer-db-secret-0032";

const reset = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY`);

const session = {
  user: { id: "admin-chain-writer", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

let previousKey: string | undefined;

beforeEach(async () => {
  previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = SECRET;
  await reset();
});

after(async () => {
  if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
  await prisma.$disconnect();
});

test("rows written with and without a caller transaction link and verify", async () => {
  const first = await writeAdminAuditLog({
    session,
    request: new Request("https://tomverse.app/api/admin/example", {
      headers: { "user-agent": "chain-writer-db" },
    }),
    action: "example.first",
    targetType: "Example",
    targetId: "example-1",
    summary: "First entry.",
    metadata: { creditUsd: 12, creditsPurchased: 3 },
  });
  const second = await prisma.$transaction((tx) =>
    writeAdminAuditLog({
      session,
      action: "example.second",
      targetType: "Example",
      summary: "Second entry.",
      tx,
    })
  );

  const rows = await prisma.adminAuditLog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    [first, second]
  );
  assert.equal(rows[0].previousHash, null);
  assert.ok(rows[0].entryHash);
  assert.equal(rows[1].previousHash, rows[0].entryHash);

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.checkedEntries, 2);
  assert.equal(report.verifiedEntries, 2);
  assert.equal(report.linkageBreaks, 0);
});

test("a caller's transaction that rolls back leaves no audit row behind", async () => {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await writeAdminAuditLog({
        session,
        action: "example.rolled_back",
        targetType: "Example",
        summary: "Never committed.",
        tx,
      });
      throw new Error("caller failed after auditing");
    }),
    /caller failed after auditing/
  );
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("human and system entries interleave in one chain that verifies", async () => {
  // docs/policy/marketing-automation.md §6: one chain for both kinds of actor.
  // Interleaved on purpose -- a system entry that hashed or linked differently
  // would break the human entry written after it, not just itself.
  await writeAdminAuditLog({
    session,
    action: "marketing_post.approve",
    targetType: "MarketingPost",
    targetId: "post-1",
    summary: "Approved.",
    metadata: { digest: "a".repeat(64) },
  });
  await prisma.$transaction((tx) =>
    writeSystemAuditLog({
      tx,
      systemActor: "marketing-publisher",
      action: "marketing_post.dispatched",
      targetType: "MarketingPost",
      targetId: "post-1",
      summary: "Dispatched.",
      metadata: { attempt: 1 },
    })
  );
  await writeAdminAuditLog({
    session,
    action: "marketing_account.pause",
    targetType: "MarketingChannel",
    targetId: "channel-1",
    summary: "Paused.",
  });

  const rows = await prisma.adminAuditLog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(
    rows.map((row) => auditRowActorKind(row)),
    ["human", "system", "human"]
  );
  assert.deepEqual(rows[1].metadata, {
    attempt: 1,
    systemActor: "marketing-publisher",
  });
  assert.equal(rows[1].previousHash, rows[0].entryHash);
  assert.equal(rows[2].previousHash, rows[1].entryHash);

  const report = await verifyAdminAuditIntegrity();
  assert.equal(report.valid, true);
  assert.equal(report.checkedEntries, 3);
  assert.equal(report.verifiedEntries, 3);
});

test("a system entry rolls back with the change it describes", async () => {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await writeSystemAuditLog({
        tx,
        systemActor: "marketing-retention",
        action: "marketing_post.content_purged",
        targetType: "MarketingPost",
        summary: "Never committed.",
      });
      throw new Error("purge failed after auditing");
    }),
    /purge failed after auditing/
  );
  assert.equal(await prisma.adminAuditLog.count(), 0);
});
