import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, beforeEach, test } from "node:test";

import { buildAccountDataExport } from "@/lib/accountDataExport";
import {
  ChatDraftRevisionConflictError,
  writeChatComposerDraft,
} from "@/lib/chatComposerDraftPersistence";
import {
  ActiveChatResponseAttemptError,
  deleteChatResponseAttemptsForModelHistory,
} from "@/lib/chatResponseAttemptDeletion";
import {
  ChatDraftConsumeConflictError,
  consumeChatDraftForMessage,
  reconcileChatDraftMessageReceipt,
} from "@/lib/chatDraftMessageConsume";
import {
  ChatSourceMessageMismatchError,
  verifyDurableChatSourceMessage,
} from "@/lib/chatDurableSourceMessage";
import {
  ChatAttemptCapacityError,
  ChatAttemptCasError,
  ChatAttemptIdentityConflictError,
  checkpointChatResponseAttempt,
  claimChatResponseAttempt,
  listChatResponseAttempts,
  readChatResponseAttempt,
  terminalChatResponseAttempt,
} from "@/lib/chatResponseAttemptPersistence";
import { prisma } from "@/lib/prisma";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatComposerDraft",
      "ChatResponseAttempt",
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

type SeededChat = {
  userId: string;
  email: string;
  conversationId: string;
  sourceUserMessageId: string;
  recoveryEpoch: number;
};

async function seedChat(label = "owner"): Promise<SeededChat> {
  const userId = randomUUID();
  const email = `${label}-${userId}@example.invalid`;
  const conversationId = randomUUID();
  const sourceUserMessageId = randomUUID();
  await prisma.user.create({ data: { id: userId, email } });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      userId,
      title: `Durable recovery ${label}`,
      kind: "chat",
      productKey: "chat",
    },
  });
  await prisma.message.create({
    data: {
      id: sourceUserMessageId,
      conversationId,
      role: "user",
      content: "Persist this turn.",
    },
  });
  return { userId, email, conversationId, sourceUserMessageId, recoveryEpoch: 0 };
}

const leaseAfter = (milliseconds = 120_000) => new Date(Date.now() + milliseconds);

function claimInput(
  chat: SeededChat,
  overrides: Partial<{
    assistantMessageId: string;
    conversationId: string;
    sourceUserMessageId: string;
    requestedModelId: string;
    requestPayloadDigest: string;
    expectedRecoveryEpoch: number;
    ownerId: string;
    leaseExpiresAt: Date;
  }> = {}
) {
  return {
    userId: chat.userId,
    assistantMessageId: overrides.assistantMessageId ?? randomUUID(),
    conversationId: overrides.conversationId ?? chat.conversationId,
    sourceUserMessageId: overrides.sourceUserMessageId ?? chat.sourceUserMessageId,
    requestedModelId: overrides.requestedModelId ?? "provider/model-a",
    requestPayloadDigest: overrides.requestPayloadDigest ?? "a".repeat(64),
    expectedRecoveryEpoch:
      overrides.expectedRecoveryEpoch ?? chat.recoveryEpoch,
    ownerId: overrides.ownerId ?? `worker-${randomUUID()}`,
    leaseExpiresAt: overrides.leaseExpiresAt ?? leaseAfter(),
  };
}

async function expectAttemptCas(
  run: Promise<unknown>,
  reason: string
): Promise<ChatAttemptCasError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof ChatAttemptCasError, String(error));
    assert.equal(error.reason, reason);
    return error;
  }
  throw new Error(`Expected ChatAttemptCasError(${reason}).`);
}

test("parallel duplicate claims assign dispatch ownership exactly once", async () => {
  const chat = await seedChat();
  const assistantMessageId = randomUUID();
  const shared = claimInput(chat, { assistantMessageId });

  const results = await Promise.all([
    claimChatResponseAttempt({ ...shared, ownerId: "worker-alpha" }),
    claimChatResponseAttempt({ ...shared, ownerId: "worker-beta" }),
  ]);

  assert.deepEqual(
    results.map((result) => result.disposition).sort(),
    ["claimed", "reattach"]
  );
  const stored = await prisma.chatResponseAttempt.findUniqueOrThrow({
    where: { assistantMessageId },
  });
  assert.ok(["worker-alpha", "worker-beta"].includes(stored.ownerId));
  assert.equal(await prisma.chatResponseAttempt.count({ where: { assistantMessageId } }), 1);
});

test("attempt storage caps new identities but always permit an exact reattach", async () => {
  const priorConversationLimit = process.env.CHAT_RESPONSE_ATTEMPTS_PER_CONVERSATION;
  const priorUserLimit = process.env.CHAT_RESPONSE_ATTEMPTS_PER_USER;
  process.env.CHAT_RESPONSE_ATTEMPTS_PER_CONVERSATION = "1";
  process.env.CHAT_RESPONSE_ATTEMPTS_PER_USER = "1";
  try {
    const chat = await seedChat("capacity");
    const original = claimInput(chat, { ownerId: "worker-original" });
    const claimed = await claimChatResponseAttempt(original);
    assert.equal(claimed.disposition, "claimed");

    const reattached = await claimChatResponseAttempt({
      ...original,
      ownerId: "worker-reattach",
    });
    assert.equal(reattached.disposition, "reattach");

    await assert.rejects(
      claimChatResponseAttempt(claimInput(chat, { ownerId: "worker-over-cap" })),
      (error) =>
        error instanceof ChatAttemptCapacityError &&
        error.code === "CHAT_ATTEMPT_STORAGE_QUOTA_EXCEEDED"
    );
    assert.equal(await prisma.chatResponseAttempt.count({ where: { userId: chat.userId } }), 1);
  } finally {
    if (priorConversationLimit === undefined) {
      delete process.env.CHAT_RESPONSE_ATTEMPTS_PER_CONVERSATION;
    } else {
      process.env.CHAT_RESPONSE_ATTEMPTS_PER_CONVERSATION = priorConversationLimit;
    }
    if (priorUserLimit === undefined) {
      delete process.env.CHAT_RESPONSE_ATTEMPTS_PER_USER;
    } else {
      process.env.CHAT_RESPONSE_ATTEMPTS_PER_USER = priorUserLimit;
    }
  }
});

