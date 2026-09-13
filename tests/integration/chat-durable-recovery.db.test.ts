import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, beforeEach, test } from "node:test";

import { buildAccountDataExport } from "@/lib/accountDataExport";
import {
  ChatDraftRevisionConflictError,
  writeChatComposerDraft,
} from "@/lib/chatComposerDraftPersistence";
import { deleteChatResponseAttemptsForModelHistory } from "@/lib/chatResponseAttemptDeletion";
import {
  ChatAttemptCasError,
  ChatAttemptIdentityConflictError,
  checkpointChatResponseAttempt,
  claimChatResponseAttempt,
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
  return { userId, email, conversationId, sourceUserMessageId };
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

  const updates = await Promise.allSettled([write(1, "update-a"), write(1, "update-b")]);
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  const updateFailure = updates.find((result) => result.status === "rejected");
  assert.ok(updateFailure && updateFailure.status === "rejected");
  assert.ok(updateFailure.reason instanceof ChatDraftRevisionConflictError);

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
    assistantMessageId: terminalOrphan.assistantMessageId,
    ownerId: terminalOrphan.ownerId,
    expectedRevision: 0,
    status: "cancelled",
    finalContent: "",
    finishReason: "cancelled",
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
