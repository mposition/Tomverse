import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";

import {
  isImageGenerationEnabled,
  setImageGenerationEnabled,
} from "@/lib/appSettings";
import { retryImageGenerationTarget } from "@/lib/imageGenerationService";
import { startChatImageTurn } from "@/lib/chatImageTurn";
import { attachChatImageTurns } from "@/lib/chatImageTurnRead";
import { readPreviousImagePrompt } from "@/lib/chatImageIntent";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import {
  auditImageGenerationInvariants,
  enqueueImageAssetCleanupForConversations,
} from "@/lib/imageAssetLifecycle";
import {
  processImageGeneration,
  reconcileStaleImageGenerations,
  requestImageGeneration,
} from "@/lib/imageGenerationService";
import {
  IMAGE_GENERATION_READ_SELECT,
  serializeImageGeneration,
} from "@/lib/imageGenerationRead";
import {
  imageAssetR2Key,
  IMAGE_PENDING_REDRIVE_MAX_PER_SWEEP,
} from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { accountAttachmentPrefix, MessageAttachmentBindError } from "@/lib/messageAttachmentStorage";
import { STUDIO_RUN_CONVERSATION } from "@/lib/conversationProduct";
import { bindStudioImageUpload, recordStudioRequest } from "@/lib/studioImageReference";

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
    data: { selectedModels: '["gpt-6-luna"]', userId: user.id, title: "plain chat" },
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

test("a reservation whose generation is gone is orphaned, with what it holds", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  await createReservation(user.id, conversation.id, generation.id);

  // While the generation row exists the stale sweep can still reach this
  // reservation, so it is not yet the state being counted.
  let result = await auditImageGenerationInvariants();
  assert.equal(result.orphanedReservations, 0);
  assert.equal(result.orphanedReservationCostMicroUsd, 0);

  // Deleting the conversation cascades the generation away. The reservation
  // survives by design -- it has no foreign key to anything it describes --
  // and that is exactly why nothing could see its hold on the provider budget
  // before this count.
  await prisma.conversation.delete({ where: { id: conversation.id } });

  result = await auditImageGenerationInvariants();
  assert.equal(result.orphanedReservations, 1);
  assert.equal(result.orphanedReservationCostMicroUsd, 11_000);
  // None of the older counts sees it: every one of them reads a row the
  // cascade just removed.
  assert.equal(result.staleGenerations, 0);
  assert.equal(result.emptyImageConversations, 0);
});

test("a settled reservation is not orphaned when its generation is gone", async () => {
  const user = await createUser();
  const conversation = await createImageConversation(user.id);
  const generation = await createGeneration(user.id, conversation.id);
  await createReservation(user.id, conversation.id, generation.id);
  await prisma.imageCreditReservation.update({
    where: { generationId: generation.id },
    data: {
      status: "settled",
      settledCredits: 15,
      settledCostMicroUsd: BigInt(9_000),
      settledAt: new Date(),
    },
  });

  await prisma.conversation.delete({ where: { id: conversation.id } });

  // Its money is already accounted for, so the missing generation is
  // retention doing its job rather than a reservation nobody can resolve.
  const result = await auditImageGenerationInvariants();
  assert.equal(result.orphanedReservations, 0);
  assert.equal(result.orphanedReservationCostMicroUsd, 0);
});

/* ------------------------------------------------------------------------- */
/* Billing path: reservation, empty-work invariant, idempotency, refund.     */
/* ------------------------------------------------------------------------- */

const enableImageGeneration = () =>
  prisma.appSetting.create({
    data: { key: "feature.imageGenerationEnabled", value: "true" },
  });

/**
 * A single-model OpenAI Draft request.
 *
 * Named for what it is rather than for what it looks like: the defaults below
 * are a fixture -- `quality: "low"`, one OpenAI target, 15 credits, an 11,000
 * microUSD hold -- and several tests assert those exact numbers, so they are a
 * contract this helper carries rather than incidental values.
 *
 * **A multi-model test must state its own `quality` and `size`.** Two of the
 * three active models sell 1K square at Standard only, so a comparison that
 * inherits `low` is refused for an unpriceable model rather than for whatever
 * it meant to test. Raising the default to `medium` would break the Draft
 * assertions and would not stay safe: the tiers three models happen to share
 * today is a coincidence, not a rule the next model has to honour.
 *
 * The intended split is `openAiDraftRequestInput()` for the Draft-pricing
 * tests and a `comparisonRequestInput()` that takes `modelIds`, `quality` and
 * `size` as required arguments, with a real `Partial<>` of the request type in
 * place of the `Record<string, unknown>` cast below. Left as its own change so
 * this one does not move assertions while it moves fixtures.
 */
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

test("a Studio run is left out of the conversation list, and image and chat conversations stay in it", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const listed = async () => (await prisma.conversation.findMany({
    where: { userId: user.id, NOT: STUDIO_RUN_CONVERSATION }, select: { id: true }, orderBy: { createdAt: "asc" },
  })).map(row => row.id);

  // The image workspace: prompts live on the generation rows, so the conversation has no message.
  const workspace = await requestImageGeneration(requestInput(user.id));
  await prisma.chatRequestLease.deleteMany({});
  // A Studio tool without a photo records its request in the same transaction as the reservation.
  const run = await requestImageGeneration({
    ...requestInput(user.id, { prompt: "Design a poster" }),
    onReserved: (tx, conversationId) => recordStudioRequest(tx, conversationId, "Design a poster"),
  });
  await prisma.chatRequestLease.deleteMany({});
  assert.notEqual(run.conversationId, workspace.conversationId);
  assert.deepEqual(
    await prisma.message.findMany({ where: { conversationId: run.conversationId }, select: { role: true, content: true } }),
    [{ role: "user", content: "Design a poster" }],
  );
  const chat = await prisma.conversation.create({
    data: { userId: user.id, title: "A chat", kind: "chat", selectedModels: "[]", messages: { create: { role: "user", content: "Hello" } } },
  });
  assert.deepEqual(await listed(), [workspace.conversationId, chat.id]);

  // A request that cannot be recorded reserves nothing and leaves no conversation behind.
  const before = await Promise.all([prisma.conversation.count(), prisma.imageGenerationGroup.count(), prisma.imageCreditReservation.count()]);
  await assert.rejects(requestImageGeneration({
    ...requestInput(user.id), onReserved: async () => { throw new Error("request not recorded"); },
  }), /request not recorded/);
  assert.deepEqual(await Promise.all([prisma.conversation.count(), prisma.imageGenerationGroup.count(), prisma.imageCreditReservation.count()]), before);
});

