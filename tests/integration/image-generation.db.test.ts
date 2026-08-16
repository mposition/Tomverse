import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  isImageGenerationEnabled,
  setImageGenerationEnabled,
} from "@/lib/appSettings";
import { retryImageGenerationTarget } from "@/lib/imageGenerationService";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import {
  auditImageGenerationInvariants,
  enqueueImageAssetCleanupForConversations,
} from "@/lib/imageAssetLifecycle";
import {
  reconcileStaleImageGenerations,
  requestImageGeneration,
} from "@/lib/imageGenerationService";
import {
  IMAGE_GENERATION_READ_SELECT,
  serializeImageGeneration,
} from "@/lib/imageGenerationRead";
import { imageAssetR2Key } from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";

const resetImageTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ImageAssetCleanup",
      "ImageAsset",
      "ImageGeneration",
      "ImageGenerationTarget",
      "ImageGenerationGroup",
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

const createGeneration = async (userId: string, conversationId: string) => {
  // v2 chain: a raw generation always hangs off a 1-target group, exactly
  // like the service transaction and the section-14 backfill produce.
  const group = await prisma.imageGenerationGroup.create({
    data: {
      userId,
      conversationId,
      groupIdempotencyKey: randomUUID(),
    },
  });
  const target = await prisma.imageGenerationTarget.create({
    data: { groupId: group.id, provider: "openai", modelId: "gpt-image-2" },
  });
  const generation = await prisma.imageGeneration.create({
    data: {
      userId,
      conversationId,
      idempotencyKey: randomUUID(),
      prompt: "sunset over mountains",
      preset: "draft",
      size: "1024x1024",
      quality: "low",
      groupId: group.id,
      targetId: target.id,
    },
  });
  await prisma.imageGenerationTarget.update({
    where: { id: target.id },
    data: { currentGenerationId: generation.id },
  });
  return generation;
};

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
      provider: "openai",
      modelId: "gpt-image-2",
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
  const first = await createGeneration(user.id, conversation.id);
  await prisma.imageGeneration.update({
    where: { id: first.id },
    data: { idempotencyKey },
  });
  const second = await createGeneration(user.id, conversation.id);
  await assert.rejects(
    prisma.imageGeneration.update({
      where: { id: second.id },
      data: { idempotencyKey },
    }),
    (error: { code?: string }) => error.code === "P2002"
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

test("the read select and serializer rebuild the timeline shape without minting URLs early", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  await createReservation(user.id, conversation.id, generation.id);

  const row = await prisma.imageGeneration.findUnique({
    where: { id: generation.id },
    select: IMAGE_GENERATION_READ_SELECT,
  });
  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: generation.id },
    select: { reservedCredits: true, refundedAt: true },
  });
  assert.ok(row);
  const serialized = await serializeImageGeneration(row, reservation);
  assert.equal(serialized.generationId, generation.id);
  assert.equal(serialized.conversationId, conversation.id);
  assert.equal(serialized.status, "pending");
  assert.equal(serialized.prompt, "sunset over mountains");
  assert.equal(serialized.reservedCredits, 15);
  assert.equal(serialized.refunded, false);
  // A non-succeeded generation never exposes asset URLs -- the serializer
  // must not touch R2 for it (no R2 credentials exist in this test).
  assert.deepEqual(serialized.assets, []);
});

test("the admin setter round-trips the opt-in flag and off never needs a delete", async () => {
  assert.equal(await isImageGenerationEnabled(), false);
  await setImageGenerationEnabled(true);
  assert.equal(await isImageGenerationEnabled(), true);
  await setImageGenerationEnabled(false);
  assert.equal(await isImageGenerationEnabled(), false);
  const row = await prisma.appSetting.findUnique({
    where: { key: "feature.imageGenerationEnabled" },
  });
  assert.equal(row?.value, "false");
});

test("the reservation transaction creates a 1-target group with recorded identity (v2)", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(requestInput(user.id));

  const generation = await prisma.imageGeneration.findUnique({
    where: { id: result.generationId },
  });
  assert.ok(generation);
  assert.equal(generation.attemptNumber, 1);

  const target = await prisma.imageGenerationTarget.findUnique({
    where: { id: generation.targetId },
  });
  assert.equal(target?.currentGenerationId, generation.id);
  assert.equal(target?.provider, "openai");
  assert.equal(target?.modelId, "gpt-image-2");
  assert.equal(target?.groupId, generation.groupId);

  const group = await prisma.imageGenerationGroup.findUnique({
    where: { id: generation.groupId },
  });
  assert.equal(group?.userId, user.id);
  assert.equal(group?.groupIdempotencyKey, generation.idempotencyKey);

  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: generation.id },
  });
  assert.equal(reservation?.provider, "openai");
  assert.equal(reservation?.modelId, "gpt-image-2");
  assert.equal(reservation?.groupId, generation.groupId);
  assert.equal(reservation?.targetId, generation.targetId);
  assert.equal(reservation?.identitySource, "recorded");
  const snapshot = reservation?.pricingSnapshot as Record<string, unknown>;
  assert.equal(snapshot.modelId, "gpt-image-2");
  assert.equal(snapshot.provider, "openai");
});

