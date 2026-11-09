import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Session } from "next-auth";

import { AmuxLegacyCardOwnerError } from "@/lib/amux/legacyCardOwnerService";
import { closeAmuxSettledCardEscalationsForOwner } from "@/lib/amux/settledCardEscalationService";
import { prisma } from "@/lib/prisma";

// AMUX-FILEREQ-004 (2026-11-09) against PostgreSQL: the owner closes the
// escalation an earlier attempt left open on a done or todo card, with one
// administrator audit entry in the same transaction, and the card is left as
// it was. Only the seed turns triggers off, because a card's history is not
// what is under test.

const testRaw = process.env.TEST_DATABASE_URL?.trim();
if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
  throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
}
const url = new URL(testRaw);
if (!(url.searchParams.get("schema") === "tomverse_amux_test" ||
  (decodeURIComponent(url.pathname.replace(/^\/+/, "")) === "tomverse_test" &&
    ["127.0.0.1", "localhost"].includes(url.hostname)))) {
  throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
}

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-settled-card-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });
const OWNER_ID = `settled-card-owner-${randomUUID()}`;
const OWNER_EMAIL = "amux-settled-card-owner@example.test";
process.env.ADMIN_USER_IDS = OWNER_ID;
process.env.ADMIN_EMAILS = OWNER_EMAIL;
process.env.ADMIN_OWNER_EMAILS = OWNER_EMAIL;

const owner = () => ({
  user: { id: OWNER_ID, email: OWNER_EMAIL, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
}) as Session;
const request = () => new Request("https://tomverse.test/api/admin/amux/settled-card-escalation", {
  method: "POST", headers: { "user-agent": "synthetic-settled-card" } });

const seeded: string[] = [];
const digest = "a".repeat(64);
let counter = 0;

/**
 * One card with at most one open escalation (the partial unique index allows
 * one). The close does not read the card's source, so a plain card stands in for a
 * v4 Task, whose encrypted body is not what is under test.
 */
async function seedCard(input: { status: string; revision?: number;
  escalation?: { specialty: string | null; openedTaskRevision: number | null; createdAt?: Date } | null;
  delivery?: boolean }) {
  const id = `settled-${randomUUID()}`;
  const escalationId = `esc-${randomUUID()}`;
  counter += 1;
  seeded.push(id);
  const revision = input.revision ?? 6;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`
      INSERT INTO "AmuxWorkItem" ("id", "title", "description", "executionBrief", "executionBriefDigest", "status",
        "revision", "sourceSystem", "sourceKey", "sourceVersion", "sourceDigest", "sourceSnapshot", "createdAt", "updatedAt")
      VALUES (${id}, ${"card " + id.slice(-16)}, 'synthetic', 'synthetic brief', ${digest}, ${input.status}, ${revision},
        'tomverse_private_workboard', ${`SC-${randomUUID().slice(0, 8).toUpperCase()}-${counter}`}, '1', ${digest},
        ${JSON.stringify({ synthetic: true })}::jsonb, now(), now())`;
    if (input.escalation !== null) {
      const escalation = input.escalation ?? { specialty: "execution-recovery", openedTaskRevision: 3 };
      await tx.$executeRaw`
        INSERT INTO "AmuxHumanEscalation" ("id", "taskId", "specialty", "reason", "status", "openedBy",
          "openedTaskRevision", "createdAt", "updatedAt")
        VALUES (${escalationId}, ${id}, ${escalation.specialty}, 'usage_outcome_unknown', 'open', 'claude-impl',
          ${escalation.openedTaskRevision}::integer, ${escalation.createdAt ?? new Date()}::timestamp, now())`;
    }
    if (input.delivery) {
      await tx.$executeRaw`
        INSERT INTO "AmuxWorkDelivery" ("attemptId", "taskId", "worker", "workerInstanceId", "workerGeneration",
          "taskRevision", "prompt", "status", "createdAt", "updatedAt")
        VALUES (${`att-${randomUUID()}`}, ${id}, 'codex-impl', 'instance-1', 1, ${revision},
          'synthetic', 'queued', now(), now())`;
    }
  });
  return { id, escalationId };
}

after(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`DELETE FROM "AmuxWorkDelivery" WHERE "taskId" = ANY(${seeded})`;
    await tx.$executeRaw`DELETE FROM "AmuxHumanEscalation" WHERE "taskId" = ANY(${seeded})`;
    await tx.$executeRaw`DELETE FROM "AmuxWorkItem" WHERE "id" = ANY(${seeded})`;
  });
  await prisma.$disconnect();
});

