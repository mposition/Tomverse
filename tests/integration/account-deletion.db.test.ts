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
    TRUNCATE TABLE "Session", "ImageAssetCleanup", "User" RESTART IDENTITY CASCADE
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

// The notice that goes with the scheduling above. It says an account and
// everything in it will be destroyed on a date, and until EM-12 it said so in
// English to every account, whichever language they had chosen. The scheduler
// is what has to carry the language: the template gained seven, but a caller
// that does not pass one leaves the lane defaulting to English and the
// translations unreachable.
test("scheduling returns the account's own language for the notice", async () => {
  const user = await createUser({});
  await prisma.userSettings.create({
    data: { userId: user.id, language: "ko" },
  });

  const result = await scheduleTomverseAccountDeletion(user.id);

  assert.equal(result.scheduled, true);
  assert.equal(result.scheduled === true ? result.language : null, "ko");
});

test("an account with no settings row yields no language rather than throwing", async () => {
  const user = await createUser({});

  const result = await scheduleTomverseAccountDeletion(user.id);

  assert.equal(result.scheduled, true);
  // Null, not "en": the lane decides what an absent language means, and it is
  // the one place that decision belongs.
  assert.equal(result.scheduled === true ? result.language : "unset", null);
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

test("permanent deletion cascades imported external conversations (import policy §13.1)", async () => {
  // deleteTomverseAccount ends in tx.user.delete, so the External* tables ride
  // on the DB-level onDelete: Cascade chain (User -> ExternalImport ->
  // ExternalConversation -> ExternalMessage). This pins that contract: a
  // future refactor to explicit per-table deleteMany calls must include the
  // import tables or fail here, not strand a deleted user's imported data.
  const user = await createUser({
    accountStatus: "pending_deletion",
    stripeSubscriptionId: null,
  });
  const importRow = await prisma.externalImport.create({
    data: {
      userId: user.id,
      provider: "chatgpt",
      status: "completed",
      parserVersion: "test-1",
      digestVersion: 1,
    },
  });
  const conversation = await prisma.externalConversation.create({
    data: {
      userId: user.id,
      importId: importRow.id,
      provider: "chatgpt",
      externalStableId: "a".repeat(64),
      title: "cascade fixture",
      conversationDigest: "b".repeat(64),
      digestVersion: 1,
      messageCount: 1,
      contentBytes: BigInt(5),
      finalized: true,
    },
  });
  await prisma.externalMessage.create({
    data: {
      userId: user.id,
      externalConversationId: conversation.id,
      externalStableId: "c".repeat(64),
      role: "user",
      content: "hello",
      contentDigest: "d".repeat(64),
      digestVersion: 1,
      ordinal: 0,
    },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { accountDeletionScheduledFor: new Date(Date.now() - 1_000) },
  });

  const deletedCount = await deleteScheduledAccounts(new Date());

  assert.equal(deletedCount, 1);
  assert.equal(
    await prisma.externalImport.count({ where: { userId: user.id } }),
    0
  );
  assert.equal(
    await prisma.externalConversation.count({ where: { userId: user.id } }),
    0
  );
  assert.equal(
    await prisma.externalMessage.count({ where: { userId: user.id } }),
    0
  );
});

test("permanent deletion enqueues the account's generated images for storage removal", async () => {
  // Deleting one conversation already enqueued its images; deleting the
  // account did not. The cascade runs User -> Conversation -> ImageGeneration
  // -> ImageAsset, and ImageAsset holds the only record of the R2 key, so once
  // it is gone the object has no name anywhere in the system and no sweep can
  // ever find it. The tombstone therefore has to be written before the
  // cascade, in the same transaction -- which is what this pins.
  const user = await createUser({
    accountStatus: "pending_deletion",
    stripeSubscriptionId: null,
  });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, title: "a picture", kind: "image", selectedModels: "[]" },
  });
  const group = await prisma.imageGenerationGroup.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      groupIdempotencyKey: randomUUID(),
    },
  });
  const target = await prisma.imageGenerationTarget.create({
    data: { groupId: group.id, provider: "openai", modelId: "gpt-image-2" },
  });
  const generation = await prisma.imageGeneration.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      idempotencyKey: randomUUID(),
      prompt: "a lighthouse at dusk",
      preset: "draft",
      size: "1024x1024",
      quality: "low",
      groupId: group.id,
      targetId: target.id,
    },
  });
  const r2Key = `images/${conversation.id}/${randomUUID()}.png`;
  await prisma.imageAsset.create({
    data: {
      generationId: generation.id,
      role: "original",
      status: "ready",
      r2Key,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      byteSize: 1_000,
      sha256: "a".repeat(64),
    },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { accountDeletionScheduledFor: new Date(Date.now() - 1_000) },
  });

  assert.equal(await deleteScheduledAccounts(new Date()), 1);

  // The row that named the object is gone with the account...
  assert.equal(await prisma.imageAsset.count({ where: { r2Key } }), 0);
  // ...so the tombstone is the only thing that can still reach the object.
  const tombstone = await prisma.imageAssetCleanup.findUnique({ where: { r2Key } });
  assert.ok(tombstone, "the account's image was not enqueued for storage removal");
  // Named as an account deletion rather than a conversation deletion: the two
  // are different operator-facing facts, and `account_deleted` had been a
  // declared cleanup reason that nothing ever wrote.
  assert.equal(tombstone.reason, "account_deleted");
  assert.equal(tombstone.completedAt, null);
});

test("deleting an account with no generated images enqueues nothing", async () => {
  const user = await createUser({
    accountStatus: "pending_deletion",
    stripeSubscriptionId: null,
  });
  await prisma.conversation.create({
    data: { userId: user.id, title: "just chat", selectedModels: "[]" },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { accountDeletionScheduledFor: new Date(Date.now() - 1_000) },
  });

  assert.equal(await deleteScheduledAccounts(new Date()), 1);
  assert.equal(await prisma.imageAssetCleanup.count(), 0);
});