test("Studio edit reservations roll back on foreign or already bound uploads and replay once", async t => {
  const prior = process.env.IMAGE_EDIT_ENABLED;
  process.env.IMAGE_EDIT_ENABLED = "true";
  t.after(() => {
    if (prior === undefined) delete process.env.IMAGE_EDIT_ENABLED;
    else process.env.IMAGE_EDIT_ENABLED = prior;
  });
  await enableImageGeneration();
  const owner = await createUser();
  const other = await createUser();
  const createUpload = (user: typeof owner) => prisma.messageAttachmentUpload.create({
    data: {
      userId: user.id, objectKey: accountAttachmentPrefix(user.email!) + "studio/" + randomUUID(),
      name: "reference.png", mediaType: "image/png", size: 1000, kind: "file",
    },
  });
  const foreign = await createUpload(other);
  const owned = await createUpload(owner);
  let bindings = 0;
  const makeRequest = (uploadId: string) => {
    const request = requestInput(owner.id, { quality: "medium" });
    request.editSource = {
      bindAttachment: (tx, conversationId) => {
        bindings += 1;
        return bindStudioImageUpload(tx, {
          userId: owner.id, email: owner.email!, uploadId, conversationId, prompt: request.prompt,
        });
      },
    };
    return request;
  };
  const counts = () => Promise.all([
    prisma.conversation.count(), prisma.message.count(), prisma.messageAttachment.count(),
    prisma.imageGenerationGroup.count(), prisma.imageCreditReservation.count(),
    prisma.chatUsageBucket.count(), prisma.chatRequestLease.count(),
  ]);

  const firstDay = new Date("2026-11-20T12:00:00.000Z");
  const followingDay = new Date("2026-11-21T12:00:00.000Z");
  await assert.rejects(requestImageGeneration(makeRequest(foreign.id), firstDay), { code: "STUDIO_INVALID_REFERENCE" });
  assert.deepEqual(await counts(), [0, 0, 0, 0, 0, 0, 0]);

  const request = makeRequest(owned.id);
  const first = await requestImageGeneration(request, firstDay);
  const attached = await prisma.messageAttachment.findFirstOrThrow({ where: { uploadId: owned.id } });
  const reservation = await prisma.imageCreditReservation.findUniqueOrThrow({ where: { generationId: first.generationId } });
  assert.equal(attached.userId, owner.id);
  assert.equal(attached.conversationId, first.conversationId);
  assert.equal((reservation.pricingSnapshot as { edit?: { attachmentId?: string } }).edit?.attachmentId, attached.id);
  const afterFirst = await counts();

  const replay = await requestImageGeneration(request, firstDay);
  assert.equal(replay.groupId, first.groupId);
  assert.equal(replay.reused, true);
  assert.equal(bindings, 2, "the replay must not bind the source a second time");
  assert.deepEqual(await counts(), afterFirst);

  await assert.rejects(requestImageGeneration(makeRequest(owned.id), followingDay), (error: unknown) =>
    error instanceof MessageAttachmentBindError && error.code === "ATTACHMENT_ALREADY_BOUND");
  assert.deepEqual(await counts(), afterFirst);
  const usage = await prisma.chatUsageBucket.findFirstOrThrow({ where: { key: getUserChatUsageKey(owner.id), period: "month" } });
  assert.equal(Number(usage.count), reservation.reservedCredits);
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

test("a Free plan reserves an image from its existing plan credits without adding credits", async () => {
  await enableImageGeneration();
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@image-test.local`, plan: "Free" },
  });
  const result = await requestImageGeneration(requestInput(user.id));
  const reservation = await prisma.imageCreditReservation.findFirstOrThrow({ where: { generationId: result.generationId } });
  assert.equal(reservation.reservedCredits, 15);
  assert.equal(reservation.planReservedCredits, 15);
  assert.equal(reservation.addOnReservedCredits, 0);
  assert.equal(await prisma.creditLot.count(), 0);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan, "Free");
  assert.equal(await prisma.imageGeneration.count(), 1);
});

test("an exhausted Free allowance refuses image work before any image or reservation exists", async () => {
  await enableImageGeneration();
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@image-test.local`, plan: "Free" } });
  const plan = await getUserBillingPlan(user.id);
  const now = new Date();
  await prisma.chatUsageBucket.create({ data: {
    key: getUserChatUsageKey(user.id), period: "month", periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), count: plan.monthlyMessageLimit,
  } });
  await assert.rejects(requestImageGeneration(requestInput(user.id)), (error: Error & { code?: string }) => {
    assert.equal(error.code, "CREDIT_BALANCE_INSUFFICIENT");
    return true;
  });
  assert.equal(await prisma.conversation.count(), 0);
  assert.equal(await prisma.imageGeneration.count(), 0);
  assert.equal(await prisma.imageCreditReservation.count(), 0);
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

const createChatConversation = (userId: string) =>
  prisma.conversation.create({
    data: {
      userId,
      title: "chat",
      kind: "chat",
      productKey: "chat",
      selectedModels: "[]",
      disabledPanels: "[]",
    },
  });