const auditsOf = (taskId: string, action: string) => prisma.adminAuditLog.findMany({
  where: { action, targetId: taskId } });
const escalationOf = (id: string) => prisma.amuxHumanEscalation.findUniqueOrThrow({ where: { id } });

for (const status of ["done", "todo"]) test(`the owner closes a ${status} card's leftover escalation once; the card stays ${status} at its revision`, async () => {
  const { id, escalationId } = await seedCard({ status });
  const result = await closeAmuxSettledCardEscalationsForOwner({ session: owner(), request: request(),
    taskId: id, escalationId });
  assert.equal(result.outcome, "closed");
  const card = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id },
    select: { status: true, revision: true, archivedAt: true } });
  assert.deepEqual(card, { status, revision: 6, archivedAt: null });
  const row = await escalationOf(escalationId);
  assert.equal(row.status, "resolved");
  assert.equal(row.resolutionOutcome, "retry");
  assert.equal(row.resolvedById, OWNER_ID);
  const audits = await auditsOf(id, "amux.settled_card.escalation_closed");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actorUserId, OWNER_ID);
  assert.ok(audits[0]!.entryHash, "the administrator writer chains the entry");
  assert.equal((audits[0]!.metadata as Record<string, unknown>).escalationsResolved, 1);
  // A second press finds nothing left and writes nothing.
  assert.deepEqual(await closeAmuxSettledCardEscalationsForOwner({ session: owner(), request: request(),
    taskId: id, escalationId }), { outcome: "refused", reason: "no_open_escalation" });
  assert.equal((await auditsOf(id, "amux.settled_card.escalation_closed")).length, 1);
});

test("a card in review, blocked or doing, one with queued work, or another escalation refuses without writing", async () => {
  const review = await seedCard({ status: "review" });
  const blocked = await seedCard({ status: "blocked" });
  const doing = await seedCard({ status: "doing" });
  const queued = await seedCard({ status: "todo", delivery: true });
  const other = await seedCard({ status: "done" });
  const cases: Array<[{ id: string; escalationId: string }, string, string]> = [
    [review, review.escalationId, "decision_available"],
    [blocked, blocked.escalationId, "decision_available"],
    [doing, doing.escalationId, "running"],
    [queued, queued.escalationId, "running"],
    [other, "esc-not-this-one", "changed"],
  ];
  for (const [card, shown, reason] of cases) {
    assert.deepEqual(await closeAmuxSettledCardEscalationsForOwner({ session: owner(), request: request(),
      taskId: card.id, escalationId: shown }), { outcome: "refused", reason });
    assert.equal((await escalationOf(card.escalationId)).status, "open");
    assert.equal((await auditsOf(card.id, "amux.settled_card.escalation_closed")).length, 0);
  }
  assert.deepEqual(await closeAmuxSettledCardEscalationsForOwner({ session: owner(), request: request(),
    taskId: "settled-missing", escalationId: "esc-missing" }), { outcome: "not_found" });
});

test("a card a worker holds answers busy at once, and only a recently authenticated owner closes", async () => {
  const { id, escalationId } = await seedCard({ status: "done" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => { locked = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${id} FOR UPDATE`;
    locked();
    await held;
  }, { timeout: 20_000 });
  await isLocked;
  try {
    await assert.rejects(closeAmuxSettledCardEscalationsForOwner({ session: owner(), request: request(),
      taskId: id, escalationId }), (error) => error instanceof AmuxLegacyCardOwnerError && error.code === "busy");
  } finally { release(); await holder; }
  const notOwner = { user: { id: "someone-else", email: "else@example.test",
    authenticatedAt: new Date().toISOString() }, expires: owner().expires } as Session;
  await assert.rejects(closeAmuxSettledCardEscalationsForOwner({ session: notOwner, request: request(),
    taskId: id, escalationId }), (error) => error instanceof AmuxLegacyCardOwnerError && error.code === "forbidden");
  const stale = { ...owner(), user: { ...owner().user, authenticatedAt: new Date(0).toISOString() } } as Session;
  await assert.rejects(closeAmuxSettledCardEscalationsForOwner({ session: stale, request: request(),
    taskId: id, escalationId }));
  assert.equal((await escalationOf(escalationId)).status, "open");
  assert.equal((await auditsOf(id, "amux.settled_card.escalation_closed")).length, 0);
});
