import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { getUserChatUsageKey } from "@/lib/chatSecurity";
import {
  auditImageGenerationInvariants,
  enqueueImageAssetCleanupForConversations,
} from "@/lib/imageAssetLifecycle";
import {
  reconcileStaleImageGenerations,
  requestImageGeneration,
} from "@/lib/imageGenerationService";
import { imageAssetR2Key } from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";

const resetImageTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ImageAssetCleanup",
      "ImageAsset",
      "ImageGeneration",
      "ImageCreditReservation",
      "ChatUsageBucket",
      "ChatRequestLease",
      "CreditLedgerEntry",
      "CreditLot",
      "AppSetting",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetImageTestData);
after(async () => {
  await resetImageTestData();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@image-test.local`, plan: "Pro" },
  });

const createImageConversation = (userId: string) =>
  prisma.conversation.create({
    data: {
      userId,
      title: "sunset over mountains",
      kind: "image",
      selectedModels: "[]",
    },
  });

const createGeneration = (userId: string, conversationId: string) =>
  prisma.imageGeneration.create({
    data: {
      userId,
      conversationId,
      idempotencyKey: randomUUID(),
      prompt: "sunset over mountains",
      preset: "draft",
      size: "1024x1024",
      quality: "low",
    },
  });

const createReservation = (
  userId: string,
  conversationId: string,
  generationId: string
) =>
  prisma.imageCreditReservation.create({
    data: {
      id: `image-credit-reservation:${generationId}:v1`,
      userId,
      generationId,
      conversationId,
      preset: "draft",
      quality: "low",
      size: "1024x1024",
      reservedCredits: 15,
      planReservedCredits: 15,
      addOnReservedCredits: 0,
      reservedCostMicroUsd: BigInt(11_000),
      pricingVersion: "2026-08-03-v1",
      costSource: "fixed_estimate",
      pricingSnapshot: { credits: 15 },
      reservationPayload: [],
    },
  });

test("existing conversations default to kind chat", async () => {
  const user = await createUser();
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, title: "plain chat" },
  });
  assert.equal(conversation.kind, "chat");
});

test("conversation deletion enqueues R2 tombstones, cascades rows, and preserves the financial record", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  await createReservation(user.id, conversation.id, generation.id);
  const originalKey = imageAssetR2Key({
    userId: user.id,
    conversationId: conversation.id,
    generationId: generation.id,
    role: "original",
  });
  await prisma.imageAsset.create({
    data: {
      generationId: generation.id,
      role: "original",
      status: "ready",
      r2Key: originalKey,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      byteSize: 1_000_000,
      sha256: "a".repeat(64),
    },
  });

  // The same shape the delete route uses: enqueue and delete atomically.
  await prisma.$transaction(async (tx) => {
    const enqueued = await enqueueImageAssetCleanupForConversations(tx, [
      conversation.id,
    ]);
    assert.equal(enqueued, 1);
    await tx.conversation.delete({ where: { id: conversation.id } });
  });

  assert.equal(await prisma.imageGeneration.count(), 0);
  assert.equal(await prisma.imageAsset.count(), 0);
  const cleanup = await prisma.imageAssetCleanup.findUnique({
    where: { r2Key: originalKey },
  });
  assert.ok(cleanup, "tombstone row must exist before any R2 delete runs");
  assert.equal(cleanup.completedAt, null);

  // The audit trail of what was charged outlives the conversation.
  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: generation.id },
  });
  assert.ok(reservation);
  assert.equal(reservation.reservedCredits, 15);
});

test("re-deleting the same keys does not violate the tombstone unique constraint", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  const key = imageAssetR2Key({
    userId: user.id,
    conversationId: conversation.id,
    generationId: generation.id,
    role: "original",
  });
  await prisma.imageAsset.create({
    data: {
      generationId: generation.id,
      role: "original",
      r2Key: key,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      byteSize: 1,
      sha256: "b".repeat(64),
    },
  });
  await prisma.$transaction(async (tx) => {
    await enqueueImageAssetCleanupForConversations(tx, [conversation.id]);
    await enqueueImageAssetCleanupForConversations(tx, [conversation.id]);
  });
  assert.equal(await prisma.imageAssetCleanup.count(), 1);
});

test("user deletion detaches the financial record instead of destroying it", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  await createReservation(user.id, conversation.id, generation.id);

  await prisma.user.delete({ where: { id: user.id } });

  assert.equal(await prisma.imageGeneration.count(), 0);
  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: generation.id },
  });
  assert.ok(reservation, "reservation must survive account deletion");
  assert.equal(reservation.userId, null);
});

test("duplicate (userId, idempotencyKey) is rejected", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const idempotencyKey = randomUUID();
  await prisma.imageGeneration.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      idempotencyKey,
      prompt: "p",
      preset: "draft",
      size: "1024x1024",
      quality: "low",
    },
  });
  await assert.rejects(
    prisma.imageGeneration.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        idempotencyKey,
        prompt: "p",
        preset: "draft",
        size: "1024x1024",
        quality: "low",
      },
    })
  );
});

test("settling claim is exactly-once: the second conditional update sees zero rows", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  await prisma.imageGeneration.update({
    where: { id: generation.id },
    data: { status: "processing" },
  });

  const first = await prisma.imageGeneration.updateMany({
    where: { id: generation.id, status: { in: ["pending", "processing"] } },
    data: { status: "settling" },
  });
  const second = await prisma.imageGeneration.updateMany({
    where: { id: generation.id, status: { in: ["pending", "processing"] } },
    data: { status: "settling" },
  });
  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
});

test("invariant audit counts an image conversation without generations", async () => {
  const user = await createUser();
  // Created outside the reservation transaction on purpose: this is the
  // state the audit exists to catch.
  await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "empty image conversation",
      kind: "image",
      selectedModels: "[]",
    },
  });
  const healthy = await createImageConversation(user.id);
  await createGeneration(user.id, healthy.id);

  const result = await auditImageGenerationInvariants();
  assert.equal(result.emptyImageConversations, 1);
  assert.equal(result.staleGenerations, 0);
});

test("stale generation audit uses the stale window, not mere age", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  // Fresh pending row: not stale.
  let result = await auditImageGenerationInvariants();
  assert.equal(result.staleGenerations, 0);
  // Same row observed from one hour in the future: stale.
  result = await auditImageGenerationInvariants(
    new Date(Date.now() + 60 * 60 * 1_000)
  );
  assert.equal(result.staleGenerations, 1);
  assert.ok(generation.id);
});

/* ------------------------------------------------------------------------- */
/* Billing path: reservation, empty-work invariant, idempotency, refund.     */
/* ------------------------------------------------------------------------- */

const enableImageGeneration = () =>
  prisma.appSetting.create({
    data: { key: "feature.imageGenerationEnabled", value: "true" },
  });

const requestInput = (userId: string, overrides: Record<string, unknown> = {}) =>
  ({
    userId,
    prompt: "sunset over mountains",
    size: "1024x1024",
    quality: "low",
    conversationId: null,
    idempotencyKey: `key-${randomUUID().slice(0, 20)}`,
    ...overrides,
  }) as Parameters<typeof requestImageGeneration>[0];

test("reservation transaction lazily creates the conversation, charges the wallet, and holds a lease", async () => {
  await enableImageGeneration();
  const user = await createUser();

  const result = await requestImageGeneration(requestInput(user.id));
  assert.equal(result.reused, false);
  assert.equal(result.status, "pending");
  assert.equal(result.reservedCredits, 15);

  const conversation = await prisma.conversation.findUnique({
    where: { id: result.conversationId },
  });
  assert.equal(conversation?.kind, "image");
  assert.equal(conversation?.selectedModels, "[]");
  assert.equal(conversation?.title, "sunset over mountains");

  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: result.generationId },
  });
  assert.equal(reservation?.planReservedCredits, 15);
  assert.equal(reservation?.addOnReservedCredits, 0);
  assert.equal(reservation?.status, "reserved");
  assert.equal(reservation?.pricingVersion.length ? true : false, true);

  const subjectKey = getUserChatUsageKey(user.id);
  const monthBucket = await prisma.chatUsageBucket.findFirst({
    where: { key: subjectKey, period: "month" },
  });
  assert.equal(Number(monthBucket?.count ?? 0), 15);

  const budgetBucket = await prisma.chatUsageBucket.findFirst({
    where: { key: "image-provider:openai", period: "provider-cost-day" },
  });
  assert.equal(Number(budgetBucket?.count ?? 0), 11_000);

  const leases = await prisma.chatRequestLease.count({
    where: { subjectKey: `image:${subjectKey}` },
  });
  assert.equal(leases, 1);
});

test("the same idempotency key replays the winner instead of double-charging", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const input = requestInput(user.id);

  const first = await requestImageGeneration(input);
  const replay = await requestImageGeneration(input);
  assert.equal(replay.reused, true);
  assert.equal(replay.generationId, first.generationId);
  assert.equal(replay.conversationId, first.conversationId);

  assert.equal(await prisma.imageGeneration.count(), 1);
  assert.equal(await prisma.conversation.count(), 1);
  const monthBucket = await prisma.chatUsageBucket.findFirst({
    where: { key: getUserChatUsageKey(user.id), period: "month" },
  });
  assert.equal(Number(monthBucket?.count ?? 0), 15);
});

test("a missing flag row fails closed and leaves no rows", async () => {
  const user = await createUser();
  await assert.rejects(requestImageGeneration(requestInput(user.id)), (error: Error & { code?: string }) => {
    assert.equal(error.code, "IMAGE_GENERATION_DISABLED");
    return true;
  });
  assert.equal(await prisma.conversation.count(), 0);
  assert.equal(await prisma.imageGeneration.count(), 0);
  assert.equal(await prisma.chatUsageBucket.count(), 0);
});

test("a Free plan is refused by the entitlement gate with no rows", async () => {
  await enableImageGeneration();
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@image-test.local`, plan: "Free" },
  });
  await assert.rejects(requestImageGeneration(requestInput(user.id)), (error: Error & { code?: string }) => {
    assert.equal(error.code, "PLAN_FEATURE_NOT_INCLUDED");
    return true;
  });
  assert.equal(await prisma.conversation.count(), 0);
  assert.equal(await prisma.imageGeneration.count(), 0);
});