test("a chat conversation takes an image group only through a Chat image turn", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const chat = await createChatConversation(user.id);

  await assert.rejects(
    requestImageGeneration(requestInput(user.id, { conversationId: chat.id })),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "CONVERSATION_KIND_NOT_SUPPORTED");
      return true;
    }
  );
  assert.equal(await prisma.imageGenerationGroup.count(), 0);

  const turn = await requestImageGeneration(
    requestInput(user.id, { conversationId: chat.id, chatTurnHost: true })
  );
  assert.equal(turn.conversationId, chat.id);
  // Attached to the chat conversation: no image conversation was created.
  assert.equal(await prisma.conversation.count(), 1);
});

test("Review image turns keep product identity, persist images and replay one reservation", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const review = await createChatConversation(user.id);
  await prisma.conversation.update({ where: { id: review.id }, data: { productKey: "review" } });
  const question = await prisma.message.create({ data: { conversationId: review.id, role: "user", content: "a mountain icon" } });
  const input = { userId: user.id, conversationId: review.id, sourceUserMessageId: question.id,
    assistantMessageId: randomUUID(), modelId: "gpt-6-luna", imageModelIds: ["gpt-image-2"], preset: "draft" as const };
  const first = await startChatImageTurn(input);
  const replay = await startChatImageTurn(input);
  assert.equal(first.groupId, replay.groupId);
  assert.equal(await prisma.imageCreditReservation.count(), 1);
  assert.equal(await prisma.conversation.count(), 1);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: review.id } })).productKey, "review");
  const messages = await prisma.message.findMany({ where: { conversationId: review.id }, orderBy: { createdAt: "asc" } });
  const read = await attachChatImageTurns(user.id, review.id, messages);
  assert.equal(read[1].imageTurn?.groupId, first.groupId);
  const target = await prisma.imageGenerationTarget.findFirstOrThrow({ where: { groupId: first.groupId } });
  await prisma.imageGeneration.update({ where: { id: target.currentGenerationId! }, data: { status: "failed" } });
  // The failed executor releases the group's workflow lease.
  await prisma.chatRequestLease.deleteMany({});
  const retry = await retryImageGenerationTarget({ userId: user.id, targetId: target.id,
    retryIdempotencyKey: "review-image-retry-abcdefgh" });
  assert.equal(retry.conversationId, review.id);
  assert.equal(retry.groupId, first.groupId);
  await prisma.conversation.update({ where: { id: review.id }, data: { password: "locked-hash" } });
  await assert.rejects(startChatImageTurn({ ...input, assistantMessageId: randomUUID() }),
    (error: Error & { code?: string }) => error.code === "CONVERSATION_LOCKED");
});

test("unclassified image hosts cannot bypass the Chat image switch for starts or retries", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const chat = await createChatConversation(user.id);
  await prisma.conversation.update({ where: { id: chat.id }, data: { productKey: null } });
  const question = await prisma.message.create({ data: { conversationId: chat.id, role: "user", content: "a mountain icon" } });
  await assert.rejects(startChatImageTurn({ userId: user.id, conversationId: chat.id, sourceUserMessageId: question.id,
    assistantMessageId: randomUUID(), modelId: "gpt-6-luna", imageModelIds: ["gpt-image-2"], preset: "draft" }),
    (error: Error & { code?: string }) => error.code === "CONVERSATION_KIND_NOT_SUPPORTED");
  assert.equal(await prisma.imageCreditReservation.count(), 0);
  const generation = await createGeneration(user.id, chat.id);
  await prisma.imageGeneration.update({ where: { id: generation.id }, data: { status: "failed" } });
  await assert.rejects(retryImageGenerationTarget({ userId: user.id, targetId: generation.targetId!,
    retryIdempotencyKey: "unclassified-retry-refused" }),
    (error: Error & { code?: string }) => error.code === "CONVERSATION_KIND_NOT_SUPPORTED");
  assert.equal(await prisma.imageCreditReservation.count(), 0);
});

test("Review provider panels share one concurrent group, reservation set and durable target mapping", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const review = await createChatConversation(user.id);
  await prisma.conversation.update({ where: { id: review.id }, data: { productKey: "review" } });
  const question = await prisma.message.create({ data: { conversationId: review.id, role: "user", content: "a mountain icon" } });
  const groupKey = randomUUID();
  const imageGroupModelIds = ["fal-ai/nano-banana-2", "gpt-image-2"];
  const inputs = imageGroupModelIds.map((id, index) => ({
    userId: user.id, conversationId: review.id, sourceUserMessageId: question.id,
    assistantMessageId: `${groupKey}_${index}`, modelId: index === 0 ? "gemini-3-6-flash" : "gpt-6-luna",
    imageModelIds: [id], imageGroupModelIds, preset: "standard" as const,
  }));
  const turns = await withGroupMaxModels("3", () => Promise.all(inputs.map(startChatImageTurn)));
  assert.equal(turns[0].groupId, turns[1].groupId);
  assert.equal(await prisma.imageGenerationGroup.count(), 1);
  assert.equal(await prisma.imageGenerationTarget.count(), 2);
  assert.equal(await prisma.imageCreditReservation.count(), 2);
  assert.equal(await prisma.conversation.count(), 1);
  for (let index = 0; index < inputs.length; index++) {
    assert.deepEqual(turns[index].imageModelIds, [imageGroupModelIds[index]]);
    const replay = await startChatImageTurn(inputs[index]);
    assert.equal(replay.groupId, turns[index].groupId);
  }
  assert.equal(await prisma.imageCreditReservation.count(), 2);
  assert.equal(await readPreviousImagePrompt(user.id, review.id, new Request("http://127.0.0.1:3100/api/chat/image-intent")), "a mountain icon");
  const messages = await prisma.message.findMany({ where: { conversationId: review.id } });
  const read = await attachChatImageTurns(user.id, review.id, messages);
  for (let index = 0; index < inputs.length; index++) {
    assert.deepEqual(read.find(message => message.id === inputs[index].assistantMessageId)?.imageTurn,
      { groupId: turns[index].groupId, modelIds: [imageGroupModelIds[index]] });
  }
  await assert.rejects(startChatImageTurn({ ...inputs[0], imageModelIds: [imageGroupModelIds[1]] }),
    (error: Error & { code?: string }) => error.code === "IMAGE_MODEL_SELECTION_INVALID");
});

