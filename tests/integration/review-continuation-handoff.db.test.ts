import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { createExternalContinuation } from "@/lib/externalContinuationService";
import {
  createConversationUnlockCookie,
  createResourceUnlockCookie,
  hasConversationUnlockGrant,
  hasResourceUnlockGrant,
} from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";
import {
  createReviewContinuationHandoff,
  ReviewContinuationHandoffError,
} from "@/lib/reviewContinuationHandoffService";
import { reviewHandoffDescriptorSchema } from "@/lib/reviewContinuationHandoffCore";

const reset = () => prisma.$executeRawUnsafe(`
  TRUNCATE TABLE "ChatComposerDraft", "ChatResponseAttempt", "Message",
    "ConversationContinuationBridge", "Conversation", "ExternalMessage",
    "ExternalConversation", "ExternalImport", "User"
  RESTART IDENTITY CASCADE
`);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

async function fixture() {
  const user = await prisma.user.create({
    data: { email: `review-handoff-${randomUUID()}@example.invalid` },
  });
  const imported = await prisma.externalImport.create({
    data: {
      userId: user.id,
      provider: "chatgpt",
      status: "completed",
      digestVersion: 1,
      parserVersion: "test",
    },
  });
  const source = await prisma.externalConversation.create({
    data: {
      userId: user.id,
      importId: imported.id,
      provider: "chatgpt",
      externalStableId: randomUUID(),
      title: "Private imported title",
      conversationDigest: randomUUID(),
      digestVersion: 1,
      messageCount: 2,
      contentBytes: 64n,
      finalized: true,
    },
  });
  await prisma.externalMessage.createMany({ data: [
    { userId: user.id, externalConversationId: source.id, externalStableId: source.externalStableId,
      role: "user", content: "Kyoto with AUD 1,500.", contentDigest: randomUUID(),
      digestVersion: 1, ordinal: 0 },
    { userId: user.id, externalConversationId: source.id, externalStableId: source.externalStableId,
      role: "assistant", content: "The second option stays in Gion.", contentDigest: randomUUID(),
      digestVersion: 1, ordinal: 1 },
  ] });
  const parent = await createExternalContinuation({
    userId: user.id,
    externalConversationId: source.id,
    idempotencyKey: randomUUID(),
    request: new Request("https://tomverse.test/api/continuation"),
    productKey: "chat",
  });
  const base = new Date("2026-11-15T00:00:00Z");
  await prisma.message.createMany({ data: [
    { id: "prior-user", conversationId: parent.conversationId, role: "user",
      content: "Give me two itinerary options.", createdAt: base },
    { id: "prior-answer", conversationId: parent.conversationId, role: "assistant",
      content: "Option A is Osaka. Option B is Kyoto.", modelId: "gpt-6-luna",
      createdAt: new Date(base.getTime() + 1_000) },
  ] });
  const questionId = randomUUID();
  const assistantId = randomUUID();
  const question = `Use the second option. ${"Keep this detail. ".repeat(90)}`;
  const answer = "A completed Kyoto itinerary.";
  await prisma.message.createMany({ data: [
    { id: questionId, conversationId: parent.conversationId, role: "user", content: question,
      createdAt: new Date(base.getTime() + 2_000) },
    { id: assistantId, conversationId: parent.conversationId, role: "assistant", content: answer,
      modelId: "gpt-6-luna", createdAt: new Date(base.getTime() + 3_000) },
  ] });
  await prisma.chatResponseAttempt.create({ data: {
    assistantMessageId: assistantId,
    userId: user.id,
    conversationId: parent.conversationId,
    sourceUserMessageId: questionId,
    fingerprint: "a".repeat(64),
    requestedModelId: "gpt-6-luna",
    actualModelId: "gpt-6-luna",
    provider: "openai",
    status: "completed",
    partialContent: answer,
    ownerId: "completed-fixture",
    leaseExpiresAt: new Date(base.getTime() + 60_000),
    finishReason: "stop",
    terminalAt: new Date(base.getTime() + 4_000),
  } });
  return { user, source, parent, questionId, assistantId, question, answer };
}