test("same-id mismatches converge on the identity conflict without exposing another account", async () => {
  const owner = await seedChat("owner");
  const other = await seedChat("other");
  const assistantMessageId = randomUUID();
  const original = claimInput(owner, { assistantMessageId, ownerId: "worker-owner" });
  await claimChatResponseAttempt(original);

  await assert.rejects(
    claimChatResponseAttempt({
      ...original,
      conversationId: randomUUID(),
      sourceUserMessageId: randomUUID(),
      requestPayloadDigest: "b".repeat(64),
      leaseExpiresAt: new Date(0),
    }),
    (error) => {
      assert.ok(error instanceof ChatAttemptIdentityConflictError, String(error));
      assert.equal(error.code, "CHAT_ATTEMPT_ID_REUSED");
      return true;
    }
  );

  await assert.rejects(
    claimChatResponseAttempt({
      ...claimInput(other, { assistantMessageId, ownerId: "worker-other" }),
      requestPayloadDigest: "c".repeat(64),
    }),
    (error) => {
      assert.ok(error instanceof ChatAttemptIdentityConflictError, String(error));
      assert.equal(error.code, "CHAT_ATTEMPT_ID_REUSED");
      return true;
    }
  );
  assert.equal(await prisma.chatResponseAttempt.count({ where: { assistantMessageId } }), 1);
});

test("durable source binding uses the latest persisted id and exact attachment identities", async () => {
  const chat = await seedChat();
  const secondMessageId = randomUUID();
  await prisma.message.create({
    data: {
      id: secondMessageId,
      conversationId: chat.conversationId,
      role: "user",
      content: "Another stored turn.",
    },
  });
  const uploadA = await prisma.messageAttachmentUpload.create({
    data: {
      userId: chat.userId,
      objectKey: `${chat.userId}/source-a`,
      name: "same.txt",
      mediaType: "text/plain",
      size: 12,
      kind: "text",
    },
  });
  const uploadB = await prisma.messageAttachmentUpload.create({
    data: {
      userId: chat.userId,
      objectKey: `${chat.userId}/source-b`,
      name: "same.txt",
      mediaType: "text/plain",
      size: 12,
      kind: "text",
    },
  });
  const boundAttachmentA = await prisma.messageAttachment.create({
    data: {
      messageId: chat.sourceUserMessageId,
      conversationId: chat.conversationId,
      userId: chat.userId,
      ordinal: 0,
      uploadId: uploadA.id,
      objectKey: uploadA.objectKey,
      name: uploadA.name,
      mediaType: uploadA.mediaType,
      size: uploadA.size,
      kind: uploadA.kind,
      sourceAttachmentId: "request-source-a",
    },
  });
  const boundAttachmentB = await prisma.messageAttachment.create({
    data: {
      messageId: secondMessageId,
      conversationId: chat.conversationId,
      userId: chat.userId,
      ordinal: 0,
      uploadId: uploadB.id,
      objectKey: uploadB.objectKey,
      name: uploadB.name,
      mediaType: uploadB.mediaType,
      size: uploadB.size,
      kind: uploadB.kind,
      sourceAttachmentId: "request-source-b",
    },
  });

  await verifyDurableChatSourceMessage({
    userId: chat.userId,
    conversationId: chat.conversationId,
    sourceUserMessageId: chat.sourceUserMessageId,
    messages: [
      {
        id: chat.sourceUserMessageId,
        role: "user",
        content: "Persist this turn.",
        // This is the shape restored by conversation GET and returned by the
        // message-save route: the current bound row id, not its provenance id.
        attachments: [{ attachmentId: boundAttachmentA.id }],
      },
    ],
  });
  await assert.rejects(
    verifyDurableChatSourceMessage({
      userId: chat.userId,
      conversationId: chat.conversationId,
      sourceUserMessageId: chat.sourceUserMessageId,
      messages: [
        {
          id: chat.sourceUserMessageId,
          role: "user",
          content: "Persist this turn.",
          attachments: [{ attachmentId: boundAttachmentB.id }],
        },
      ],
    }),
    (error) => error instanceof ChatSourceMessageMismatchError
  );
  await assert.rejects(
    verifyDurableChatSourceMessage({
      userId: chat.userId,
      conversationId: chat.conversationId,
      sourceUserMessageId: chat.sourceUserMessageId,
      messages: [
        {
          id: chat.sourceUserMessageId,
          role: "user",
          content: "Persist this turn.",
          attachments: [{ attachmentId: boundAttachmentA.id }],
        },
        {
          id: secondMessageId,
          role: "user",
          content: "New payload that must be authoritative.",
          attachments: [{ attachmentId: boundAttachmentB.id }],
        },
      ],
    }),
    (error) => error instanceof ChatSourceMessageMismatchError
  );
});

