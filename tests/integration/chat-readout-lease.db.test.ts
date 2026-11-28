import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { readoutBudgetStore, readoutLeaseStore, readoutPieceLeaseKey } from "@/lib/chatReadoutBudget";
import { READOUT_PIECE_LEASE_SECONDS } from "@/lib/chatReadoutBudgetCore";

/**
 * The server read-aloud's per-piece lease and budget rows against PostgreSQL
 * (lib/chatReadoutBudget.ts): one request per account, answer and piece at a
 * time, decided by the conditional upsert and not by the browser.
 */

process.env.NEXTAUTH_SECRET ||= "chat-readout-lease-db-secret";

const reset = () => prisma.$executeRawUnsafe(`TRUNCATE TABLE "ChatUsageBucket"`);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("concurrent requests for one piece take its lease once", async () => {
  const key = readoutPieceLeaseKey("user_1", "msg_1", 0);
  const taken = await Promise.all(Array.from({ length: 6 }, () => readoutLeaseStore.acquire(key)));
  assert.equal(taken.filter(Boolean).length, 1);
  assert.equal(await readoutLeaseStore.acquire(key), false, "held");
  // Another piece, another answer and another account are separate leases.
  assert.equal(await readoutLeaseStore.acquire(readoutPieceLeaseKey("user_1", "msg_1", 1)), true);
  assert.equal(await readoutLeaseStore.acquire(readoutPieceLeaseKey("user_1", "msg_2", 0)), true);
  assert.equal(await readoutLeaseStore.acquire(readoutPieceLeaseKey("user_2", "msg_1", 0)), true);
});

test("a released lease can be taken again, and leaves no row behind", async () => {
  const key = readoutPieceLeaseKey("user_1", "msg_1", 0);
  assert.equal(await readoutLeaseStore.acquire(key), true);
  await readoutLeaseStore.release(key);
  assert.equal(await prisma.chatUsageBucket.count({ where: { key } }), 0);
  assert.equal(await readoutLeaseStore.acquire(key), true);
});

test("a lease kept after an unknown outcome lapses only after its window", async () => {
  const key = readoutPieceLeaseKey("user_1", "msg_1", 0);
  assert.equal(await readoutLeaseStore.acquire(key), true);
  await prisma.$executeRaw`
    UPDATE "ChatUsageBucket" SET "updatedAt" = NOW() - (${READOUT_PIECE_LEASE_SECONDS - 30}::int * INTERVAL '1 second')
    WHERE "key" = ${key}`;
  assert.equal(await readoutLeaseStore.acquire(key), false, "still inside the window");
  await prisma.$executeRaw`
    UPDATE "ChatUsageBucket" SET "updatedAt" = NOW() - (${READOUT_PIECE_LEASE_SECONDS + 30}::int * INTERVAL '1 second')
    WHERE "key" = ${key}`;
  assert.equal(await readoutLeaseStore.acquire(key), true, "a crashed holder's lease is taken over");
  assert.equal(await readoutLeaseStore.acquire(key), false);
});

test("the budget row is booked only while it has room", async () => {
  const booking = { key: "readout:test", period: "readout-account-chars-day", periodStart: new Date(Date.UTC(2026, 10, 28)) };
  assert.equal(await readoutBudgetStore.book({ ...booking, characters: 6, limit: 10 }), true);
  assert.equal(await readoutBudgetStore.book({ ...booking, characters: 6, limit: 10 }), false);
  assert.equal(await readoutBudgetStore.book({ ...booking, characters: 4, limit: 10 }), true);
  await readoutBudgetStore.unbook({ ...booking, characters: 4 });
  const row = await prisma.chatUsageBucket.findFirstOrThrow({ where: { key: booking.key } });
  assert.equal(Number(row.count), 6);
});