test("handoff atomically creates one reference-only Review target and editable draft without executing", async () => {
  const seeded = await fixture();
  const idempotencyKey = randomUUID();
  const request = new Request("https://tomverse.test/api/handoff");
  const createInput = {
    userId: seeded.user.id,
    parentConversationId: seeded.parent.conversationId,
    assistantMessageId: seeded.assistantId,
    idempotencyKey,
    request,
  };
  const raced = await Promise.all([
    createReviewContinuationHandoff(createInput),
    createReviewContinuationHandoff(createInput),
  ]);
  assert.equal(new Set(raced.map((result) => result.conversationId)).size, 1);
  assert.deepEqual(raced.map((result) => result.idempotentReplay).sort(), [false, true]);
  const created = raced.find((result) => !result.idempotentReplay)!;
  assert.equal(created.idempotentReplay, false);
  assert.match(created.route, /^\/continuations\//);
  const target = await prisma.conversation.findUniqueOrThrow({
    where: { id: created.conversationId },
    include: { continuationBridge: true, composerDrafts: true, messages: true },
  });
  assert.equal(target.productKey, "review");
  assert.equal(target.selectionMode, "manual");
  assert.equal(target.messages.length, 0);
  assert.equal(target.composerDrafts.length, 1);
  assert.equal(target.composerDrafts[0]!.text, seeded.question);
  assert.ok(seeded.question.length > 1_200);
  const descriptor = reviewHandoffDescriptorSchema.parse(target.continuationBridge!.reviewHandoff);
  assert.equal(descriptor.assistantMessageId, seeded.assistantId);
  assert.equal(descriptor.sourceUserMessageId, seeded.questionId);
  assert.equal(descriptor.nativeReferences.length, 2);
  assert.equal(JSON.stringify(descriptor).includes("Kyoto itinerary"), false);
  assert.equal(await prisma.chatCreditReservation.count({
    where: { userId: seeded.user.id },
  }), 0);

  const replay = await createReviewContinuationHandoff(createInput);
  assert.equal(replay.conversationId, created.conversationId);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(await prisma.conversationContinuationBridge.count({
    where: { userId: seeded.user.id, idempotencyKey },
  }), 1);
});

test("the same key cannot be rebound to a different answer", async () => {
  const seeded = await fixture();
  const key = randomUUID();
  const request = new Request("https://tomverse.test/api/handoff");
  await createReviewContinuationHandoff({ userId: seeded.user.id,
    parentConversationId: seeded.parent.conversationId,
    assistantMessageId: seeded.assistantId, idempotencyKey: key, request });
  const secondId = randomUUID();
  await prisma.message.create({ data: { id: secondId, conversationId: seeded.parent.conversationId,
    role: "assistant", content: "Another saved answer.", modelId: "gpt-6-luna" } });
  await assert.rejects(createReviewContinuationHandoff({ userId: seeded.user.id,
    parentConversationId: seeded.parent.conversationId,
    assistantMessageId: secondId, idempotencyKey: key, request }), (error) =>
      error instanceof ReviewContinuationHandoffError &&
      error.code === "REVIEW_HANDOFF_IDEMPOTENCY_CONFLICT");
});

test("parent and external source locks are independent handoff gates", async () => {
  const seeded = await fixture();
  await prisma.conversation.update({ where: { id: seeded.parent.conversationId },
    data: { password: "locked-parent" } });
  const staleParentCookie = createConversationUnlockCookie(
    seeded.user.id, seeded.parent.conversationId, 1
  ).split(";")[0]!;
  await prisma.conversation.update({ where: { id: seeded.parent.conversationId },
    data: { password: "locked-parent-changed" } });
  const parentLock = await prisma.conversation.findUniqueOrThrow({
    where: { id: seeded.parent.conversationId }, select: { password: true, passwordVersion: true },
  });
  const parentRequest = new Request("https://tomverse.test", {
    headers: { cookie: staleParentCookie },
  });
  assert.equal(parentLock.passwordVersion, 2);
  assert.equal(hasConversationUnlockGrant(parentRequest, seeded.user.id,
    seeded.parent.conversationId, parentLock.passwordVersion), false);
  await assert.rejects(createReviewContinuationHandoff({ userId: seeded.user.id,
    parentConversationId: seeded.parent.conversationId, assistantMessageId: seeded.assistantId,
    idempotencyKey: randomUUID(), request: parentRequest }),
    (error) => error instanceof ReviewContinuationHandoffError && error.code === "CONVERSATION_LOCKED");
  await prisma.conversation.update({ where: { id: seeded.parent.conversationId }, data: { password: null } });
  await prisma.externalConversation.update({ where: { id: seeded.source.id },
    data: { password: "locked-source" } });
  const staleSourceCookie = createResourceUnlockCookie(
    "external_conversation", seeded.user.id, seeded.source.id, 1
  ).split(";")[0]!;
  await prisma.externalConversation.update({ where: { id: seeded.source.id },
    data: { password: "locked-source-changed" } });
  const sourceLock = await prisma.externalConversation.findUniqueOrThrow({
    where: { id: seeded.source.id }, select: { password: true, passwordVersion: true },
  });
  const sourceRequest = new Request("https://tomverse.test", {
    headers: { cookie: staleSourceCookie },
  });
  assert.equal(sourceLock.passwordVersion, 2);
  assert.equal(hasResourceUnlockGrant("external_conversation", sourceRequest, seeded.user.id,
    seeded.source.id, sourceLock.passwordVersion), false);
  await assert.rejects(createReviewContinuationHandoff({ userId: seeded.user.id,
    parentConversationId: seeded.parent.conversationId, assistantMessageId: seeded.assistantId,
    idempotencyKey: randomUUID(), request: sourceRequest }),
    (error) => error instanceof ReviewContinuationHandoffError &&
      error.code === "EXTERNAL_CONVERSATION_LOCKED");
});

test("deleting the external source leaves the Chat parent readable but blocks handoff creation", async () => {
  const seeded = await fixture();
  await prisma.externalConversation.delete({ where: { id: seeded.source.id } });
  assert.ok(await prisma.conversation.findUnique({ where: { id: seeded.parent.conversationId } }));
  await assert.rejects(createReviewContinuationHandoff({ userId: seeded.user.id,
    parentConversationId: seeded.parent.conversationId, assistantMessageId: seeded.assistantId,
    idempotencyKey: randomUUID(), request: new Request("https://tomverse.test") }),
    (error) => error instanceof ReviewContinuationHandoffError &&
      error.code === "REVIEW_HANDOFF_PARENT_NOT_FOUND");
  const bridges = await prisma.conversationContinuationBridge.findMany({
    where: { userId: seeded.user.id },
    select: { reviewHandoff: true },
  });
  assert.equal(bridges.filter((bridge) => bridge.reviewHandoff !== null).length, 0);
});