test("draft create and update races each have one CAS winner", async () => {
  const chat = await seedChat();
  const write = (expectedRevision: number, text: string) =>
    writeChatComposerDraft({
      userId: chat.userId,
      userEmail: chat.email,
      scopeKey: chat.conversationId,
      draft: { expectedRevision, text, attachmentReferences: [] },
    });

  const creates = await Promise.allSettled([write(0, "create-a"), write(0, "create-b")]);
  assert.equal(creates.filter((result) => result.status === "fulfilled").length, 1);
  const createFailure = creates.find((result) => result.status === "rejected");
  assert.ok(createFailure && createFailure.status === "rejected");
  assert.ok(createFailure.reason instanceof ChatDraftRevisionConflictError);
  const createWinner = creates.find((result) => result.status === "fulfilled");
  assert.ok(createWinner && createWinner.status === "fulfilled");
  assert.equal(createWinner.value.revision, 1);
  assert.ok(["create-a", "create-b"].includes(createWinner.value.text));

  const updates = await Promise.allSettled([write(1, "update-a"), write(1, "update-b")]);
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  const updateFailure = updates.find((result) => result.status === "rejected");
  assert.ok(updateFailure && updateFailure.status === "rejected");
  assert.ok(updateFailure.reason instanceof ChatDraftRevisionConflictError);
  const updateWinner = updates.find((result) => result.status === "fulfilled");
  assert.ok(updateWinner && updateWinner.status === "fulfilled");
  assert.equal(updateWinner.value.revision, 2);
  assert.ok(["update-a", "update-b"].includes(updateWinner.value.text));

  const row = await prisma.chatComposerDraft.findUniqueOrThrow({
    where: { userId_scopeKey: { userId: chat.userId, scopeKey: chat.conversationId } },
  });
  assert.equal(row.revision, 2);
  assert.ok(["update-a", "update-b"].includes(row.text));
  await assert.rejects(write(1, "stale"), (error) => {
    assert.ok(error instanceof ChatDraftRevisionConflictError, String(error));
    assert.equal(error.currentRevision, 2);
    return true;
  });

  // A follower starts as soon as PostgreSQL exposes revision 3. The first
  // writer must still return its own UPDATE ... RETURNING row rather than a
  // later SELECT that is allowed to observe the follower's revision 4.
  const primary = write(2, "returned-exact");
  const follower = (async () => {
    for (;;) {
      const visible = await prisma.chatComposerDraft.findUnique({
        where: {
          userId_scopeKey: {
            userId: chat.userId,
            scopeKey: chat.conversationId,
          },
        },
        select: { revision: true },
      });
      if (visible?.revision === 3) return write(3, "follower-write");
      await delay(1);
    }
  })();
  const [primaryResult, followerResult] = await Promise.all([primary, follower]);
  assert.equal(primaryResult.revision, 3);
  assert.equal(primaryResult.text, "returned-exact");
  assert.equal(followerResult.revision, 4);
  assert.equal(followerResult.text, "follower-write");
});

test("attempt CAS rejects stale owners, stale revisions and changed committed prefixes", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, { ownerId: "worker-owner" });
  await claimChatResponseAttempt(claimed);

  await expectAttemptCas(
    checkpointChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: "worker-stale",
      expectedRevision: 0,
      partialContent: "prefix",
    }),
    "owner_mismatch"
  );
  const checkpoint = await checkpointChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: claimed.assistantMessageId,
    ownerId: claimed.ownerId,
    expectedRevision: 0,
    partialContent: "prefix",
    actualModelId: "provider/model-a",
    provider: "provider",
  });
  assert.equal(checkpoint?.checkpointRevision, 1);

  await expectAttemptCas(
    checkpointChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: claimed.ownerId,
      expectedRevision: 0,
      partialContent: "prefix extended",
    }),
    "revision_conflict"
  );
  await expectAttemptCas(
    checkpointChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: claimed.ownerId,
      expectedRevision: 1,
      partialContent: "pref",
    }),
    "committed_prefix_changed"
  );
  await expectAttemptCas(
    terminalChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: claimed.ownerId,
      expectedRevision: 1,
      status: "completed",
      finalContent: "different",
      finishReason: "stop",
    }),
    "committed_prefix_changed"
  );

  const unchanged = await prisma.chatResponseAttempt.findUniqueOrThrow({
    where: { assistantMessageId: claimed.assistantMessageId },
  });
  assert.equal(unchanged.partialContent, "prefix");
  assert.equal(unchanged.checkpointRevision, 1);
});

test("DB clock rejects an expired lease even when the caller supplies a stale clock", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, {
    ownerId: "worker-clock",
    leaseExpiresAt: leaseAfter(1_200),
  });
  await claimChatResponseAttempt(claimed);
  await delay(1_500);

  await expectAttemptCas(
    checkpointChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: claimed.ownerId,
      expectedRevision: 0,
      partialContent: "must not commit",
      now: new Date(claimed.leaseExpiresAt.getTime() - 100),
    }),
    "revision_conflict"
  );
  const row = await prisma.chatResponseAttempt.findUniqueOrThrow({
    where: { assistantMessageId: claimed.assistantMessageId },
  });
  assert.equal(row.status, "claimed");
  assert.equal(row.checkpointRevision, 0);
  assert.equal(row.partialContent, "");
});

