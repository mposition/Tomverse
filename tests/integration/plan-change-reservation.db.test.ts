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
// The guarantee therefore lives in the schema: a partial unique index over
// PlanChangeRequest(userId) WHERE status = 'pending'. Partial indexes are not
// expressible in schema.prisma, so this is the only place the constraint is
// proven to exist.

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

const reservation = (
  userId: string,
  status: string,
  overrides: Record<string, unknown> = {}
) => ({
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
  // The index is partial on purpose: history has to accumulate. An account that
  // downgraded, changed its mind, and upgraded again would otherwise be locked
  // out by its own past.
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
    data: { status: "cancelled", settledAt: new Date() },
  });

  const next = await prisma.planChangeRequest.create({
    data: reservation(userId, "pending"),
  });
  assert.notEqual(next.id, created.id);
});

test("deleting the account takes its plan change history with it", async () => {
  const userId = await seedMaxAccount();
  await prisma.planChangeRequest.create({ data: reservation(userId, "pending") });

  await prisma.user.delete({ where: { id: userId } });

  const remaining = await prisma.planChangeRequest.count({ where: { userId } });
  assert.equal(remaining, 0);
});
