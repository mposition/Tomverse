import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";

import {
  PERSISTED_ARTIFACT_STATUSES,
  SUPPORTED_ARTIFACT_FORMATS,
} from "@/lib/generatedArtifactCore";
import {
  enqueueArtifactCleanupForConversations,
  enqueueArtifactCleanupForMessages,
  enqueueArtifactCleanupForUser,
  persistArtifactRows,
} from "@/lib/generatedArtifactStorage";
import { prisma } from "@/lib/prisma";

/**
 * The half of the artifact contract only a real database can answer.
 *
 * docs/policy/generated-artifacts.md sections 5 and 8. Three things are being
 * checked, and none of them can be checked without Postgres:
 *
 *   * the CHECK constraints -- including the pairing that makes "a `ready`
 *     row always has a file" true by construction rather than by convention;
 *   * the unique index that turns a replayed tool call into a no-op instead
 *     of a second copy of the same file;
 *   * that every deletion path leaves a tombstone *before* the cascade takes
 *     the rows it would have read the keys from.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MessageArtifactCleanup",
      "MessageArtifact",
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);

const seed = async () => {
  const userId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  await prisma.user.create({
    data: { id: userId, email: `${userId}@example.invalid` },
  });
  await prisma.conversation.create({
    data: { id: conversationId, userId, title: "Quarterly revenue" },
  });
  await prisma.message.create({
    data: {
      id: messageId,
      conversationId,
      role: "assistant",
      content: "Here is the file.",
      modelId: "gpt-5-6-luna",
    },
  });
  return { userId, conversationId, messageId };
};

const readyRow = (
  ids: { userId: string; conversationId: string; messageId: string },
  overrides: Record<string, unknown> = {}
) => ({
  messageId: ids.messageId,
  conversationId: ids.conversationId,
  userId: ids.userId,
  ordinal: 0,
  format: "xlsx",
  filename: "분기별_매출.xlsx",
  mediaType:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  byteSize: 3053,
  status: "ready",
  objectKey: `message-artifacts/${ids.userId}/${ids.conversationId}/${randomUUID()}.xlsx`,
  modelId: "gpt-5-6-luna",
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Constraints                                                                  */
/* -------------------------------------------------------------------------- */

test("the format CHECK matches the formats a generator exists for", async () => {
  const ids = await seed();
  for (const format of SUPPORTED_ARTIFACT_FORMATS) {
    await prisma.messageArtifact.create({
      data: readyRow(ids, {
        format,
        ordinal: SUPPORTED_ARTIFACT_FORMATS.indexOf(format),
      }),
    });
  }
  await assert.rejects(
    prisma.messageArtifact.create({
      data: readyRow(ids, { format: "docx", ordinal: 9 }),
    })
  );
});

test("the status CHECK matches the statuses a row can hold", async () => {
  const ids = await seed();
  assert.deepEqual([...PERSISTED_ARTIFACT_STATUSES], ["ready", "failed"]);
  // `blocked` is a live-stream state for a guest; there is no account to
  // write a row under, so the database must refuse it.
  await assert.rejects(
    prisma.messageArtifact.create({
      data: readyRow(ids, { status: "blocked", objectKey: null, byteSize: 0 }),
    })
  );
});

test("a ready row cannot exist without a file behind it", async () => {
  const ids = await seed();
  await assert.rejects(
    prisma.messageArtifact.create({
      data: readyRow(ids, { objectKey: null }),
    }),
    "a ready row with no object key must be refused"
  );
  await assert.rejects(
    prisma.messageArtifact.create({
      data: readyRow(ids, { byteSize: 0 }),
    }),
    "a ready row with no bytes must be refused"
  );
});

test("a failed row cannot carry an object key nothing will collect", async () => {
  const ids = await seed();
  await assert.rejects(
    prisma.messageArtifact.create({
      data: readyRow(ids, { status: "failed", byteSize: 0 }),
    })
  );
  const failed = await prisma.messageArtifact.create({
    data: readyRow(ids, {
      status: "failed",
      byteSize: 0,
      objectKey: null,
      failureCode: "generation_failed",
    }),
  });
  assert.equal(failed.status, "failed");
});

test("two artifacts cannot share a message position", async () => {
  const ids = await seed();
  await prisma.messageArtifact.create({ data: readyRow(ids) });
  await assert.rejects(
    prisma.messageArtifact.create({ data: readyRow(ids) })
  );
});

test("an object key belongs to exactly one row", async () => {
  const ids = await seed();
  const first = readyRow(ids);
  await prisma.messageArtifact.create({ data: first });
  await assert.rejects(
    prisma.messageArtifact.create({
      data: readyRow(ids, { ordinal: 1, objectKey: first.objectKey }),
    })
  );
});

/* -------------------------------------------------------------------------- */
/* Persisting                                                                   */
/* -------------------------------------------------------------------------- */

test("a replayed persist converges on the same rows", async () => {
  // What the streaming route does if its transaction is retried: the unique
  // index makes the second write a no-op rather than a second file.
  const ids = await seed();
  const stored = [
    {
      id: randomUUID(),
      ordinal: 0,
      format: "xlsx" as const,
      filename: "분기별_매출.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 3053,
      objectKey: `message-artifacts/${ids.userId}/${ids.conversationId}/a.xlsx`,
      modelId: "gpt-5-6-luna",
    },
  ];
  const write = () =>
    prisma.$transaction((tx) =>
      persistArtifactRows(tx, {
        messageId: ids.messageId,
        conversationId: ids.conversationId,
        userId: ids.userId,
        stored,
        failed: [],
      })
    );

  assert.equal(await write(), 1);
  assert.equal(await write(), 0);
  assert.equal(
    await prisma.messageArtifact.count({ where: { messageId: ids.messageId } }),
    1
  );
});