test("polling reconciles an expired active attempt to one terminal failure", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, {
    ownerId: "worker-expired",
    leaseExpiresAt: leaseAfter(1_200),
  });
  await claimChatResponseAttempt(claimed);
  await delay(1_500);
  const [first, second] = await Promise.all([
    readChatResponseAttempt(chat.userId, claimed.assistantMessageId),
    readChatResponseAttempt(chat.userId, claimed.assistantMessageId),
  ]);
  assert.equal(first?.status, "failed");
  assert.equal(second?.status, "failed");
  assert.equal(first?.failureCode, "worker_lease_expired");
  assert.equal(first?.checkpointRevision, 1);
  assert.equal(second?.checkpointRevision, 1);
});

test("scope-bound polling neither mutates nor returns a replacement conversation", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, {
    ownerId: "worker-wrong-scope",
    leaseExpiresAt: leaseAfter(1_200),
  });
  await claimChatResponseAttempt(claimed);
  await delay(1_500);

  const result = await readChatResponseAttempt(
    chat.userId,
    claimed.assistantMessageId,
    randomUUID()
  );
  assert.equal(result, null);
  const row = await prisma.chatResponseAttempt.findUniqueOrThrow({
    where: { assistantMessageId: claimed.assistantMessageId },
  });
  assert.equal(row.status, "claimed");
  assert.equal(row.failureCode, null);
  assert.equal(row.checkpointRevision, 0);
});

test("assistant Message and completed attempt commit or roll back together", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, { ownerId: "worker-atomic" });
  await claimChatResponseAttempt(claimed);
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: claimed.assistantMessageId,
          conversationId: chat.conversationId,
          role: "assistant",
          content: "atomic answer",
          modelId: "provider/model-a",
        },
      });
      await terminalChatResponseAttempt(
        {
          userId: chat.userId,
          assistantMessageId: claimed.assistantMessageId,
          ownerId: claimed.ownerId,
          expectedRevision: 0,
          status: "completed",
          finalContent: "atomic answer",
          actualModelId: "provider/model-a",
          provider: "provider",
          finishReason: "stop",
        },
        tx
      );
      throw new Error("ROLLBACK_TERMINAL_PAIR");
    }),
    /ROLLBACK_TERMINAL_PAIR/
  );
  assert.equal(
    await prisma.message.count({ where: { id: claimed.assistantMessageId } }),
    0
  );
  assert.equal(
    (await prisma.chatResponseAttempt.findUniqueOrThrow({
      where: { assistantMessageId: claimed.assistantMessageId },
    })).status,
    "claimed"
  );

  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        id: claimed.assistantMessageId,
        conversationId: chat.conversationId,
        role: "assistant",
        content: "atomic answer",
        modelId: "provider/model-a",
      },
    });
    await terminalChatResponseAttempt(
      {
        userId: chat.userId,
        assistantMessageId: claimed.assistantMessageId,
        ownerId: claimed.ownerId,
        expectedRevision: 0,
        status: "completed",
        finalContent: "atomic answer",
        actualModelId: "provider/model-a",
        provider: "provider",
        finishReason: "stop",
      },
      tx
    );
  });
  assert.equal(
    await prisma.message.count({ where: { id: claimed.assistantMessageId } }),
    1
  );
  assert.equal(
    (await prisma.chatResponseAttempt.findUniqueOrThrow({
      where: { assistantMessageId: claimed.assistantMessageId },
    })).status,
    "completed"
  );
});

test("a terminal attempt is immutable", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, { ownerId: "worker-terminal" });
  await claimChatResponseAttempt(claimed);
  for (const invalidStatus of ["streaming", "unknown"]) {
    await expectAttemptCas(
      terminalChatResponseAttempt({
        userId: chat.userId,
        assistantMessageId: claimed.assistantMessageId,
        ownerId: claimed.ownerId,
        expectedRevision: 0,
        status: invalidStatus as never,
        finalContent: "",
      }),
      "terminal_status_invalid"
    );
  }
  await checkpointChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: claimed.assistantMessageId,
    ownerId: claimed.ownerId,
    expectedRevision: 0,
    partialContent: "committed",
  });
  const terminal = await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: claimed.assistantMessageId,
    ownerId: claimed.ownerId,
    expectedRevision: 1,
    status: "completed",
    finalContent: "committed answer",
    finishReason: "stop",
  });
  assert.equal(terminal?.status, "completed");
  assert.equal(terminal?.checkpointRevision, 2);

  await expectAttemptCas(
    checkpointChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: claimed.ownerId,
      expectedRevision: 2,
      partialContent: "committed answer changed",
    }),
    "terminal"
  );
  await expectAttemptCas(
    terminalChatResponseAttempt({
      userId: chat.userId,
      assistantMessageId: claimed.assistantMessageId,
      ownerId: claimed.ownerId,
      expectedRevision: 2,
      status: "failed",
      finalContent: "committed answer",
      finishReason: "error",
      failureCode: "internal_error",
    }),
    "terminal"
  );
  const row = await prisma.chatResponseAttempt.findUniqueOrThrow({
    where: { assistantMessageId: claimed.assistantMessageId },
  });
  assert.equal(row.status, "completed");
  assert.equal(row.partialContent, "committed answer");
  assert.equal(row.finishReason, "stop");
  assert.equal(row.failureCode, null);
});