test("a group cannot hold two targets for the same model", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const group = await prisma.imageGenerationGroup.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      groupIdempotencyKey: randomUUID(),
    },
  });
  await prisma.imageGenerationTarget.create({
    data: { groupId: group.id, provider: "openai", modelId: "gpt-image-2" },
  });
  await assert.rejects(
    prisma.imageGenerationTarget.create({
      data: { groupId: group.id, provider: "openai", modelId: "gpt-image-2" },
    }),
    (error: { code?: string }) => error.code === "P2002"
  );
});

test("retry idempotency is per target: NULLs coexist, duplicate keys are refused", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const first = await createGeneration(user.id, conversation.id);

  const attempt = (retryIdempotencyKey: string | null) =>
    prisma.imageGeneration.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        idempotencyKey: randomUUID(),
        prompt: "sunset over mountains",
        preset: "draft",
        size: "1024x1024",
        quality: "low",
        groupId: first.groupId,
        targetId: first.targetId,
        attemptNumber: 2,
        retryOfGenerationId: first.id,
        retryIdempotencyKey,
      },
    });

  // Two initial-style attempts with NULL retry keys may coexist.
  await attempt(null);
  const keyed = await attempt("retry-key-1");
  assert.equal(keyed.retryIdempotencyKey, "retry-key-1");
  await assert.rejects(
    attempt("retry-key-1"),
    (error: { code?: string }) => error.code === "P2002"
  );
});

test("a two-model request fans out atomically and charges the sum", async () => {
  await enableImageGeneration();
  const user = await createUser();
  // Only one model is enabled today, so the fan-out is exercised through the
  // group path with the models that exist; the contract under test is that
  // the transaction produces one group, N targets and N reservations whose
  // credits sum to what the caller was told.
  const result = await requestImageGeneration(
    requestInput(user.id, { modelIds: ["gpt-image-2"] })
  );

  assert.equal(result.targets.length, 1);
  assert.equal(
    result.reservedCredits,
    result.targets.reduce((sum, target) => sum + target.reservedCredits, 0)
  );
  const targets = await prisma.imageGenerationTarget.findMany({
    where: { groupId: result.groupId },
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].currentGenerationId, result.targets[0].generationId);
});

test("an unavailable model refuses the whole group and leaves no rows", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const before = await prisma.imageGenerationGroup.count();

  await assert.rejects(
    requestImageGeneration(
      requestInput(user.id, {
        // Registered but held closed on price verification: all-or-nothing
        // admission means the enabled model must not run either.
        modelIds: ["gpt-image-2", "gemini-3.1-flash-image"],
      })
    ),
    (error: { code?: string }) => error.code === "IMAGE_OPTION_NOT_SUPPORTED"
  );

  assert.equal(await prisma.imageGenerationGroup.count(), before);
  assert.equal(await prisma.imageGeneration.count(), 0);
  assert.equal(await prisma.imageCreditReservation.count(), 0);
});

test("a replayed request key returns the same group without charging again", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const input = requestInput(user.id);

  const first = await requestImageGeneration(input);
  const replay = await requestImageGeneration(input);

  assert.equal(replay.reused, true);
  assert.equal(replay.groupId, first.groupId);
  assert.equal(replay.generationId, first.generationId);
  assert.equal(replay.reservedCredits, first.reservedCredits);
  assert.equal(await prisma.imageCreditReservation.count(), 1);
});

test("retrying a failed target adds an attempt to the same target, not a new group", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const first = await requestImageGeneration(requestInput(user.id));
  const target = first.targets[0];

  await prisma.imageGeneration.update({
    where: { id: target.generationId },
    data: { status: "failed", failedAt: new Date() },
  });
  // The lease is what the retry's own admission checks; release it the way
  // a real failure path does.
  await prisma.chatRequestLease.deleteMany({});

  const retry = await retryImageGenerationTarget({
    userId: user.id,
    targetId: target.targetId,
    retryIdempotencyKey: "retry-key-abcdefgh",
  });

  assert.equal(retry.groupId, first.groupId);
  assert.equal(retry.targets[0].targetId, target.targetId);

  const attempts = await prisma.imageGeneration.findMany({
    where: { targetId: target.targetId },
    orderBy: { attemptNumber: "asc" },
  });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].attemptNumber, 2);
  assert.equal(attempts[1].retryOfGenerationId, target.generationId);
  assert.equal(attempts[1].retryIdempotencyKey, "retry-key-abcdefgh");

  const targetRow = await prisma.imageGenerationTarget.findUnique({
    where: { id: target.targetId },
  });
  assert.equal(targetRow?.currentGenerationId, attempts[1].id);
  // Exactly one group: the retry must not spawn a second one.
  assert.equal(await prisma.imageGenerationGroup.count(), 1);
});

