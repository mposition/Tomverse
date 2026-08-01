import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";

// Stripe does not guarantee webhook delivery order. The handler used to write
// the event's own payload straight into the account, so an event generated
// before a plan change but delivered after it reverted the account to the older
// plan -- silently, with no failed request and nothing in the logs.
//
// lib/stripeWebhookSyncCore.ts decides *whether* a snapshot is current, and
// tests/stripeWebhookSyncCore.test.mjs pins that decision. What those cannot
// prove is the half that only exists in SQL: the conditional UPDATE that makes
// the comparison and the write one statement, so two handlers racing on the
// same account cannot both read "not stale" and both write.
//
// These scenarios drive that predicate against a real PostgreSQL instance.

const resetUsers = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "User" RESTART IDENTITY CASCADE
  `);
};

beforeEach(resetUsers);
after(async () => {
  await resetUsers();
  await prisma.$disconnect();
});

const T0 = new Date("2026-08-01T10:00:00.000Z");
const EARLIER = new Date("2026-08-01T09:59:00.000Z");
const LATER = new Date("2026-08-01T10:01:00.000Z");

const seedProAccount = async (subscriptionSyncedAt: Date | null) => {
  const id = `user_${randomUUID()}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@tomverse.invalid`,
      plan: "Pro",
      stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionStatus: "active",
      subscriptionSyncedAt,
    },
  });
  return id;
};

/**
 * The exact predicate lib/stripeWebhookProcessing.ts writes with. Duplicated
 * here on purpose: a test that called the production function would also need
 * Stripe, and the thing under test is the SQL, not the fetch around it.
 */
const applySnapshot = (
  userId: string,
  plan: "Free" | "Pro" | "Max",
  observedAt: Date
) =>
  prisma.user.updateMany({
    where: {
      id: userId,
      OR: [
        { subscriptionSyncedAt: null },
        { subscriptionSyncedAt: { lte: observedAt } },
      ],
    },
    data: { plan, subscriptionSyncedAt: observedAt },
  });

test("a late-arriving older snapshot cannot revert a completed upgrade", async () => {
  const userId = await seedProAccount(null);

  // The upgrade lands first.
  const upgrade = await applySnapshot(userId, "Max", T0);
  assert.equal(upgrade.count, 1);

  // The stale event, generated before the upgrade, is delivered afterwards.
  const stale = await applySnapshot(userId, "Pro", EARLIER);
  assert.equal(stale.count, 0, "a stale snapshot must not match any row");

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, subscriptionSyncedAt: true },
  });
  assert.equal(after.plan, "Max");
  assert.equal(after.subscriptionSyncedAt?.toISOString(), T0.toISOString());
});

test("a genuinely newer snapshot still applies", async () => {
  const userId = await seedProAccount(T0);

  const applied = await applySnapshot(userId, "Max", LATER);
  assert.equal(applied.count, 1);

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true },
  });
  assert.equal(after.plan, "Max");
});

test("an account that has never been synced accepts its first snapshot", async () => {
  const userId = await seedProAccount(null);

  const applied = await applySnapshot(userId, "Max", EARLIER);
  assert.equal(applied.count, 1);

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true },
  });
  assert.equal(after.plan, "Max");
});

test("concurrent handlers converge on the newer read, whichever commits first", async () => {
  // Both start from the same stored state, so a read-then-write implementation
  // would have both see "not stale" and let the loser overwrite the winner.
  for (const order of ["newer-first", "older-first"] as const) {
    const userId = await seedProAccount(T0);

    const older = () => applySnapshot(userId, "Pro", T0);
    const newer = () => applySnapshot(userId, "Max", LATER);
    const [first, second] =
      order === "newer-first" ? [newer, older] : [older, newer];

    await first();
    await second();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: true, subscriptionSyncedAt: true },
    });
    assert.equal(
      after.plan,
      "Max",
      `the later read must win regardless of arrival order (${order})`
    );
    assert.equal(after.subscriptionSyncedAt?.toISOString(), LATER.toISOString());
  }
});

test("two reads taken in the same millisecond both apply", async () => {
  // They saw the same Stripe state, so neither is stale and last-write-wins is
  // the correct outcome rather than a dropped update.
  const userId = await seedProAccount(T0);

  assert.equal((await applySnapshot(userId, "Max", T0)).count, 1);
  assert.equal((await applySnapshot(userId, "Max", T0)).count, 1);

  const after = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true },
  });
  assert.equal(after.plan, "Max");
});

test("a stale cancellation cannot clear a subscription that was already replaced", async () => {
  // customer.subscription.deleted goes down its own path, and an unguarded
  // downgrade to Free there would undo a newer subscription on the same
  // customer.
  const userId = await seedProAccount(T0);
  const customer = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });

  const cleared = await prisma.user.updateMany({
    where: {
      stripeCustomerId: customer.stripeCustomerId,
      OR: [
        { subscriptionSyncedAt: null },
        { subscriptionSyncedAt: { lte: EARLIER } },
      ],
    },
    data: {
      plan: "Free",
      stripeSubscriptionId: null,
      subscriptionSyncedAt: EARLIER,
    },
  });

  assert.equal(cleared.count, 0);
  const after = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, stripeSubscriptionId: true },
  });
  assert.equal(after.plan, "Pro");
  assert.notEqual(after.stripeSubscriptionId, null);
});
