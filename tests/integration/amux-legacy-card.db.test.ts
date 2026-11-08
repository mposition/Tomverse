import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Session } from "next-auth";

import { AmuxLegacyCardOwnerError, closeAmuxLegacyCardForOwner,
  readAmuxLegacyCardView } from "@/lib/amux/legacyCardOwnerService";
import { prisma } from "@/lib/prisma";

// Closing a legacy WORKBOARD card (owner decision 2026-11-08) against
// PostgreSQL: the card is archived with its status kept, its open escalation
// resolved, and one audit entry chained by the administrator writer in the
// same transaction. Only the seed turns triggers off, because a card's history
// is not what is under test.

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

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-legacy-card-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });
const OWNER_ID = `legacy-card-owner-${randomUUID()}`;
const OWNER_EMAIL = "amux-legacy-card-owner@example.test";
process.env.ADMIN_USER_IDS = OWNER_ID;
process.env.ADMIN_EMAILS = OWNER_EMAIL;
process.env.ADMIN_OWNER_EMAILS = OWNER_EMAIL;

const owner = () => ({
  user: { id: OWNER_ID, email: OWNER_EMAIL, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
}) as Session;
const request = () => new Request("https://tomverse.test/api/admin/amux/legacy-card", {
  method: "POST", headers: { "user-agent": "synthetic-legacy-card" } });

const seeded: string[] = [];
const digest = "a".repeat(64);
let counter = 0;

async function seedCard(input: { sourceSystem?: string; status?: string; revision?: number;
  escalation?: boolean; delivery?: boolean; archived?: boolean } = {}) {
  const id = `legacy-${randomUUID()}`;
  counter += 1;
  seeded.push(id);
  const description = JSON.stringify({ problem: "The renewal date is hidden. Users ask support.",
    completionCriteria: ["The date shows"] });
  const sourceSystem = input.sourceSystem ?? "tomverse_private_workboard";
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`
      INSERT INTO "AmuxWorkItem" ("id", "title", "description", "status", "revision", "sourceSystem", "sourceKey",
        "sourceVersion", "sourceDigest", "sourceSnapshot", "archivedAt", "createdAt", "updatedAt")
      VALUES (${id}, ${"card " + id.slice(-16)}, ${description}, ${input.status ?? "review"}, ${input.revision ?? 4},
        ${sourceSystem}, ${`WB-${randomUUID().slice(0, 8).toUpperCase()}-${counter}`}, '1', ${digest},
        ${JSON.stringify({ synthetic: true })}::jsonb, ${input.archived ? new Date() : null}::timestamp,
        now(), now())`;
    if (input.escalation !== false) {
      await tx.$executeRaw`
        INSERT INTO "AmuxHumanEscalation" ("id", "taskId", "reason", "status", "openedBy", "createdAt", "updatedAt")
        VALUES (${`esc-${randomUUID()}`}, ${id}, 'local_card_closed', 'open', 'amux-sync', now(), now())`;
    }
    if (input.delivery) {
      await tx.$executeRaw`
        INSERT INTO "AmuxWorkDelivery" ("attemptId", "taskId", "worker", "workerInstanceId", "workerGeneration",
          "taskRevision", "prompt", "status", "createdAt", "updatedAt")
        VALUES (${`att-${randomUUID()}`}, ${id}, 'claude-impl', 'instance-1', 1, ${input.revision ?? 4},
          'synthetic', 'queued', now(), now())`;
    }
  });
  return id;
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

const auditsOf = (taskId: string) => prisma.adminAuditLog.findMany({
  where: { action: "amux.legacy_card.closed", targetId: taskId } });