test("a Chat image turn answers in the chat conversation and replays without charging again", async () => {
  await enableImageGeneration();
  await prisma.appSetting.createMany({
    data: [
      { key: "auto.llmRouterModelId", value: "gpt-6-luna" },
      { key: "auto.llmRouterImageTriage", value: "on" },
    ],
  });
  const user = await createUser();
  const chat = await createChatConversation(user.id);
  const question = await prisma.message.create({
    data: { conversationId: chat.id, role: "user", content: "a small cat icon" },
  });
  const turnInput = {
    userId: user.id,
    conversationId: chat.id,
    sourceUserMessageId: question.id,
    assistantMessageId: randomUUID(),
    modelId: "gpt-6-luna",
    imageModelIds: ["gpt-image-2"],
    preset: "draft" as const,
  };

  const first = await startChatImageTurn(turnInput);
  const replay = await startChatImageTurn(turnInput);
  assert.equal(replay.groupId, first.groupId);
  // Nothing ran the first request's work here, so the replay is what starts
  // it -- the same generation, still one reservation.
  assert.deepEqual(replay.pendingGenerationIds, first.pendingGenerationIds);
  assert.equal(await prisma.imageCreditReservation.count(), 1);
  assert.equal(await prisma.conversation.count(), 1);

  const group = await prisma.imageGenerationGroup.findUniqueOrThrow({
    where: { id: first.groupId },
  });
  assert.equal(group.conversationId, chat.id);
  const generation = await prisma.imageGeneration.findFirstOrThrow({
    where: { groupId: first.groupId },
  });
  assert.equal(generation.prompt, "a small cat icon");
  assert.equal(generation.quality, "low");

  const messages = await prisma.message.findMany({
    where: { conversationId: chat.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true },
  });
  assert.equal(messages.length, 2);
  // A follow-up ("make it bluer") finds the prompt that made this image,
  // and only in its owner's conversation.
  const request = new Request("http://127.0.0.1:3100/api/chat/image-intent");
  assert.equal(await readPreviousImagePrompt(user.id, chat.id, request), "a small cat icon");
  const stranger = await createUser();
  assert.equal(await readPreviousImagePrompt(stranger.id, chat.id, request), null);
  // A password-locked conversation is read only with its unlock grant.
  await prisma.conversation.update({ where: { id: chat.id }, data: { password: "locked-hash" } });
  assert.equal(await readPreviousImagePrompt(user.id, chat.id, request), null);
  await prisma.conversation.update({ where: { id: chat.id }, data: { password: null } });

  const read = await attachChatImageTurns(user.id, chat.id, messages);
  assert.deepEqual(read[1], {
    id: turnInput.assistantMessageId,
    role: "assistant",
    content: "[Image generated] a small cat icon",
    imageTurn: { groupId: first.groupId, modelIds: ["gpt-image-2"] },
  });
});

