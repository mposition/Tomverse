import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { createConversationUnlockCookie, hasConversationUnlockGrant } from "@/lib/conversationLock";

after(() => prisma.$disconnect());

test("password versions invalidate grants atomically across every native password write", async () => {
  const user = await prisma.user.create({ data: { email: `version-${randomUUID()}@example.test` } });
  const row = await prisma.conversation.create({ data: { userId: user.id, productKey: "chat", title: "Version fixture", selectedModels: "[]" } });
  assert.equal(row.passwordVersion, 0);
  const locked = await prisma.conversation.update({ where: { id: row.id }, data: { password: "legacy-fixture" } });
  assert.equal(locked.passwordVersion, 1);
  const cookie = createConversationUnlockCookie(user.id, row.id, locked.passwordVersion).split(";")[0];
  const request = new Request("https://app.example.test", { headers: { cookie } });
  assert.equal(hasConversationUnlockGrant(request, user.id, row.id, locked.passwordVersion), true);
  const unchanged = await prisma.conversation.update({ where: { id: row.id }, data: { password: "legacy-fixture", title: "Renamed" } });
  assert.equal(unchanged.passwordVersion, 1);
  await prisma.conversation.update({ where: { id: row.id }, data: { password: null } });
  const relocked = await prisma.conversation.update({ where: { id: row.id }, data: { password: "legacy-fixture" } });
  assert.equal(relocked.passwordVersion, 3);
  assert.equal(hasConversationUnlockGrant(request, user.id, row.id, relocked.passwordVersion), false);
  // Existing scripts and old app instances do not need to know the counter exists.
  await prisma.$executeRaw`UPDATE "Conversation" SET "password" = 'upgraded-fixture' WHERE "id" = ${row.id}`;
  const upgraded = await prisma.conversation.update({ where: { id: row.id }, data: { passwordVersion: 0 } });
  assert.equal(upgraded.passwordVersion, 4);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.conversation.update({ where: { id: row.id }, data: { password: "rolled-back-fixture" } });
    throw new Error("rollback fixture");
  }), /rollback fixture/);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: row.id } })).passwordVersion, 4);
  await Promise.all(["one", "two"].map((password) => prisma.conversation.update({ where: { id: row.id }, data: { password } })));
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: row.id } })).passwordVersion, 6);
});

test("snapshot versions advance for set, change and clear even through raw SQL", async () => {
  const user = await prisma.user.create({ data: { email: `snapshot-version-${randomUUID()}@example.test` } });
  const imported = await prisma.externalImport.create({ data: { userId: user.id, provider: "chatgpt", status: "completed", parserVersion: "test-1", digestVersion: 1 } });
  const row = await prisma.externalConversation.create({ data: {
    userId: user.id, importId: imported.id, provider: "chatgpt", title: "Version fixture",
    externalStableId: randomUUID().replaceAll("-", ""),
    conversationDigest: randomUUID().replaceAll("-", "").repeat(2), digestVersion: 1,
    messageCount: 0, contentBytes: BigInt(0), finalized: true,
  } });
  for (const [password, version] of [["first", 1], ["second", 2], [null, 3]] as const) {
    await prisma.$executeRaw`UPDATE "ExternalConversation" SET "password" = ${password} WHERE "id" = ${row.id}`;
    assert.equal((await prisma.externalConversation.findUniqueOrThrow({ where: { id: row.id } })).passwordVersion, version);
  }
});
