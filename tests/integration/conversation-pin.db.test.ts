import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";

/**
 * `Conversation.pinnedAt` and `Conversation.pinSeq` -- what the sidebar's pinned
 * section reads, and what puts pin writes in order.
 *
 * Two properties are under test, and both are about the **statement**, not the
 * button, because each exists to stop a tidier rewrite later:
 *
 * 1. A pin is not activity. `updatedAt` is `@updatedAt` and the sidebar groups
 *    its date headers by it, so an ordinary Prisma update would file a pinned
 *    conversation under "today". The route writes raw SQL for that reason.
 * 2. The last tap is the last write, in whatever order requests arrive. A write
 *    carries its tap's sequence and applies only over a smaller one, so an older
 *    request that lands late matches no row -- including when two requests both
 *    failed on the wire and the client learned nothing between them.
 *
 * The statement below is the route's, verbatim apart from the placeholders.
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

type PinRow = { pinned: boolean; pinSeq: number };

/** The route's statement. */
const writePin = (userId: string, pinned: boolean, seq: number) =>
  prisma.$queryRaw<PinRow[]>`
    UPDATE "Conversation"
    SET "pinnedAt" = CASE WHEN ${pinned} THEN COALESCE("pinnedAt", NOW()) ELSE NULL END,
        "pinSeq" = ${seq}::double precision
    WHERE "id" = ${conversationId}
      AND "userId" = ${userId}
      AND "pinSeq" < ${seq}::double precision
    RETURNING ("pinnedAt" IS NOT NULL) AS "pinned", "pinSeq"
  `;

const readRow = () =>
  prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { pinnedAt: true, pinSeq: true, updatedAt: true },
  });

const tap = 1_789_000_000_000; // a millisecond timestamp, as the client issues

test("a new conversation is unpinned at sequence 0, and needs no backfill", async () => {
  const row = await readRow();
  assert.equal(row.pinnedAt, null);
  assert.equal(row.pinSeq, 0);
});

test("an accepted write records its sequence and does not move updatedAt", async () => {
  const before = await readRow();
  const applied = await writePin(ownerId, true, tap);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].pinned, true);
  assert.equal(Number(applied[0].pinSeq), tap);

  const after = await readRow();
  assert.notEqual(after.pinnedAt, null);
  assert.equal(
    after.updatedAt.getTime(),
    before.updatedAt.getTime(),
    "a pin must not move the conversation into today's date group"
  );
});

test("a millisecond sequence round-trips exactly", async () => {
  // DOUBLE PRECISION holds every integer below 2^53; a timestamp is far below.
  await writePin(ownerId, true, tap + 1);
  const row = await readRow();
  assert.equal(row.pinSeq, tap + 1);
});

test("an older tap landing after a newer one matches nothing", async () => {
  // The case the sequence exists for: the last tap (unpin) lands first, and the
  // earlier pin arrives afterwards -- as it can when its connection dropped.
  await writePin(ownerId, false, tap + 2);
  const late = await writePin(ownerId, true, tap + 1);

  assert.deepEqual(late, [], "the older tap is refused");
  const row = await readRow();
  assert.equal(row.pinnedAt, null, "the column ends on the last tap");
  assert.equal(row.pinSeq, tap + 2);
});

test("two taps land in either order and the column ends on the last", async () => {
  // Order A: earlier first, then later.
  await writePin(ownerId, true, tap + 10);
  await writePin(ownerId, false, tap + 11);
  assert.equal((await readRow()).pinnedAt, null);

  await resetData();

  // Order B: later first, then earlier.
  await writePin(ownerId, false, tap + 11);
  await writePin(ownerId, true, tap + 10);
  assert.equal((await readRow()).pinnedAt, null);
});

test("resending the same write is harmless and reports that it already landed", async () => {
  await writePin(ownerId, true, tap);
  const resend = await writePin(ownerId, true, tap);
  assert.deepEqual(resend, [], "an equal sequence is not written twice");
  const row = await readRow();
  assert.equal(row.pinSeq, tap, "and the route answers with this sequence, proving it landed");
});

test("re-pinning keeps the original moment it was pinned", async () => {
  await writePin(ownerId, true, tap);
  const first = await readRow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writePin(ownerId, true, tap + 1);
  const second = await readRow();
  assert.equal(second.pinnedAt?.getTime(), first.pinnedAt?.getTime());
});

test("another account's write matches no row at all", async () => {
  const applied = await writePin(otherId, true, tap);
  assert.deepEqual(applied, [], "not found and not mine are the same answer");
  const row = await readRow();
  assert.equal(row.pinnedAt, null);
  assert.equal(row.pinSeq, 0);
});

test("an ordinary Prisma update is exactly what the route may not do", async () => {
  // Pinned here as the failure the raw statement exists to avoid: if someone
  // ever replaces it with this, the sidebar starts dating pins as answers.
  const before = await readRow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pinnedAt: new Date(), pinSeq: tap },
  });
  const after = await readRow();
  assert.ok(
    after.updatedAt.getTime() > before.updatedAt.getTime(),
    "Prisma bumps updatedAt, which is why the route does not use it"
  );
});