test("a failed image in a chat conversation can be retried there", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const chat = await createChatConversation(user.id);
  const first = await requestImageGeneration(
    requestInput(user.id, { conversationId: chat.id, chatTurnHost: true })
  );
  const target = first.targets[0];
  await prisma.imageGeneration.update({
    where: { id: target.generationId },
    data: { status: "failed", failedAt: new Date() },
  });
  await prisma.chatRequestLease.deleteMany({});

  // With the Chat image switch off, the paid retry is refused.
  await assert.rejects(
    retryImageGenerationTarget({
      userId: user.id,
      targetId: target.targetId,
      retryIdempotencyKey: "chat-retry-off-abcdefgh",
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "CONVERSATION_KIND_NOT_SUPPORTED");
      return true;
    }
  );
  const retry = await retryImageGenerationTarget({
    userId: user.id,
    targetId: target.targetId,
    retryIdempotencyKey: "chat-retry-abcdefgh",
    chatTurnHostAllowed: true,
  });
  assert.equal(retry.groupId, first.groupId);
  assert.equal(retry.conversationId, chat.id);
  assert.equal(
    await prisma.imageGeneration.count({ where: { targetId: target.targetId } }),
    2
  );
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

test("a non-OpenAI reservation charges its own provider budget, and only its own", async () => {
  // The defect behind this test: admission has been per-provider since v2
  // (`imageProviderBudgetKey(provider)`), while the refund was still pinned to
  // a module constant for OpenAI. Every xAI and fal settlement credited
  // OpenAI's bucket, so OpenAI under-counted its own spend while the other two
  // kept their worst case, and `GREATEST(0, ...)` kept both numbers legal the
  // whole time.
  await enableImageGeneration();
  const user = await createUser();

  const result = await requestImageGeneration(
    // Both option fields stated rather than inherited. `requestInput` is a
    // single-model OpenAI Draft fixture and defaults to `low`, where Nano
    // Banana 2 has no price at all -- it sells 1K square at Standard only --
    // so an inherited tier would be refused before any reservation existed.
    requestInput(user.id, {
      quality: "medium",
      size: "1024x1024",
      modelIds: ["fal-ai/nano-banana-2"],
    })
  );

  const reservation = await prisma.imageCreditReservation.findUnique({
    where: { generationId: result.targets[0].generationId },
  });
  assert.equal(reservation?.provider, "fal");
  const heldMicroUsd = Number(reservation?.reservedCostMicroUsd ?? 0);
  assert.ok(heldMicroUsd > 0);

  const budgetFor = async (provider: string) => {
    const row = await prisma.chatUsageBucket.findFirst({
      where: {
        key: `image-provider:${provider}`,
        period: "provider-cost-day",
      },
    });
    return Number(row?.count ?? 0);
  };

  // The hold lands on fal alone. OpenAI has no row at all -- not a zeroed one.
  assert.equal(await budgetFor("fal"), heldMicroUsd);
  assert.equal(await budgetFor("openai"), 0);

  const sweep = await reconcileStaleImageGenerations(
    new Date(Date.now() + 60 * 60 * 1_000)
  );
  assert.equal(sweep.refunded, 1);

  // Credits come back; the provider charge deliberately does not. The executor
  // died at an unknown point, so the provider may already have been billed and
  // the sweep keeps the charge (`releaseProviderBudget: false`). Asserted
  // rather than assumed, because a later change that starts releasing here
  // would be a real decision about real money and should have to edit a test
  // that says so.
  assert.equal(await budgetFor("fal"), heldMicroUsd);
  // And whatever a failure path does with the charge, it never moves it onto
  // a provider that was never charged. This is the half of the defect a test
  // can reach: the settlement true-up that produced it runs only on success,
  // and success needs a provider response this suite has no seam to fake.
  assert.equal(await budgetFor("openai"), 0);
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
          // Stated, not inherited. `requestInput` defaults to `low`, where
          // Grok and Nano Banana 2 have no price at all, so the group would be
          // refused for an unpriceable model instead of for the limit -- the
          // same 400 for a different reason, which is exactly the confusion
          // this test exists to rule out. `size` is spelled out for the same
          // reason: a multi-model test must not inherit a tier from a fixture
          // built for a single-model one, even when the values agree today.
          quality: "medium",
          size: "1024x1024",
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
    // Both option fields stated for the same reason as above: Grok and Nano
    // Banana 2 price 1K square at Standard only, and all-or-nothing admission
    // refuses a group whose second model cannot be priced.
    requestImageGeneration(
      requestInput(user.id, {
        quality: "medium",
        size: "1024x1024",
        modelIds,
      })
    )
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

/* ------------------------------------------------------------------------- */
/* Purchased credits in a multi-model group: each target settles its own.    */
/* ------------------------------------------------------------------------- */

const COMPARISON_MODELS = {
  openAi: "gpt-image-2", // 70 credits at Standard 1K
  xai: "grok-imagine-image-quality-20260403", // 75 credits at Standard 1K
} as const;

const comparisonRequestInput = (userId: string, modelIds: string[]) =>
  requestInput(userId, { quality: "medium", size: "1024x1024", modelIds });

const spendMonthlyPlanCredits = (userId: string, used: number) => {
  const now = new Date();
  return prisma.chatUsageBucket.create({
    data: {
      key: getUserChatUsageKey(userId),
      period: "month",
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      count: used,
    },
  });
};

const createCreditLot = (
  userId: string,
  credits: number,
  fundedCostMicroUsd: number,
  expiresInDays: number
) =>
  prisma.creditLot.create({
    data: {
      userId,
      source: "credit_pack",
      originalCredits: credits,
      remainingCredits: credits,
      originalFundedCostMicroUsd: BigInt(fundedCostMicroUsd),
      remainingFundedCostMicroUsd: BigInt(fundedCostMicroUsd),
      status: "active",
      expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
    },
  });

const purchasedBalance = async (userId: string) => {
  const lots = await prisma.creditLot.findMany({ where: { userId } });
  return {
    credits: lots.reduce((sum, lot) => sum + lot.remainingCredits, 0),
    fundedCostMicroUsd: lots.reduce(
      (sum, lot) => sum + Number(lot.remainingFundedCostMicroUsd),
      0
    ),
  };
};

/** The group's reservations in target order, with what each one's lot payload adds up to. */
const reservationsInTargetOrder = async (
  result: Awaited<ReturnType<typeof requestImageGeneration>>
) => {
  const rows = [];
  for (const target of result.targets) {
    const reservation = await prisma.imageCreditReservation.findUniqueOrThrow({
      where: { generationId: target.generationId },
    });
    const payload = reservation.reservationPayload as Array<{
      lotId: string;
      credits: number;
      fundedCostMicroUsd: number;
    }>;
    rows.push({
      ...reservation,
      fundedCost: Number(reservation.reservedFundedCostMicroUsd),
      payload,
      payloadCredits: payload.reduce((sum, entry) => sum + entry.credits, 0),
      payloadFundedCost: payload.reduce(
        (sum, entry) => sum + entry.fundedCostMicroUsd,
        0
      ),
    });
  }
  return rows;
};

/** Makes one attempt look abandoned, so the stale sweep takes it and leaves its siblings. */
const abandonGeneration = (generationId: string) =>
  prisma.$executeRaw`
    UPDATE "ImageGeneration"
    SET "updatedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 hours'
    WHERE "id" = ${generationId}
  `;

/**
 * Stand-ins for the two things a successful attempt reaches outside the
 * database: the OpenAI image endpoint (through `fetch`) and the bucket the
 * original is written to (a local server the S3 client is pointed at). With
 * them the real success settlement runs against the test database.
 */
const withImageExecutionStandIns = async <T,>(run: () => Promise<T>): Promise<T> => {
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#888" },
  })
    .png()
    .toBuffer();
  const bucket = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { ETag: '"stand-in"' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => bucket.listen(0, "127.0.0.1", resolve));
  const overrides: Record<string, string> = {
    OPENAI_IMAGE_API_KEY: "test-image-key",
    R2_ACCOUNT_ID: "test-account",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_BUCKET_NAME: "test-bucket",
    R2_ENDPOINT: `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`,
  };
  const previous = Object.keys(overrides).map(
    (name) => [name, process.env[name]] as const
  );
  Object.assign(process.env, overrides);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(String(url), "https://api.openai.com/v1/images/generations");
    return Response.json(
      {
        data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 10, output_tokens: 100 },
      },
      { headers: { "x-request-id": "req_stand_in" } }
    );
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    bucket.closeAllConnections();
    await new Promise((resolve) => bucket.close(resolve));
  }
};

