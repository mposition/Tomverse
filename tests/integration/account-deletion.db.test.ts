import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  restoreTomverseAccount,
  scheduleTomverseAccountDeletion,
} from "@/lib/accountDeletion";
import { deleteScheduledAccounts } from "@/lib/maintenance";

// Regression coverage for a review that flagged: (1) deletion scheduling used
// to call Stripe's immediate cancel(), which also downgraded the plan and
// wiped subscription fields well before the promised 7-day grace period; (2)
// the maintenance sweep that hard-deletes expired accounts never re-checked
// status right before deleting, so a restore landing between selection and
// deletion could be undone; (3) there was no admin restore action distinct
// from the unrelated "unsuspend"/"restore AI usage" controls. See
// lib/accountDeletion.ts and lib/maintenance.ts for the fix.

const resetAccountDeletionData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "Session", "User" RESTART IDENTITY CASCADE
  `);

beforeEach(resetAccountDeletionData);
after(async () => {
  await resetAccountDeletionData();
  await prisma.$disconnect();
});

// stripeSubscriptionId is intentionally set (non-null) so the DB-side
// bookkeeping in scheduleTomverseAccountDeletion is exercised, but the test
// environment has no STRIPE_SECRET_KEY configured, so the actual Stripe API
// call inside it no-ops (isStripeConfigured() is false) rather than making a
// real network request.
const createUser = async (opts: {
  accountStatus?: string;
  stripeSubscriptionId?: string | null;
  plan?: string;
}) => {
  const email = `${randomUUID()}@example.test`;
  return prisma.user.create({
    data: {
      email,
      accountStatus: opts.accountStatus ?? "active",
      stripeSubscriptionId: opts.stripeSubscriptionId ?? `sub_${randomUUID()}`,
      plan: opts.plan ?? "Pro",
    },
  });
};

test("scheduling a deletion sets pending_deletion and cancel-at-period-end without touching plan or Stripe ids", async () => {
  const user = await createUser({ plan: "Pro" });

  const result = await scheduleTomverseAccountDeletion(user.id);

  assert.equal(result.scheduled, true);
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.accountStatus, "pending_deletion");
  assert.equal(reloaded.subscriptionCancelAtPeriodEnd, true);
  assert.ok(reloaded.accountDeletionScheduledFor);
  // Plan/subscription identifiers must survive the scheduling step itself --
  // an immediate stripe.subscriptions.cancel() used to trigger a webhook
  // that wiped these before the 7-day grace period even started.
  assert.equal(reloaded.plan, "Pro");
  assert.ok(reloaded.stripeSubscriptionId);
  assert.equal(reloaded.aiUsageRestricted, true);
});

test("restoring a pending-deletion account reactivates it and clears the AI restriction", async () => {
  const user = await createUser({ accountStatus: "pending_deletion", plan: "Pro" });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      accountDeletionRequestedAt: new Date(),
      accountDeletionScheduledFor: new Date(Date.now() + 86_400_000),
      aiUsageRestricted: true,
      aiUsageRestrictionReason: "Account deletion is scheduled.",
    },
  });

  const outcome = await restoreTomverseAccount(user.id);

  assert.equal(outcome, "restored");
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.accountStatus, "active");
  assert.equal(reloaded.accountDeletionRequestedAt, null);
  assert.equal(reloaded.accountDeletionScheduledFor, null);
  assert.equal(reloaded.aiUsageRestricted, false);
  assert.equal(reloaded.aiUsageRestrictionReason, null);
  // The plan itself was never touched by scheduling, so it should still be
  // exactly what it was -- no separate "restore the plan" step needed.
  assert.equal(reloaded.plan, "Pro");
});

test("restoring an already-active account is an idempotent no-op", async () => {
  const user = await createUser({ accountStatus: "active" });

  const outcome = await restoreTomverseAccount(user.id);

  assert.equal(outcome, "already_active");
});

test("restoring an account whose permanent deletion has already started is blocked", async () => {
  const user = await createUser({ accountStatus: "deletion_processing" });

  const outcome = await restoreTomverseAccount(user.id);

  assert.equal(outcome, "deletion_in_progress");
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.accountStatus, "deletion_processing");
});

test("the maintenance sweep does not delete an account restored after selection", async () => {
  const user = await createUser({ accountStatus: "pending_deletion" });
  await prisma.user.update({
    where: { id: user.id },
    data: { accountDeletionScheduledFor: new Date(Date.now() - 1_000) },
  });

  // Simulates a restore landing between the sweep's findMany selection and
  // its claim: by the time the sweep tries to claim this row, it is no
  // longer pending_deletion.
  await restoreTomverseAccount(user.id);

  const deletedCount = await deleteScheduledAccounts(new Date());

  assert.equal(deletedCount, 0);
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reloaded.accountStatus, "active");
});

test("the maintenance sweep claims and deletes an account whose grace period has elapsed", async () => {
  const user = await createUser({ accountStatus: "pending_deletion", stripeSubscriptionId: null });
  await prisma.user.update({
    where: { id: user.id },
    data: { accountDeletionScheduledFor: new Date(Date.now() - 1_000) },
  });

  const deletedCount = await deleteScheduledAccounts(new Date());

  assert.equal(deletedCount, 1);
  const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(reloaded, null);
});
