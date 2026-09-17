import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
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
// verifier agree on real rows, inside and outside a caller's transaction.

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