test("each target of a group paid with purchased credits holds its own lot share", async () => {
  await enableImageGeneration();
  const user = await createUser();
  await spendMonthlyPlanCredits(user.id, 3_000);
  // Two lots, the first too small for the group: the shares span lots.
  await createCreditLot(user.id, 100, 150_000, 10);
  await createCreditLot(user.id, 400, 600_000, 30);

  const result = await requestImageGeneration(
    comparisonRequestInput(user.id, [COMPARISON_MODELS.openAi, COMPARISON_MODELS.xai])
  );
  const [first, second] = await reservationsInTargetOrder(result);
  assert.equal(first.addOnReservedCredits, 70);
  assert.equal(second.addOnReservedCredits, 75);
  for (const reservation of [first, second]) {
    assert.equal(reservation.payloadCredits, reservation.addOnReservedCredits);
    assert.equal(reservation.payloadFundedCost, reservation.fundedCost);
  }
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500 - 145,
    fundedCostMicroUsd: 750_000 - first.fundedCost - second.fundedCost,
  });
  // The ledger names the reservation each lot movement belongs to.
  const reserveRows = await prisma.creditLedgerEntry.findMany({
    where: { userId: user.id, type: "reserve" },
  });
  for (const reservation of [first, second]) {
    assert.equal(
      reserveRows
        .filter((row) => row.reservationId === reservation.id)
        .reduce((sum, row) => sum - row.creditsDelta, 0),
      reservation.addOnReservedCredits
    );
  }

  // The first model succeeds while the second is still running: its own
  // share is consumed and the second's stays held.
  await withImageExecutionStandIns(() =>
    processImageGeneration(result.targets[0].generationId)
  );
  const succeeded = await prisma.imageGeneration.findUniqueOrThrow({
    where: { id: result.targets[0].generationId },
  });
  assert.equal(succeeded.status, "succeeded");
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500 - 145,
    fundedCostMicroUsd: 750_000 - first.fundedCost - second.fundedCost,
  });

  // The second model is abandoned: only its share comes back.
  const sweep = await reconcileStaleImageGenerations(
    new Date(Date.now() + 60 * 60 * 1_000)
  );
  assert.equal(sweep.refunded, 1);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500 - 70,
    fundedCostMicroUsd: 750_000 - first.fundedCost,
  });
  const ledger = await prisma.creditLedgerEntry.aggregate({
    where: { userId: user.id },
    _sum: { creditsDelta: true, fundedCostMicroUsdDelta: true },
  });
  assert.equal(ledger._sum.creditsDelta, -70);
  assert.equal(Number(ledger._sum.fundedCostMicroUsdDelta), -first.fundedCost);
});

test("a failed first target returns only its share, and the second still pays for its image", async () => {
  await enableImageGeneration();
  const user = await createUser();
  await spendMonthlyPlanCredits(user.id, 3_000);
  await createCreditLot(user.id, 500, 750_000, 30);

  const result = await requestImageGeneration(
    comparisonRequestInput(user.id, [COMPARISON_MODELS.xai, COMPARISON_MODELS.openAi])
  );
  const [first, second] = await reservationsInTargetOrder(result);
  assert.equal(first.addOnReservedCredits, 75);
  assert.equal(second.addOnReservedCredits, 70);

  await abandonGeneration(result.targets[0].generationId);
  const sweep = await reconcileStaleImageGenerations(new Date());
  assert.equal(sweep.refunded, 1);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500 - 70,
    fundedCostMicroUsd: 750_000 - second.fundedCost,
  });

  await withImageExecutionStandIns(() =>
    processImageGeneration(result.targets[1].generationId)
  );
  const settled = await prisma.imageCreditReservation.findUniqueOrThrow({
    where: { id: second.id },
  });
  assert.equal(settled.outcome, "completed");
  assert.equal(settled.settledCredits, 70);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500 - 70,
    fundedCostMicroUsd: 750_000 - second.fundedCost,
  });
  const settleRows = await prisma.creditLedgerEntry.findMany({
    where: { userId: user.id, type: "settle", reservationId: second.id },
  });
  assert.equal(
    settleRows.reduce(
      (sum, row) =>
        sum + Number((row.metadata as { settledCredits?: number }).settledCredits ?? 0),
      0
    ),
    70
  );
});

test("purchased credits held only by a later target come back when that target fails", async () => {
  await enableImageGeneration();
  const user = await createUser();
  // Plan credits cover all but one credit of the 145, and that one falls to
  // the second target.
  await spendMonthlyPlanCredits(user.id, 3_000 - 144);
  await createCreditLot(user.id, 500, 750_000, 30);

  const result = await requestImageGeneration(
    comparisonRequestInput(user.id, [COMPARISON_MODELS.openAi, COMPARISON_MODELS.xai])
  );
  const [first, second] = await reservationsInTargetOrder(result);
  assert.equal(first.addOnReservedCredits, 0);
  assert.deepEqual(first.payload, []);
  assert.equal(second.addOnReservedCredits, 1);
  assert.equal(second.payloadCredits, 1);
  assert.equal(second.payloadFundedCost, second.fundedCost);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 499,
    fundedCostMicroUsd: 750_000 - second.fundedCost,
  });

  const sweep = await reconcileStaleImageGenerations(
    new Date(Date.now() + 60 * 60 * 1_000)
  );
  assert.equal(sweep.refunded, 2);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500,
    fundedCostMicroUsd: 750_000,
  });
  const monthBucket = await prisma.chatUsageBucket.findFirst({
    where: { key: getUserChatUsageKey(user.id), period: "month" },
  });
  assert.equal(Number(monthBucket?.count ?? 0), 3_000 - 144);
});