test("conversation discovery hides an empty pre-dispatch refusal after replacement but preserves other terminal evidence", async () => {
  const chat = await seedChat();
  const refused = claimInput(chat, {
    requestedModelId: "provider/model-a",
    ownerId: "worker-refused",
  });
  const replacement = claimInput(chat, {
    requestedModelId: "provider/model-a",
    ownerId: "worker-replacement",
  });
  const nonemptyFailure = claimInput(chat, {
    requestedModelId: "provider/model-b",
    ownerId: "worker-visible-failure",
  });
  await claimChatResponseAttempt(refused);
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: refused.assistantMessageId,
    ownerId: refused.ownerId,
    expectedRevision: 0,
    status: "failed",
    finalContent: "",
    finishReason: "error",
    failureCode: "request_refused",
  });
  await claimChatResponseAttempt(replacement);
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: replacement.assistantMessageId,
    ownerId: replacement.ownerId,
    expectedRevision: 0,
    status: "completed",
    finalContent: "replacement answer",
    finishReason: "stop",
  });
  await claimChatResponseAttempt(nonemptyFailure);
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: nonemptyFailure.assistantMessageId,
    ownerId: nonemptyFailure.ownerId,
    expectedRevision: 0,
    status: "failed",
    finalContent: "visible committed prefix",
    finishReason: "error",
    failureCode: "request_refused",
  });

  const listed = await listChatResponseAttempts({
    userId: chat.userId,
    conversationId: chat.conversationId,
  });
  assert.equal(
    listed.some((attempt) => attempt.assistantMessageId === refused.assistantMessageId),
    false
  );
  assert.equal(
    listed.some((attempt) => attempt.assistantMessageId === replacement.assistantMessageId),
    true
  );
  assert.equal(
    listed.some((attempt) => attempt.assistantMessageId === nonemptyFailure.assistantMessageId),
    true
  );
  const direct = await readChatResponseAttempt(
    chat.userId,
    refused.assistantMessageId
  );
  assert.equal(direct?.status, "failed");
  assert.equal(direct?.failureCode, "request_refused");
});

test("per-model cleanup and foreign-key cascades remove only their recovery state", async () => {
  const chat = await seedChat();
  const targetAssistantId = randomUUID();
  const otherAssistantId = randomUUID();
  await prisma.message.createMany({
    data: [
      {
        id: targetAssistantId,
        conversationId: chat.conversationId,
        role: "assistant",
        content: "target",
        modelId: "provider/model-a",
      },
      {
        id: otherAssistantId,
        conversationId: chat.conversationId,
        role: "assistant",
        content: "other",
        modelId: "provider/model-b",
      },
    ],
  });
  const target = claimInput(chat, {
    assistantMessageId: targetAssistantId,
    requestedModelId: "provider/model-a",
    ownerId: "worker-target",
  });
  const inFlight = claimInput(chat, {
    requestedModelId: "provider/model-a",
    ownerId: "worker-in-flight",
  });
  const terminalOrphan = claimInput(chat, {
    requestedModelId: "provider/model-a",
    ownerId: "worker-terminal-orphan",
  });
  const unrelated = claimInput(chat, {
    assistantMessageId: otherAssistantId,
    requestedModelId: "provider/model-b",
    ownerId: "worker-other",
  });
  await Promise.all([
    claimChatResponseAttempt(target),
    claimChatResponseAttempt(inFlight),
    claimChatResponseAttempt(terminalOrphan),
    claimChatResponseAttempt(unrelated),
  ]);
  await checkpointChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: target.assistantMessageId,
    ownerId: target.ownerId,
    expectedRevision: 0,
    partialContent: "target",
    actualModelId: "provider/model-a",
  });
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: target.assistantMessageId,
    ownerId: target.ownerId,
    expectedRevision: 1,
    status: "completed",
    finalContent: "target",
    finishReason: "stop",
  });
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: inFlight.assistantMessageId,
    ownerId: inFlight.ownerId,
    expectedRevision: 0,
    status: "cancelled",
    finalContent: "",
    finishReason: "cancelled",
  });
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: terminalOrphan.assistantMessageId,
    ownerId: terminalOrphan.ownerId,
    expectedRevision: 0,
    status: "cancelled",
    finalContent: "",
    finishReason: "cancelled",
  });
  await terminalChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: unrelated.assistantMessageId,
    ownerId: unrelated.ownerId,
    expectedRevision: 0,
    status: "completed",
    finalContent: "other",
    finishReason: "stop",
  });

  const removed = await prisma.$transaction(async (tx) => {
    const count = await deleteChatResponseAttemptsForModelHistory(tx, {
      userId: chat.userId,
      conversationId: chat.conversationId,
      modelId: "provider/model-a",
    });
    await tx.message.deleteMany({
      where: {
        conversationId: chat.conversationId,
        role: "assistant",
        modelId: "provider/model-a",
      },
    });
    return count;
  });
  assert.equal(removed, 3);
  assert.equal(
    await prisma.chatResponseAttempt.count({
      where: {
        assistantMessageId: {
          in: [
            target.assistantMessageId,
            inFlight.assistantMessageId,
            terminalOrphan.assistantMessageId,
          ],
        },
      },
    }),
    0
  );
  assert.ok(
    await prisma.chatResponseAttempt.findUnique({
      where: { assistantMessageId: unrelated.assistantMessageId },
    })
  );

  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: chat.conversationId,
    draft: { expectedRevision: 0, text: "stored scope", attachmentReferences: [] },
  });
  await prisma.message.delete({ where: { id: chat.sourceUserMessageId } });
  assert.equal(await prisma.chatResponseAttempt.count(), 0);
  assert.equal(await prisma.chatComposerDraft.count(), 1);
  await prisma.conversation.delete({ where: { id: chat.conversationId } });
  assert.equal(await prisma.chatComposerDraft.count(), 0);

  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: "new",
    draft: { expectedRevision: 0, text: "new scope", attachmentReferences: [] },
  });
  await prisma.user.delete({ where: { id: chat.userId } });
  assert.equal(await prisma.chatComposerDraft.count(), 0);
});

