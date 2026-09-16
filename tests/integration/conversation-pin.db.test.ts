import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

/**
 * `Conversation.pinnedAt` — the column the sidebar's pinned section reads.
 *
 * What is under test is the **write**, not the button: a pin must not count as
 * activity. `updatedAt` is `@updatedAt`, the sidebar groups its date headers by
 * it, and an ordinary Prisma update therefore files a pinned conversation under
 * "today" and tells its owner it was answered today. The pin route writes raw
 * SQL for that reason, and these cases are what stops somebody replacing it
 * with a tidier `prisma.conversation.update` later.
 */

const ownerId = `pin-owner-${randomUUID()}`;
const otherId = `pin-other-${randomUUID()}`;
let conversationId = "";

const resetData = async () => {
  await prisma.conversation.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await prisma.user.createMany({
    data: [
      { id: ownerId, email: `${ownerId}@qa.invalid` },
      { id: otherId, email: `${otherId}@qa.invalid` },
    ],
  });
  const conversation = await prisma.conversation.create({
    data: { userId: ownerId, title: "Pinned by its owner" },
    select: { id: true },
  });
  conversationId = conversation.id;
};

beforeEach(resetData);

after(async () => {
  await prisma.conversation.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await prisma.$disconnect();
});

const readRow = () =>
  prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { pinnedAt: true, updatedAt: true },
  });

test("a new conversation is not pinned, and needs no backfill to say so", async () => {
  const row = await readRow();
  assert.equal(row.pinnedAt, null);
});

test("pinning does not count as activity", async () => {
  const before = await readRow();
  // The statement the route runs.
  const affected = await prisma.$executeRaw`
    UPDATE "Conversation"
    SET "pinnedAt" = NOW()
    WHERE "id" = ${conversationId} AND "userId" = ${ownerId} AND "pinnedAt" IS NULL
  `;
  assert.equal(affected, 1);

  const after = await readRow();
  assert.notEqual(after.pinnedAt, null);
  assert.equal(
    after.updatedAt.getTime(),
    before.updatedAt.getTime(),
    "a pin must not move the conversation into today's date group"
  );
});

test("pinning twice changes nothing and reports that it changed nothing", async () => {
  await prisma.$executeRaw`
    UPDATE "Conversation" SET "pinnedAt" = NOW()
    WHERE "id" = ${conversationId} AND "userId" = ${ownerId} AND "pinnedAt" IS NULL
  `;
  const first = await readRow();
  const affected = await prisma.$executeRaw`
    UPDATE "Conversation" SET "pinnedAt" = NOW()
    WHERE "id" = ${conversationId} AND "userId" = ${ownerId} AND "pinnedAt" IS NULL
  `;
  assert.equal(affected, 0, "a second tap, or a second device, is not an error");
  const second = await readRow();
  assert.equal(second.pinnedAt?.getTime(), first.pinnedAt?.getTime());
});

test("unpinning clears the column and still does not count as activity", async () => {
  await prisma.$executeRaw`
    UPDATE "Conversation" SET "pinnedAt" = NOW()
    WHERE "id" = ${conversationId} AND "userId" = ${ownerId} AND "pinnedAt" IS NULL
  `;
  const pinned = await readRow();
  const affected = await prisma.$executeRaw`
    UPDATE "Conversation" SET "pinnedAt" = NULL
    WHERE "id" = ${conversationId} AND "userId" = ${ownerId}
  `;
  assert.equal(affected, 1);
  const cleared = await readRow();
  assert.equal(cleared.pinnedAt, null);
  assert.equal(cleared.updatedAt.getTime(), pinned.updatedAt.getTime());
});

test("another account's pin statement matches no row at all", async () => {
  const affected = await prisma.$executeRaw`
    UPDATE "Conversation" SET "pinnedAt" = NOW()
    WHERE "id" = ${conversationId} AND "userId" = ${otherId} AND "pinnedAt" IS NULL
  `;
  assert.equal(affected, 0, "not found and not mine are the same answer");
  const row = await readRow();
  assert.equal(row.pinnedAt, null);
});

test("an ordinary Prisma update is exactly what the route may not do", async () => {
  // Pinned here as the failure the raw statement exists to avoid: if someone
  // ever replaces it with this, the sidebar starts dating pins as answers.
  const before = await readRow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pinnedAt: new Date() },
  });
  const after = await readRow();
  assert.ok(
    after.updatedAt.getTime() > before.updatedAt.getTime(),
    "Prisma bumps updatedAt, which is why the route does not use it"
  );
});