test("a group reserved in the earlier payload shape still settles once and never over-refunds", async () => {
  await enableImageGeneration();
  const user = await createUser();
  await spendMonthlyPlanCredits(user.id, 3_000);
  await createCreditLot(user.id, 500, 750_000, 30);

  const result = await requestImageGeneration(
    comparisonRequestInput(user.id, [COMPARISON_MODELS.openAi, COMPARISON_MODELS.xai])
  );
  const [first, second] = await reservationsInTargetOrder(result);
  // The shape reservations had before each target stored its own share: the
  // whole group's lot list on the first target, nothing on the others.
  await prisma.imageCreditReservation.update({
    where: { id: first.id },
    data: { reservationPayload: [...first.payload, ...second.payload] },
  });
  await prisma.imageCreditReservation.update({
    where: { id: second.id },
    data: { reservationPayload: [] },
  });

  const sweep = await reconcileStaleImageGenerations(
    new Date(Date.now() + 60 * 60 * 1_000)
  );
  assert.equal(sweep.refunded, 2);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500,
    fundedCostMicroUsd: 750_000,
  });
  const again = await reconcileStaleImageGenerations(
    new Date(Date.now() + 61 * 60 * 1_000)
  );
  assert.equal(again.refunded, 0);
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500,
    fundedCostMicroUsd: 750_000,
  });
});

test("a group whose later target cannot be funded is refused whole, reporting the untouched balance", async () => {
  await enableImageGeneration();
  const user = await createUser();
  await spendMonthlyPlanCredits(user.id, 3_000);
  // Enough credits for both models, cost allowance for the first only.
  await createCreditLot(user.id, 500, 60_000, 30);

  await assert.rejects(
    requestImageGeneration(
      comparisonRequestInput(user.id, [COMPARISON_MODELS.openAi, COMPARISON_MODELS.xai])
    ),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "CREDIT_COST_ALLOWANCE_INSUFFICIENT");
      assert.equal(error.details?.availableCredits, 500);
      return true;
    }
  );
  assert.deepEqual(await purchasedBalance(user.id), {
    credits: 500,
    fundedCostMicroUsd: 60_000,
  });
  assert.equal(await prisma.creditLedgerEntry.count(), 0);
  assert.equal(await prisma.imageCreditReservation.count(), 0);
});

/* ------------------------------------------------------------------------- */
/* Stale recovery: a pending generation is re-driven once, not refunded.     */
/* ------------------------------------------------------------------------- */

const minutesLater = (minutes: number) =>
  new Date(Date.now() + minutes * 60 * 1_000);

/** A sweep scheduler that keeps the re-drive for the test to run, or not. */
const capturedRedrives = () => {
  const runs: Array<() => Promise<void>> = [];
  return {
    runs,
    options: {
      scheduleRedrive: (run: () => Promise<void>) => {
        runs.push(run);
      },
    },
  };
};

/** Provider calls answered while `run` ran; call it inside the stand-ins. */
const countingProviderCalls = async (run: () => Promise<unknown>) => {
  const answer = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    return answer(...args);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = answer;
  }
  return calls;
};

const imageReservation = (generationId: string) =>
  prisma.imageCreditReservation.findUniqueOrThrow({ where: { generationId } });

const monthlyPlanCreditsUsed = async (userId: string) =>
  Number(
    (
      await prisma.chatUsageBucket.findFirst({
        where: { key: getUserChatUsageKey(userId), period: "month" },
      })
    )?.count ?? 0
  );

const openAiBudgetHeld = async () =>
  Number(
    (
      await prisma.chatUsageBucket.findFirst({
        where: { key: "image-provider:openai", period: "provider-cost-day" },
      })
    )?.count ?? 0
  );

test("a pending generation whose executor died is re-driven once and settles instead of refunding", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(requestInput(user.id));
  const redrive = capturedRedrives();

  // The 202 went out and the process died before after() claimed the row.
  const sweep = await reconcileStaleImageGenerations(minutesLater(5), 25, redrive.options);
  assert.equal(sweep.redriven, 1);
  assert.equal(sweep.refunded, 0);
  assert.equal(redrive.runs.length, 1);
  const marked = await imageReservation(result.generationId);
  assert.ok(marked.reconciledAt, "the one re-drive is recorded on the reservation");
  assert.equal(marked.status, "reserved");

  // Past the stale window, before the re-drive ran: the next sweep neither
  // schedules a second re-drive nor refunds the row out from under the first.
  const again = await reconcileStaleImageGenerations(minutesLater(13), 25, redrive.options);
  assert.equal(again.redriven, 0);
  assert.equal(again.refunded, 0);
  assert.equal(redrive.runs.length, 1);

  const calls = await withImageExecutionStandIns(() =>
    countingProviderCalls(() => redrive.runs[0]())
  );
  assert.equal(calls, 1);
  const generation = await prisma.imageGeneration.findUniqueOrThrow({
    where: { id: result.generationId },
  });
  assert.equal(generation.status, "succeeded");
  const settled = await imageReservation(result.generationId);
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "completed");
  assert.equal(settled.settledCredits, 15);
  assert.equal(settled.refundedAt, null);
  // The person got the image they paid for, so the plan credits stay spent.
  assert.equal(await monthlyPlanCreditsUsed(user.id), 15);

  const later = await reconcileStaleImageGenerations(minutesLater(30), 25, redrive.options);
  assert.equal(later.redriven, 0);
  assert.equal(later.refunded, 0);
});

test("a slow executor racing the re-drive leaves one provider call and one settlement", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(requestInput(user.id));
  const redrive = capturedRedrives();
  await reconcileStaleImageGenerations(minutesLater(5), 25, redrive.options);
  assert.equal(redrive.runs.length, 1);

  // The original executor was only slow, and wakes as the re-drive starts.
  const calls = await withImageExecutionStandIns(() =>
    countingProviderCalls(() =>
      Promise.all([processImageGeneration(result.generationId), redrive.runs[0]()])
    )
  );
  assert.equal(calls, 1);
  const settled = await imageReservation(result.generationId);
  assert.equal(settled.outcome, "completed");
  assert.equal(settled.settledCredits, 15);
  assert.equal(await monthlyPlanCreditsUsed(user.id), 15);
  // The budget was trued up once: it holds exactly what the one attempt cost.
  assert.equal(await openAiBudgetHeld(), Number(settled.settledCostMicroUsd));
  assert.equal(
    await prisma.imageAsset.count({
      where: { generationId: result.generationId, role: "original" },
    }),
    1
  );
});

