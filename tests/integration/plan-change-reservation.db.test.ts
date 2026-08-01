import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";

// One account may have at most one plan change in flight. The application layer
// checks for that -- resolvePlanChange() refuses a second request while one is
// pending -- but two confirms racing each other can both pass that check and
// both reach the insert. A second reservation means two competing changes to
// the same subscription, and whichever Stripe applies last silently wins.
//
// The guarantee therefore lives in the schema, as a unique index on
// `pendingForUserId` -- a column that carries the account id exactly while the
// row is pending. The natural spelling is a partial unique index over (userId)
// WHERE status = 'pending', but this suite builds its database with
// `prisma db push`, which reads schema.prisma and never runs migration SQL: a
// constraint written only in a migration is absent here, and these tests would
// pass against a database that has no constraint at all. Postgres does not
// compare nulls, so settled rows accumulate freely while the pending slot
// stays single.

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "PlanChangeRequest", "User" RESTART IDENTITY CASCADE
  `);
};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedMaxAccount = async () => {
  const id = `user_${randomUUID()}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@tomverse.invalid`,
      plan: "Max",
      stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      subscriptionStatus: "active",
    },
  });
  return id;
};

/**
 * Mirrors what lib/planChangeService.ts writes: `pendingForUserId` is set with
 * the status and cleared with it, never independently.
 */
const reservation = (
  userId: string,
  status: string,
  overrides: Record<string, unknown> = {}
) => ({
  pendingForUserId: status === "pending" ? userId : null,
  userId,
  direction: "downgrade",
  execution: "scheduled_downgrade",
  fromTier: "Max",
  toTier: "Pro",
  billingInterval: "monthly",
  currency: "usd",
  stripeSubscriptionId: `sub_${randomUUID()}`,
  stripeSubscriptionItemId: `si_${randomUUID()}`,
  targetStripePriceId: `price_${randomUUID()}`,
  fingerprint: "sub_1|active|Max|monthly|usd|si_1|1|renewing|settled|-",
  renewalDecision: "unaffected",
  status,
  ...overrides,
});

test("an account cannot hold two changes in flight at once", async () => {
  const userId = await seedMaxAccount();

  await prisma.planChangeRequest.create({
    data: reservation(userId, "pending"),
  });

  await assert.rejects(
    () => prisma.planChangeRequest.create({ data: reservation(userId, "pending") }),
    /Unique constraint|duplicate key/i,
    "a second pending reservation must be refused by the database"
  );
});

test("settled changes do not block a new one", async () => {
  // History has to accumulate. An account that downgraded, changed its mind and
  // upgraded again would otherwise be locked out by its own past, which is why
  // the slot is a nullable column rather than a unique index on userId.
  const userId = await seedMaxAccount();

  for (const status of ["applied", "cancelled", "expired", "failed"]) {
    await prisma.planChangeRequest.create({
      data: reservation(userId, status),
    });
  }
  await prisma.planChangeRequest.create({
    data: reservation(userId, "previewed"),
  });
  await prisma.planChangeRequest.create({
    data: reservation(userId, "previewed"),
  });

  const accepted = await prisma.planChangeRequest.create({
    data: reservation(userId, "pending"),
  });
  assert.equal(accepted.status, "pending");
});

test("two accounts may each hold one change", async () => {
  const first = await seedMaxAccount();
  const second = await seedMaxAccount();

  await prisma.planChangeRequest.create({ data: reservation(first, "pending") });
  const other = await prisma.planChangeRequest.create({
    data: reservation(second, "pending"),
  });

  assert.equal(other.userId, second);
});

test("a settled reservation frees the account for the next one", async () => {
  const userId = await seedMaxAccount();
  const created = await prisma.planChangeRequest.create({
    data: reservation(userId, "pending"),
  });

  await prisma.planChangeRequest.update({
    where: { id: created.id },
    // Cleared with the status, exactly as the service does it.
    data: { status: "cancelled", pendingForUserId: null, settledAt: new Date() },
  });

  const next = await prisma.planChangeRequest.create({
    data: reservation(userId, "pending"),
  });
  assert.notEqual(next.id, created.id);
});

test("a settled row that keeps the slot locks the account out", async () => {
  // The failure mode of this design, pinned so it cannot be introduced
  // quietly: settling a change without clearing pendingForUserId leaves the
  // account holding a slot it is no longer using, and every later change is
  // refused by the database with nothing in the product to explain it.
  const userId = await seedMaxAccount();
  const created = await prisma.planChangeRequest.create({
    data: reservation(userId, "pending"),
  });

  await prisma.planChangeRequest.update({
    where: { id: created.id },
    data: { status: "applied", settledAt: new Date() },
  });

  await assert.rejects(
    () => prisma.planChangeRequest.create({ data: reservation(userId, "pending") }),
    /Unique constraint|duplicate key/i,
    "status and pendingForUserId must always be written together"
  );
});

test("deleting the account takes its plan change history with it", async () => {
  const userId = await seedMaxAccount();
  await prisma.planChangeRequest.create({ data: reservation(userId, "pending") });

  await prisma.user.delete({ where: { id: userId } });

  const remaining = await prisma.planChangeRequest.count({ where: { userId } });
  assert.equal(remaining, 0);
});