test("concurrency limit 1: a second request while the lease is live is refused with no rows", async () => {
  await enableImageGeneration();
  const user = await createUser();
  await requestImageGeneration(requestInput(user.id));

  await assert.rejects(
    requestImageGeneration(requestInput(user.id)),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "IMAGE_CONCURRENCY_EXCEEDED");
      assert.ok(typeof error.details?.resetAt === "string");
      return true;
    }
  );
  assert.equal(await prisma.imageGeneration.count(), 1);
  assert.equal(await prisma.conversation.count(), 1);
});

test("insufficient balance is rejected before any row exists", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const subjectKey = getUserChatUsageKey(user.id);
  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
  );
  await prisma.chatUsageBucket.create({
    data: {
      key: subjectKey,
      period: "month",
      periodStart: monthStart,
      count: 2_990,
    },
  });

  await assert.rejects(
    requestImageGeneration(
      requestInput(user.id, { quality: "high", size: "1024x1024" })
    ),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "CREDIT_BALANCE_INSUFFICIENT");
      assert.ok(typeof error.details?.resetAt === "string");
      assert.ok(new Date(String(error.details?.resetAt)).getTime() > Date.now());
      return true;
    }
  );
  assert.equal(await prisma.conversation.count(), 0);
  assert.equal(await prisma.imageGeneration.count(), 0);
});