test("a processing generation is refunded on the stale window and never re-driven", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(requestInput(user.id));
  // The executor had claimed it, so the provider may have been called.
  await prisma.imageGeneration.update({
    where: { id: result.generationId },
    data: { status: "processing", startedAt: new Date() },
  });
  const redrive = capturedRedrives();

  const early = await reconcileStaleImageGenerations(minutesLater(5), 25, redrive.options);
  assert.equal(early.redriven, 0);
  assert.equal(early.refunded, 0);
  const sweep = await reconcileStaleImageGenerations(minutesLater(13), 25, redrive.options);
  assert.equal(sweep.redriven, 0);
  assert.equal(sweep.refunded, 1);
  assert.equal(redrive.runs.length, 0);

  const generation = await prisma.imageGeneration.findUniqueOrThrow({
    where: { id: result.generationId },
  });
  assert.equal(generation.status, "failed");
  assert.equal(generation.failurePhase, "stale_job_reconciled");
  const reservation = await imageReservation(result.generationId);
  assert.equal(reservation.outcome, "failed");
  assert.equal(reservation.reconciledAt, null);
  assert.equal(await monthlyPlanCreditsUsed(user.id), 0);
  // An unknown outcome keeps its whole hold on the provider budget.
  assert.equal(await openAiBudgetHeld(), 11_000);
});

test("a target queued behind a live sibling is left to its own executor", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(
    comparisonRequestInput(user.id, [COMPARISON_MODELS.openAi, COMPARISON_MODELS.xai])
  );
  const [running, queued] = result.targets;
  await prisma.imageGeneration.update({
    where: { id: running.generationId },
    data: { status: "processing", startedAt: new Date() },
  });
  const redrive = capturedRedrives();

  const sweep = await reconcileStaleImageGenerations(minutesLater(5), 25, redrive.options);
  assert.equal(sweep.redriven, 0);
  assert.equal((await imageReservation(queued.generationId)).reconciledAt, null);

  // Once the sibling is itself abandoned, nothing is left to run the queue:
  // the sibling is refunded and the queued target re-driven.
  const later = await reconcileStaleImageGenerations(minutesLater(13), 25, redrive.options);
  assert.equal(later.refunded, 1);
  assert.equal(later.redriven, 1);
  assert.equal(
    (await prisma.imageGeneration.findUniqueOrThrow({ where: { id: running.generationId } }))
      .status,
    "failed"
  );
  assert.ok((await imageReservation(queued.generationId)).reconciledAt);
});

test("a re-drive that never claimed its row is refunded a stale window after it was scheduled", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(requestInput(user.id));
  // Scheduled, then lost: the maintenance process died after answering.
  const lost = capturedRedrives();
  assert.equal(
    (await reconcileStaleImageGenerations(minutesLater(5), 25, lost.options)).redriven,
    1
  );

  const waiting = await reconcileStaleImageGenerations(minutesLater(16), 25, lost.options);
  assert.equal(waiting.redriven, 0);
  assert.equal(waiting.refunded, 0);
  const refund = await reconcileStaleImageGenerations(minutesLater(18), 25, lost.options);
  assert.equal(refund.redriven, 0);
  assert.equal(refund.refunded, 1);
  const generation = await prisma.imageGeneration.findUniqueOrThrow({
    where: { id: result.generationId },
  });
  assert.equal(generation.status, "failed");
  assert.equal(generation.failurePhase, "stale_job_reconciled");
  const reservation = await imageReservation(result.generationId);
  assert.equal(reservation.outcome, "failed");
  assert.ok(reservation.refundedAt);
  assert.equal(await monthlyPlanCreditsUsed(user.id), 0);

  // The spent re-drive arriving late finds nothing to claim.
  const calls = await withImageExecutionStandIns(() =>
    countingProviderCalls(() => lost.runs[0]())
  );
  assert.equal(calls, 0);
  assert.equal((await imageReservation(result.generationId)).outcome, "failed");
});

test("a pending generation past the re-drive age is refunded, not run", async () => {
  await enableImageGeneration();
  const user = await createUser();
  const result = await requestImageGeneration(requestInput(user.id));
  const redrive = capturedRedrives();

  const sweep = await reconcileStaleImageGenerations(minutesLater(61), 25, redrive.options);
  assert.equal(sweep.redriven, 0);
  assert.equal(sweep.refunded, 1);
  assert.equal(redrive.runs.length, 0);
  assert.equal((await imageReservation(result.generationId)).outcome, "failed");
  assert.equal(await monthlyPlanCreditsUsed(user.id), 0);
});

test("one sweep re-drives at most its batch and leaves the rest unmarked for the next", async () => {
  await enableImageGeneration();
  const generationIds: string[] = [];
  for (let index = 0; index <= IMAGE_PENDING_REDRIVE_MAX_PER_SWEEP; index += 1) {
    const user = await createUser();
    generationIds.push(
      (await requestImageGeneration(requestInput(user.id))).generationId
    );
  }
  const redrive = capturedRedrives();

  const first = await reconcileStaleImageGenerations(minutesLater(5), 25, redrive.options);
  assert.equal(first.redriven, IMAGE_PENDING_REDRIVE_MAX_PER_SWEEP);
  assert.equal(
    await prisma.imageCreditReservation.count({
      where: { generationId: { in: generationIds }, reconciledAt: null },
    }),
    1
  );
  const second = await reconcileStaleImageGenerations(minutesLater(6), 25, redrive.options);
  assert.equal(second.redriven, 1);
  assert.equal(redrive.runs.length, 2);
});