test("closing archives the card, keeps its status, resolves its escalation and chains one audit entry", async () => {
  const id = await seedCard();
  const view = await readAmuxLegacyCardView({ id, revision: 4, displayKey: null,
    sourceSystem: "tomverse_private_workboard", description: (await prisma.amuxWorkItem.findUnique({
      where: { id }, select: { description: true } }))!.description, executionBrief: null });
  assert.equal(view?.closeRefusal, null);
  assert.equal(view?.idea.state, "ready");

  const result = await closeAmuxLegacyCardForOwner({ session: owner(), request: request(), taskId: id,
    revision: 4, ideaId: "idea-synthetic-1" });
  assert.equal(result.outcome, "closed");
  const card = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id },
    select: { status: true, revision: true, archivedAt: true } });
  assert.equal(card.status, "review");
  assert.equal(card.revision, 5);
  assert.ok(card.archivedAt);
  const escalations = await prisma.amuxHumanEscalation.findMany({ where: { taskId: id } });
  assert.deepEqual(escalations.map((row) => [row.status, row.resolutionOutcome, row.resolvedById]),
    [["resolved", "block", OWNER_ID]]);
  assert.match(escalations[0]!.resolution ?? "", /recreated as AMUX idea idea-synthetic-1/);
  const audits = await auditsOf(id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actorUserId, OWNER_ID);
  assert.ok(audits[0]!.entryHash, "the administrator writer chains the entry");
  assert.deepEqual((audits[0]!.metadata as Record<string, unknown>).recreatedIdeaId, "idea-synthetic-1");
  assert.equal((audits[0]!.metadata as Record<string, unknown>).escalationsResolved, 1);

  // A second close refuses and writes nothing.
  assert.deepEqual(await closeAmuxLegacyCardForOwner({ session: owner(), request: request(), taskId: id,
    revision: 5, ideaId: null }), { outcome: "refused", reason: "already_closed" });
  assert.equal((await auditsOf(id)).length, 1);
});

test("a queued delivery, a changed revision or another source refuses without any write", async () => {
  const running = await seedCard({ delivery: true });
  assert.equal((await readAmuxLegacyCardView({ id: running, revision: 4, displayKey: null,
    sourceSystem: "tomverse_private_workboard", description: "x", executionBrief: null }))?.closeRefusal,
  "running");
  const stale = await seedCard();
  const intake = await seedCard({ sourceSystem: "local-agent-intake" });
  for (const [id, revision, reason] of [[running, 4, "running"], [stale, 3, "changed"],
    [intake, 4, "not_legacy"]] as const) {
    assert.deepEqual(await closeAmuxLegacyCardForOwner({ session: owner(), request: request(), taskId: id,
      revision, ideaId: null }), { outcome: "refused", reason });
    const card = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id },
      select: { revision: true, archivedAt: true } });
    assert.deepEqual(card, { revision: 4, archivedAt: null });
    assert.equal((await prisma.amuxHumanEscalation.findFirstOrThrow({ where: { taskId: id } })).status, "open");
    assert.equal((await auditsOf(id)).length, 0);
  }
  assert.deepEqual(await closeAmuxLegacyCardForOwner({ session: owner(), request: request(),
    taskId: "legacy-missing", revision: 1, ideaId: null }), { outcome: "not_found" });
});

test("a card a worker holds answers busy at once instead of waiting", async () => {
  const id = await seedCard({ escalation: false });
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
    await assert.rejects(closeAmuxLegacyCardForOwner({ session: owner(), request: request(), taskId: id,
      revision: 4, ideaId: null }), (error) => error instanceof AmuxLegacyCardOwnerError && error.code === "busy");
  } finally { release(); await holder; }
  assert.equal((await auditsOf(id)).length, 0);
  assert.equal((await closeAmuxLegacyCardForOwner({ session: owner(), request: request(), taskId: id,
    revision: 4, ideaId: null })).outcome, "closed");
});

test("only a recently authenticated owner closes", async () => {
  const id = await seedCard();
  const stale = { ...owner(), user: { ...owner().user, authenticatedAt: new Date(0).toISOString() } } as Session;
  await assert.rejects(closeAmuxLegacyCardForOwner({ session: stale, request: request(), taskId: id,
    revision: 4, ideaId: null }));
  const notOwner = { user: { id: "someone-else", email: "else@example.test",
    authenticatedAt: new Date().toISOString() }, expires: owner().expires } as Session;
  await assert.rejects(closeAmuxLegacyCardForOwner({ session: notOwner, request: request(), taskId: id,
    revision: 4, ideaId: null }), (error) => error instanceof AmuxLegacyCardOwnerError && error.code === "forbidden");
  assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id } })).archivedAt, null);
});
