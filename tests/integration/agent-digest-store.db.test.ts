import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { prisma } from "@/lib/prisma";

// lib/agentDigestStore.ts against PostgreSQL through the migration history:
// the row and its system audit entry commit together, a repeat writes
// nothing, and a refused submission never reaches the database.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const createdIds: string[] = [];

after(async () => {
  if (createdIds.length > 0) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "id" = ANY($1::uuid[])`, createdIds);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
    }
  }
  await prisma.$disconnect();
});

const submission = (payload: unknown = { gates: { pending: 40 } }) => ({
  agentKey: "qa-release",
  kind: "daily_digest",
  schemaVersion: 1,
  idempotencyKey: `qa-release:test:${randomUUID()}`,
  payload,
});

const auditCount = (targetId: string) =>
  prisma.adminAuditLog.count({ where: { targetType: "AgentDigestItem", targetId } });

test("a new item is one row and one system audit entry, with the canonical hash and no payload in the audit", async () => {
  const input = submission();
  const result = await recordAgentDigestItem(input);
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  createdIds.push(result.id);

  const row = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: result.id } });
  assert.equal(row.payloadSha256, result.payloadSha256);
  assert.equal(row.sizeBytes, result.sizeBytes);
  assert.deepEqual(row.payload, input.payload);

  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditLogId } });
  assert.equal(audit.action, "agent_digest.recorded");
  assert.equal(audit.targetId, result.id);
  assert.equal(audit.actorUserId, null);
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.systemActor, "qa-release-intake");
  assert.equal(metadata.payloadSha256, result.payloadSha256);
  assert.equal("payload" in metadata, false);
});

test("the same key and bytes replay; different bytes conflict; neither writes a row or an audit entry", async () => {
  const input = submission({ a: 1 });
  const first = await recordAgentDigestItem(input);
  assert.equal(first.status, "created");
  if (first.status !== "created") return;
  createdIds.push(first.id);

  // Key order differs, canonical bytes do not.
  const replay = await recordAgentDigestItem({ ...input, payload: { a: 1 } });
  assert.deepEqual(replay, { status: "replayed", id: first.id, payloadSha256: first.payloadSha256 });

  const conflict = await recordAgentDigestItem({ ...input, payload: { a: 2 } });
  assert.deepEqual(conflict, { status: "conflict", id: first.id });

  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } }), 1);
  assert.equal(await auditCount(first.id), 1);
});

test("concurrent submissions under one key leave exactly one row and one audit entry", async () => {
  const input = submission({ race: true });
  const results = await Promise.all(Array.from({ length: 4 }, () => recordAgentDigestItem(input)));
  const created = results.filter((result) => result.status === "created");
  assert.equal(created.length, 1, JSON.stringify(results.map((result) => result.status)));
  assert.ok(results.every((result) => result.status === "created" || result.status === "replayed"));
  const id = created[0].status === "created" ? created[0].id : "";
  createdIds.push(id);
  assert.equal(await auditCount(id), 1);
});

test("a refused submission writes nothing", async () => {
  const input = submission({ note: `ghp_${"A".repeat(36)}` });
  const before = await prisma.adminAuditLog.count();
  const result = await recordAgentDigestItem(input);
  assert.deepEqual(result, { status: "refused", reason: "payload_contains_secret", secretRuleIds: ["github-token"] });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } }), 0);
  assert.equal(await prisma.adminAuditLog.count(), before);
});