test("an active attempt for another model serialises with and refuses per-model history deletion", async () => {
  const chat = await seedChat();
  const claimed = claimInput(chat, {
    requestedModelId: "provider/model-b",
    ownerId: "worker-active",
  });
  await claimChatResponseAttempt(claimed);
  await assert.rejects(
    prisma.$transaction((tx) =>
      deleteChatResponseAttemptsForModelHistory(tx, {
        userId: chat.userId,
        conversationId: chat.conversationId,
        modelId: "provider/model-a",
      })
    ),
    (error) => error instanceof ActiveChatResponseAttemptError
  );
  assert.ok(
    await prisma.chatResponseAttempt.findUnique({
      where: { assistantMessageId: claimed.assistantMessageId },
    })
  );
});

test("claim and clear lock order yields either an active winner or an epoch-fenced stale claim", async () => {
  const chat = await seedChat();
  const input = claimInput(chat, {
    requestedModelId: "provider/model-race",
    ownerId: "worker-race",
  });
  const [claimResult, clearResult] = await Promise.allSettled([
    claimChatResponseAttempt(input),
    prisma.$transaction((tx) =>
      deleteChatResponseAttemptsForModelHistory(tx, {
        userId: chat.userId,
        conversationId: chat.conversationId,
        modelId: "provider/model-race",
      })
    ),
  ]);
  assert.notEqual(claimResult.status, clearResult.status);
  if (claimResult.status === "fulfilled") {
    assert.equal(clearResult.status, "rejected");
    if (clearResult.status !== "rejected") throw new Error("clear unexpectedly fulfilled");
    assert.ok(clearResult.reason instanceof ActiveChatResponseAttemptError);
    assert.ok(
      await prisma.chatResponseAttempt.findUnique({
        where: { assistantMessageId: input.assistantMessageId },
      })
    );
  } else {
    assert.ok(claimResult.reason instanceof ChatAttemptCasError);
    assert.equal(claimResult.reason.reason, "recovery_epoch_changed");
    assert.equal(clearResult.status, "fulfilled");
    if (clearResult.status !== "fulfilled") throw new Error("clear unexpectedly rejected");
    assert.equal(clearResult.value, 0);
    assert.equal(
      await prisma.chatResponseAttempt.count({
        where: { assistantMessageId: input.assistantMessageId },
      }),
      0
    );
    const fresh = await claimChatResponseAttempt({
      ...input,
      assistantMessageId: randomUUID(),
      ownerId: "worker-after-clear",
      expectedRecoveryEpoch: 1,
    });
    assert.equal(fresh.disposition, "claimed");
  }
});

test("a clear completed before claim fences the old epoch and permits a fresh request", async () => {
  const chat = await seedChat();
  const stale = claimInput(chat, {
    requestedModelId: "provider/model-cleared",
    ownerId: "worker-before-clear",
  });
  assert.equal(
    await prisma.$transaction((tx) =>
      deleteChatResponseAttemptsForModelHistory(tx, {
        userId: chat.userId,
        conversationId: chat.conversationId,
        modelId: "provider/model-cleared",
      })
    ),
    0
  );
  await expectAttemptCas(claimChatResponseAttempt(stale), "recovery_epoch_changed");
  const fresh = await claimChatResponseAttempt({
    ...stale,
    assistantMessageId: randomUUID(),
    ownerId: "worker-after-clear",
    expectedRecoveryEpoch: 1,
  });
  assert.equal(fresh.disposition, "claimed");
});