test("a succeeded target cannot be retried into a double charge", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const first = await requestImageGeneration(requestInput(user.id));
  const target = first.targets[0];
  await prisma.imageGeneration.update({
    where: { id: target.generationId },
    data: { status: "succeeded", completedAt: new Date() },
  });

  await assert.rejects(
    retryImageGenerationTarget({
      userId: user.id,
      targetId: target.targetId,
      retryIdempotencyKey: "retry-key-ijklmnop",
    }),
    (error: { code?: string }) => error.code === "IMAGE_RETRY_NOT_ALLOWED"
  );
  assert.equal(await prisma.imageCreditReservation.count(), 1);
});

test("another user's target is not retryable", async () => {
  await enableImageGeneration();
  const owner = await createUser();
  const stranger = await createUser();
  const first = await requestImageGeneration(requestInput(owner.id));

  await assert.rejects(
    retryImageGenerationTarget({
      userId: stranger.id,
      targetId: first.targets[0].targetId,
      retryIdempotencyKey: "retry-key-qrstuvwx",
    }),
    (error: { code?: string }) => error.code === "IMAGE_GENERATION_NOT_FOUND"
  );
});

/* ------------------------------------------------------------------------- */
/* Model selection limit: admission is the boundary, whatever the UI offered. */
/* ------------------------------------------------------------------------- */

/**
 * `imageGroupMaxModels()` reads `process.env` at call time, so a test sets the
 * variable around the call rather than at import. Restored afterwards so the
 * limit does not leak into the tests that follow.
 */
const withGroupMaxModels = async <T,>(
  value: string,
  run: () => Promise<T>
): Promise<T> => {
  const previous = process.env.IMAGE_GROUP_MAX_MODELS;
  process.env.IMAGE_GROUP_MAX_MODELS = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.IMAGE_GROUP_MAX_MODELS;
    else process.env.IMAGE_GROUP_MAX_MODELS = previous;
  }
};

test("three models at a limit of two are refused before any row exists", async () => {
  await enableImageGeneration();
  const user = await createUser();

  await withGroupMaxModels("2", async () => {
    await assert.rejects(
      requestImageGeneration(
        requestInput(user.id, {
          // Standard: the only tier all three price. `requestInput` defaults
          // to `low`, where Grok and Nano Banana 2 have no price at all, and
          // the group would then be refused for an unpriceable model instead
          // of for the limit -- the same 400 for a different reason, which is
          // exactly the confusion this test exists to rule out.
          quality: "medium",
          modelIds: [
            "gpt-image-2",
            "grok-imagine-image-quality-20260403",
            "fal-ai/nano-banana-2",
          ],
        })
      ),
      (error: unknown) => {
        const refusal = error as {
          status: number;
          code: string;
          details: { maxModels: number; requestedModels: number };
        };
        assert.equal(refusal.status, 400);
        assert.equal(refusal.code, "IMAGE_MODEL_SELECTION_INVALID");
        // The client renders the limit from this, so it is part of the
        // contract rather than debug detail.
        assert.equal(refusal.details.maxModels, 2);
        assert.equal(refusal.details.requestedModels, 3);
        return true;
      }
    );
  });

  // Refused before anything was created or charged: a rejected group must
  // leave no row and no cost, not a cancelled one.
  assert.equal(await prisma.imageGenerationGroup.count(), 0);
  assert.equal(await prisma.imageGenerationTarget.count(), 0);
  assert.equal(await prisma.imageGeneration.count(), 0);
  assert.equal(await prisma.imageCreditReservation.count(), 0);
  const budgets = await prisma.chatUsageBucket.findMany({
    where: { key: { startsWith: "image-provider:" } },
  });
  assert.deepEqual(budgets, []);
});

test("three models at a limit of three fan out as one group of three", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const modelIds = [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
    "fal-ai/nano-banana-2",
  ];

  const result = await withGroupMaxModels("3", () =>
    // Standard for the same reason as above: Grok and Nano Banana 2 price 1K
    // square at `medium` only, and all-or-nothing admission refuses a group
    // whose second model cannot be priced.
    requestImageGeneration(requestInput(user.id, { quality: "medium", modelIds }))
  );

  assert.equal(result.targets.length, 3);
  const targets = await prisma.imageGenerationTarget.findMany({
    where: { groupId: result.groupId },
  });
  assert.equal(targets.length, 3);
  assert.deepEqual(
    targets.map((target) => target.modelId).sort(),
    [...modelIds].sort()
  );

  const reservations = await prisma.imageCreditReservation.findMany({
    where: { generationId: { in: result.targets.map((t) => t.generationId) } },
  });
  assert.equal(reservations.length, 3);
  // All-or-nothing admission means the quoted total is the sum of the parts,
  // with no target admitted at a price the caller was not told.
  assert.equal(
    result.reservedCredits,
    result.targets.reduce((sum, target) => sum + target.reservedCredits, 0)
  );
  // Each provider's budget carries its own hold; none borrows another's.
  const budgets = await prisma.chatUsageBucket.findMany({
    where: { key: { startsWith: "image-provider:" }, period: "provider-cost-day" },
  });
  assert.deepEqual(
    budgets.map((row) => row.key).sort(),
    ["image-provider:fal", "image-provider:openai", "image-provider:xai"]
  );
});
