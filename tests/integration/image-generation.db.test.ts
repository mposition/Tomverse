import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  auditImageGenerationInvariants,
  enqueueImageAssetCleanupForConversations,
} from "@/lib/imageAssetLifecycle";
import { imageAssetR2Key } from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";

const resetImageTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ImageAssetCleanup",
      "ImageAsset",
      "ImageGeneration",
      "ImageCreditReservation",
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
