import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { commitAmuxIntakeRegistration, readAmuxIntakeRegistration } from "@/lib/amux/intakeRegistration";
import { amuxIntakeDraftDigest, parseAmuxIntakeDraft } from "@/lib/amux/intakeCore";
import { planAmuxIntakeRegistration } from "@/lib/amux/intakeRegistrationCore";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for one explicit intake registration.
// The public route calls apply, which checks the latch and then this commit.
// This file calls the transaction body directly. A missing TEST_DATABASE_URL
// means this file was not executed, not that it passed.

const secret = `intake-hmac-secret-${randomUUID()}-extra`;
const actorUserId = `amux-intake-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "intake@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/intake");
const cardIds: string[] = [];

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX intake DB tests require DATABASE_URL=TEST_DATABASE_URL");
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const schemaName = url.searchParams.get("schema");
  const dedicatedSchema = schemaName === "tomverse_amux_test";
  const canonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!dedicatedSchema && !canonicalCiDatabase) || url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: AMUX intake DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

after(async () => {
  if (cardIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: cardIds } },
      data: { archivedAt: new Date() },
    });
  }
  await prisma.$disconnect();
});

const draftBody = (taskId: string, title: string) => ({
  canonicalizationVersion: "amux-json-v1",
  policyVersion: 1,
  explicitRegistration: true,
  sourceTaskId: taskId,
  workItem: { id: "AMUX-INTAKE-01", version: "v1", digest: "ab".repeat(32) },
  proposal: {
    title,
    scope: "Owner confirms a single backlog card",
    completion: "The card stays backlog",
    priority: "p2",
  },
});

const confirmed = (taskId: string, title: string) => {
  const raw = draftBody(taskId, title);
  const parsed = parseAmuxIntakeDraft(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(parsed.code);
  return JSON.stringify({ ...raw, confirmationDigest: amuxIntakeDraftDigest(parsed.draft) });
};

const untouchedCounts = async () => ({
  attempts: await prisma.amuxExecutionAttempt.count(),
  deliveries: await prisma.amuxWorkDelivery.count(),
  routes: await prisma.amuxRouteDecision.count(),
  costs: await prisma.amuxCostLedgerEntry.count(),
  creditLots: await prisma.creditLot.count(),
  creditLedger: await prisma.creditLedgerEntry.count(),
  todos: await prisma.amuxWorkItem.count({ where: { status: "todo" } }),
});

test("registration writes one backlog card and leaves execution and credit unchanged", async () => {
  const taskId = `codex-turn-${randomUUID()}`;
  const title = "Register one intake unit";
  const planned = planAmuxIntakeRegistration(confirmed(taskId, title), secret);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal((await readAmuxIntakeRegistration(planned.plan)).kind, "absent");
  const before = await untouchedCounts();
  const result = await prisma.$transaction((tx) =>
    commitAmuxIntakeRegistration(tx, {
      session,
      request,
      plan: planned.plan,
      approvalId: randomUUID(),
    }),
  );
  assert.equal(result.created, true);
  cardIds.push(result.cardId);
  const seen = await readAmuxIntakeRegistration(planned.plan);
  assert.equal(seen.kind, "committed");
  if (seen.kind === "committed") {
    assert.equal(seen.cardId, result.cardId);
    assert.equal(seen.approvalId, result.approvalId);
    assert.equal(seen.auditId, result.auditId);
  }
  const card = await prisma.amuxWorkItem.findUnique({ where: { id: result.cardId } });
  assert.equal(card?.status, "backlog");
  assert.equal(card?.kind, "unknown");
  assert.equal(card?.owner, null);
  assert.equal(card?.claimedAt, null);
  assert.equal(card?.executionBrief, null);
  assert.equal(card?.title, title);
  const after = await untouchedCounts();
  assert.deepEqual(after, before);
  const draft = await prisma.$queryRaw<Array<{ title: string | null; status: string }>>`
    SELECT "title", "status" FROM "AmuxIntakeDraft" WHERE "workItemId" = ${result.cardId}
  `;
  assert.equal(draft.length, 1);
  assert.equal(draft[0]?.title, null);
  assert.equal(draft[0]?.status, "consumed");
  const audit = await prisma.adminAuditLog.findUnique({ where: { id: result.auditId ?? "" } });
  assert.equal(JSON.stringify(audit?.metadata ?? {}).includes(title), false);
  const again = await prisma.$transaction((tx) =>
    commitAmuxIntakeRegistration(tx, {
      session,
      request,
      plan: planned.plan,
      approvalId: randomUUID(),
    }),
  );
  assert.equal(again.created, false);
  assert.equal(again.cardId, result.cardId);
  const changed = planAmuxIntakeRegistration(confirmed(taskId, "A different intake unit"), secret);
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  await assert.rejects(
    () =>
      prisma.$transaction((tx) =>
        commitAmuxIntakeRegistration(tx, {
          session,
          request,
          plan: changed.plan,
          approvalId: randomUUID(),
        }),
      ),
    (error: unknown) => error instanceof Error && error.message === "conflict",
  );
  assert.equal((await readAmuxIntakeRegistration(changed.plan)).kind, "partial");
  const still = await prisma.amuxWorkItem.findUnique({ where: { id: result.cardId } });
  assert.equal(still?.title, title);
  assert.equal(still?.sourceDigest, card?.sourceDigest);
  assert.deepEqual(await untouchedCounts(), before);
});