test("draft consumption rolls back with message failure and exact replay is idempotent", async () => {
  const chat = await seedChat();
  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: chat.conversationId,
    draft: { expectedRevision: 0, text: "atomic message", attachmentReferences: [] },
  });
  const message = { id: randomUUID(), content: "atomic message" };
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await consumeChatDraftForMessage(tx, {
        userId: chat.userId,
        conversationId: chat.conversationId,
        draftConsume: {
          scopeKey: chat.conversationId,
          expectedRevision: 1,
          messageId: message.id,
        },
        message,
      });
      throw new Error("ROLLBACK_AFTER_DRAFT_CONSUME");
    }),
    /ROLLBACK_AFTER_DRAFT_CONSUME/
  );
  assert.ok(
    await prisma.chatComposerDraft.findUnique({
      where: {
        userId_scopeKey: { userId: chat.userId, scopeKey: chat.conversationId },
      },
    })
  );

  await prisma.$transaction(async (tx) => {
    const result = await consumeChatDraftForMessage(tx, {
      userId: chat.userId,
      conversationId: chat.conversationId,
      draftConsume: {
        scopeKey: chat.conversationId,
        expectedRevision: 1,
        messageId: message.id,
      },
      message,
    });
    assert.equal(result.replay, false);
    await tx.message.create({
      data: {
        id: message.id,
        conversationId: chat.conversationId,
        role: "user",
        content: message.content,
      },
    });
  });
  assert.equal(await prisma.chatComposerDraft.count(), 0);

  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: chat.conversationId,
    draft: { expectedRevision: 0, text: "newer unsent draft", attachmentReferences: [] },
  });
  await prisma.$transaction(async (tx) => {
    const result = await consumeChatDraftForMessage(tx, {
      userId: chat.userId,
      conversationId: chat.conversationId,
      draftConsume: {
        scopeKey: chat.conversationId,
        expectedRevision: 1,
        messageId: message.id,
      },
      message,
    });
    assert.equal(result.replay, true);
  });
  assert.equal(
    (
      await prisma.chatComposerDraft.findUniqueOrThrow({
        where: {
          userId_scopeKey: { userId: chat.userId, scopeKey: chat.conversationId },
        },
      })
    ).text,
    "newer unsent draft"
  );
  await assert.rejects(
    prisma.$transaction((tx) =>
      consumeChatDraftForMessage(tx, {
        userId: chat.userId,
        conversationId: chat.conversationId,
        draftConsume: {
          scopeKey: chat.conversationId,
          expectedRevision: 1,
          messageId: message.id,
        },
        message: { ...message, content: "altered" },
      })
    ),
    (error) => error instanceof ChatDraftConsumeConflictError
  );
});

test("message receipt distinguishes committed, unchanged and ambiguous under the recovery lock", async () => {
  const chat = await seedChat();
  const messageId = randomUUID();
  const receipt = {
    draftConsume: {
      scopeKey: chat.conversationId,
      expectedRevision: 1,
      messageId,
    },
    message: { id: messageId, content: "receipt question" },
  };
  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: chat.conversationId,
    draft: {
      expectedRevision: 0,
      text: "receipt question",
      attachmentReferences: [],
    },
  });
  assert.equal(
    (await reconcileChatDraftMessageReceipt({
      userId: chat.userId,
      conversationId: chat.conversationId,
      receipt,
    })).outcome,
    "unchanged"
  );

  await prisma.$transaction(async (tx) => {
    await consumeChatDraftForMessage(tx, {
      userId: chat.userId,
      conversationId: chat.conversationId,
      draftConsume: receipt.draftConsume,
      message: receipt.message,
    });
    await tx.message.create({
      data: {
        id: messageId,
        conversationId: chat.conversationId,
        role: "user",
        content: receipt.message.content,
      },
    });
  });
  assert.equal(
    (await reconcileChatDraftMessageReceipt({
      userId: chat.userId,
      conversationId: chat.conversationId,
      receipt,
    })).outcome,
    "committed"
  );

  assert.equal(
    (await reconcileChatDraftMessageReceipt({
      userId: chat.userId,
      conversationId: chat.conversationId,
      receipt: {
        ...receipt,
        message: { ...receipt.message, content: "not the committed bytes" },
      },
    })).outcome,
    "ambiguous"
  );
});

test("a foreign Message UUID is indistinguishable from a missing receipt UUID", async () => {
  const owner = await seedChat("receipt-owner");
  const other = await seedChat("receipt-other");
  const missingMessageId = randomUUID();
  const content = "The owner's unchanged draft is the only visible evidence.";
  await writeChatComposerDraft({
    userId: owner.userId,
    userEmail: owner.email,
    scopeKey: owner.conversationId,
    draft: {
      expectedRevision: 0,
      text: content,
      attachmentReferences: [],
    },
  });
  const resultFor = (messageId: string) => reconcileChatDraftMessageReceipt({
    userId: owner.userId,
    conversationId: owner.conversationId,
    receipt: {
      draftConsume: {
        scopeKey: owner.conversationId,
        expectedRevision: 1,
        messageId,
      },
      message: { id: messageId, content },
    },
  });

  const foreign = await resultFor(other.sourceUserMessageId);
  const missing = await resultFor(missingMessageId);
  assert.deepEqual(foreign, { outcome: "unchanged", attachments: [] });
  assert.deepEqual(foreign, missing);
});

test("an unchanged receipt does not prevent the original attachment transaction from committing later", async () => {
  const chat = await seedChat();
  const messageId = randomUUID();
  const receipt = {
    draftConsume: {
      scopeKey: chat.conversationId,
      expectedRevision: 1,
      messageId,
    },
    message: { id: messageId, content: "copy still outside the lock" },
  };
  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: chat.conversationId,
    draft: {
      expectedRevision: 0,
      text: receipt.message.content,
      attachmentReferences: [],
    },
  });

  // This is the ordering of the attachment path: expensive object copying
  // can still be in flight before its transaction takes the advisory lock.
  // A transport-timeout receipt may therefore observe unchanged first.
  assert.equal(
    (await reconcileChatDraftMessageReceipt({
      userId: chat.userId,
      conversationId: chat.conversationId,
      receipt,
    })).outcome,
    "unchanged"
  );
  await prisma.$transaction(async (tx) => {
    await consumeChatDraftForMessage(tx, {
      userId: chat.userId,
      conversationId: chat.conversationId,
      draftConsume: receipt.draftConsume,
      message: receipt.message,
    });
    await tx.message.create({
      data: {
        id: messageId,
        conversationId: chat.conversationId,
        role: "user",
        content: receipt.message.content,
      },
    });
  });
  assert.equal(
    (await reconcileChatDraftMessageReceipt({
      userId: chat.userId,
      conversationId: chat.conversationId,
      receipt,
    })).outcome,
    "committed"
  );
});