test("a failed artifact is recorded so a reload still shows what was attempted", async () => {
  const ids = await seed();
  await prisma.$transaction((tx) =>
    persistArtifactRows(tx, {
      messageId: ids.messageId,
      conversationId: ids.conversationId,
      userId: ids.userId,
      stored: [],
      failed: [
        {
          ordinal: 0,
          format: "xlsx",
          filename: "분기별_매출.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          failureCode: "generation_failed",
          modelId: "gpt-5-6-luna",
        },
      ],
    })
  );
  const row = await prisma.messageArtifact.findFirstOrThrow({
    where: { messageId: ids.messageId },
  });
  assert.equal(row.status, "failed");
  assert.equal(row.objectKey, null);
  assert.equal(row.failureCode, "generation_failed");
});

/* -------------------------------------------------------------------------- */
/* Deletion                                                                     */
/* -------------------------------------------------------------------------- */

const keysInCleanup = async () =>
  (
    await prisma.messageArtifactCleanup.findMany({
      select: { objectKey: true, reason: true },
      orderBy: { objectKey: "asc" },
    })
  ).map((row) => `${row.reason}:${row.objectKey}`);

test("deleting a conversation tombstones its objects in the same transaction", async () => {
  const ids = await seed();
  const row = await prisma.messageArtifact.create({ data: readyRow(ids) });

  await prisma.$transaction(async (tx) => {
    // Before the delete: after it there is nothing left to read the keys from.
    await enqueueArtifactCleanupForConversations(tx, [ids.conversationId]);
    await tx.conversation.delete({ where: { id: ids.conversationId } });
  });

  assert.deepEqual(await keysInCleanup(), [
    `conversation_deleted:${row.objectKey}`,
  ]);
  assert.equal(await prisma.messageArtifact.count(), 0);
});

test("deleting an account tombstones every file it owns", async () => {
  const ids = await seed();
  const row = await prisma.messageArtifact.create({ data: readyRow(ids) });

  await prisma.$transaction(async (tx) => {
    await enqueueArtifactCleanupForUser(tx, ids.userId);
    await tx.user.delete({ where: { id: ids.userId } });
  });

  assert.deepEqual(await keysInCleanup(), [`account_deleted:${row.objectKey}`]);
  assert.equal(await prisma.messageArtifact.count(), 0);
});

test("resetting one model's messages tombstones only that model's files", async () => {
  const ids = await seed();
  const kept = await prisma.message.create({
    data: {
      conversationId: ids.conversationId,
      role: "assistant",
      content: "Another model's answer.",
      modelId: "claude-sonnet-5",
    },
  });
  const removed = await prisma.messageArtifact.create({ data: readyRow(ids) });
  const survivor = await prisma.messageArtifact.create({
    data: readyRow(ids, { messageId: kept.id, modelId: "claude-sonnet-5" }),
  });

  await prisma.$transaction(async (tx) => {
    await enqueueArtifactCleanupForMessages(tx, {
      conversationId: ids.conversationId,
      modelId: "gpt-5-6-luna",
      role: "assistant",
    });
    await tx.message.deleteMany({
      where: {
        conversationId: ids.conversationId,
        modelId: "gpt-5-6-luna",
        role: "assistant",
      },
    });
  });

  assert.deepEqual(await keysInCleanup(), [`message_deleted:${removed.objectKey}`]);
  const remaining = await prisma.messageArtifact.findMany();
  assert.deepEqual(
    remaining.map((row) => row.id),
    [survivor.id]
  );
});

test("re-deleting the same conversation does not fail on the tombstone", async () => {
  // A retried request must converge rather than collide on the unique key.
  const ids = await seed();
  await prisma.messageArtifact.create({ data: readyRow(ids) });
  await prisma.$transaction((tx) =>
    enqueueArtifactCleanupForConversations(tx, [ids.conversationId])
  );
  await prisma.$transaction((tx) =>
    enqueueArtifactCleanupForConversations(tx, [ids.conversationId])
  );
  assert.equal(await prisma.messageArtifactCleanup.count(), 1);
});

test("a failed artifact contributes no tombstone", async () => {
  // There is nothing stored, so a key would be a key nothing could collect.
  const ids = await seed();
  await prisma.messageArtifact.create({
    data: readyRow(ids, {
      status: "failed",
      byteSize: 0,
      objectKey: null,
      failureCode: "generation_failed",
    }),
  });
  await prisma.$transaction((tx) =>
    enqueueArtifactCleanupForConversations(tx, [ids.conversationId])
  );
  assert.equal(await prisma.messageArtifactCleanup.count(), 0);
});

test("deleting the message alone takes its artifacts with it", async () => {
  const ids = await seed();
  await prisma.messageArtifact.create({ data: readyRow(ids) });
  await prisma.message.delete({ where: { id: ids.messageId } });
  assert.equal(await prisma.messageArtifact.count(), 0);
});