test("purchased credits carry the request when plan credits are exhausted, and a stale refund restores them", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const subjectKey = getUserChatUsageKey(user.id);
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  // Monthly plan credits fully consumed; the daily bucket never got there,
  // matching a wallet drained earlier in the month.
  await prisma.chatUsageBucket.create({
    data: { key: subjectKey, period: "month", periodStart: monthStart, count: 3_000 },
  });
  await prisma.creditLot.create({
    data: {
      userId: user.id,
      source: "credit_pack",
      originalCredits: 500,
      remainingCredits: 500,
      originalFundedCostMicroUsd: BigInt(750_000),
      remainingFundedCostMicroUsd: BigInt(750_000),
      status: "active",
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    },
  });

  const result = await requestImageGeneration(
    requestInput(user.id, { quality: "high", size: "1024x1024" })
  );
  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: result.generationId },
  });
  assert.equal(reservation?.planReservedCredits, 0);
  assert.equal(reservation?.addOnReservedCredits, 250);
  assert.equal(Number(reservation?.reservedFundedCostMicroUsd ?? 0), 216_000);

  const lotAfterReserve = await prisma.creditLot.findFirst({
    where: { userId: user.id },
  });
  assert.equal(lotAfterReserve?.remainingCredits, 250);

  // The executor dies; one hour later the sweep claims and refunds it.
  const sweep = await reconcileStaleImageGenerations(
    new Date(now.getTime() + 60 * 60 * 1_000)
  );
  assert.equal(sweep.refunded, 1);

  const generation = await prisma.imageGeneration.findUnique({
    where: { id: result.generationId },
  });
  assert.equal(generation?.status, "failed");
  assert.equal(generation?.failurePhase, "stale_job_reconciled");

  const settled = await prisma.imageCreditReservation.findUnique({
    where: { generationId: result.generationId },
  });
  assert.equal(settled?.status, "settled");
  assert.equal(settled?.outcome, "failed");
  assert.ok(settled?.refundedAt);

  const lotAfterRefund = await prisma.creditLot.findFirst({
    where: { userId: user.id },
  });
  assert.equal(lotAfterRefund?.remainingCredits, 500);
  assert.equal(Number(lotAfterRefund?.remainingFundedCostMicroUsd ?? 0), 750_000);

  const leases = await prisma.chatRequestLease.count({
    where: { subjectKey: `image:${subjectKey}` },
  });
  assert.equal(leases, 0);

  // A second sweep finds nothing to refund: the settling claim is
  // exactly-once.
  const secondSweep = await reconcileStaleImageGenerations(
    new Date(now.getTime() + 61 * 60 * 1_000)
  );
  assert.equal(secondSweep.refunded, 0);
});