test("exact draft-consume replay compares attachment provenance, not matching metadata", async () => {
  const chat = await seedChat();
  const sourceMessageB = randomUUID();
  const targetMessage = randomUUID();
  await prisma.message.createMany({
    data: [
      {
        id: sourceMessageB,
        conversationId: chat.conversationId,
        role: "user",
        content: "second source",
      },
      {
        id: targetMessage,
        conversationId: chat.conversationId,
        role: "user",
        content: "carried file",
      },
    ],
  });
  const uploadData = (suffix: string) => ({
    userId: chat.userId,
    objectKey: `${chat.userId}/replay-${suffix}`,
    name: "identical.txt",
    mediaType: "text/plain",
    size: 7,
    kind: "text",
  });
  const [uploadA, uploadB, carriedUpload] = await Promise.all([
    prisma.messageAttachmentUpload.create({ data: uploadData("a") }),
    prisma.messageAttachmentUpload.create({ data: uploadData("b") }),
    prisma.messageAttachmentUpload.create({ data: uploadData("carried") }),
  ]);
  const attachmentA = await prisma.messageAttachment.create({
    data: {
      ...uploadData("a"),
      messageId: chat.sourceUserMessageId,
      conversationId: chat.conversationId,
      ordinal: 0,
      uploadId: uploadA.id,
      objectKey: uploadA.objectKey,
    },
  });
  const attachmentB = await prisma.messageAttachment.create({
    data: {
      ...uploadData("b"),
      messageId: sourceMessageB,
      conversationId: chat.conversationId,
      ordinal: 0,
      uploadId: uploadB.id,
      objectKey: uploadB.objectKey,
    },
  });
  await prisma.messageAttachment.create({
    data: {
      ...uploadData("carried"),
      messageId: targetMessage,
      conversationId: chat.conversationId,
      ordinal: 0,
      uploadId: carriedUpload.id,
      objectKey: carriedUpload.objectKey,
      sourceAttachmentId: attachmentA.id,
    },
  });
  const exactInput = {
    userId: chat.userId,
    conversationId: chat.conversationId,
    draftConsume: {
      scopeKey: chat.conversationId,
      expectedRevision: 1,
      messageId: targetMessage,
    },
    message: {
      id: targetMessage,
      content: "carried file",
      attachmentReferences: [{ attachmentId: attachmentA.id }],
    },
  };
  assert.deepEqual(
    await prisma.$transaction((tx) => consumeChatDraftForMessage(tx, exactInput)),
    { replay: true }
  );
  await assert.rejects(
    prisma.$transaction((tx) =>
      consumeChatDraftForMessage(tx, {
        ...exactInput,
        message: {
          ...exactInput.message,
          attachmentReferences: [{ attachmentId: attachmentB.id }],
        },
      })
    ),
    (error) => error instanceof ChatDraftConsumeConflictError
  );
});

test("the server transaction atomically consumes a new-scope draft with its first stored Message", async () => {
  const chat = await seedChat();
  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: "new",
    draft: { expectedRevision: 0, text: "adopt me", attachmentReferences: [] },
  });
  const messageId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await consumeChatDraftForMessage(tx, {
      userId: chat.userId,
      conversationId: chat.conversationId,
      draftConsume: { scopeKey: "new", expectedRevision: 1, messageId },
      message: { id: messageId, content: "adopt me" },
    });
    await tx.message.create({
      data: {
        id: messageId,
        conversationId: chat.conversationId,
        role: "user",
        content: "adopt me",
      },
    });
  });
  assert.equal(
    await prisma.chatComposerDraft.count({ where: { userId: chat.userId, scopeKey: "new" } }),
    0
  );
});

test("account export exposes recovery content but not execution internals", async () => {
  const chat = await seedChat();
  await writeChatComposerDraft({
    userId: chat.userId,
    userEmail: chat.email,
    scopeKey: chat.conversationId,
    draft: { expectedRevision: 0, text: "unsent words", attachmentReferences: [] },
  });
  const claimed = claimInput(chat, { ownerId: "private-worker" });
  await claimChatResponseAttempt(claimed);
  await checkpointChatResponseAttempt({
    userId: chat.userId,
    assistantMessageId: claimed.assistantMessageId,
    ownerId: claimed.ownerId,
    expectedRevision: 0,
    partialContent: "visible prefix",
    actualModelId: "provider/model-a",
    provider: "provider",
  });

  const { data } = await buildAccountDataExport(chat.userId);
  const drafts = data.chat_composer_drafts as Array<Record<string, unknown>>;
  assert.deepEqual(drafts, [
    {
      scopeKey: chat.conversationId,
      text: "unsent words",
      revision: 1,
      createdAt: drafts[0]?.createdAt,
      updatedAt: drafts[0]?.updatedAt,
    },
  ]);
  const attempts = data.chat_response_attempts as Array<Record<string, unknown>>;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.partialContent, "visible prefix");
  assert.equal(attempts[0]?.actualModelId, "provider/model-a");
  for (const privateField of ["fingerprint", "ownerId", "leaseExpiresAt"]) {
    assert.equal(Object.hasOwn(attempts[0] ?? {}, privateField), false);
  }
});
