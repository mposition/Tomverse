import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";

import { PUBLIC_MESSAGE_ATTACHMENT_SELECT } from "@/lib/messageAttachmentCore";
import {
  MessageAttachmentBindError,
  MessageAttachmentResolveError,
  accountAttachmentPrefix,
  bindMessageAttachments,
  enqueueMessageAttachmentCleanupForConversations,
  enqueueMessageAttachmentCleanupForMessages,
  enqueueMessageAttachmentCleanupForUser,
  resolveMessageAttachmentReferences,
} from "@/lib/messageAttachmentStorage";
import { prisma } from "@/lib/prisma";

/**
 * The half of the attachment contract only a real database can answer.
 *
 * docs/policy/user-attachment-persistence.md. Four things, and none of them
 * can be checked without Postgres:
 *
 *   * the unique index that turns a re-posted pre-save into a no-op instead of
 *     a second card for the same file;
 *   * that a resolution scoped by `userId` genuinely cannot reach another
 *     account's upload, whatever id is presented;
 *   * that every deletion path leaves a tombstone *before* the cascade takes
 *     the rows it would have read the keys from;
 *   * that clearing one model's answers leaves the question's files alone,
 *     because the attachment belongs to the user message every model in the
 *     comparison shares.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MessageAttachmentCleanup",
      "MessageAttachment",
      "MessageAttachmentUpload",
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Seeded = {
  userId: string;
  email: string;
  prefix: string;
  conversationId: string;
  promptMessageId: string;
};

const seed = async (): Promise<Seeded> => {
  const userId = randomUUID();
  const email = `${userId}@example.invalid`;
  const conversationId = randomUUID();
  const promptMessageId = randomUUID();
  await prisma.user.create({ data: { id: userId, email } });
  await prisma.conversation.create({
    data: { id: conversationId, userId, title: "근로계약서" },
  });
  await prisma.message.create({
    data: {
      id: promptMessageId,
      conversationId,
      role: "user",
      // A file-only turn: empty, not the file names joined with commas.
      content: "",
    },
  });
  return {
    userId,
    email,
    prefix: accountAttachmentPrefix(email),
    conversationId,
    promptMessageId,
  };
};

const upload = async (
  seeded: Seeded,
  overrides: Partial<{ name: string; mediaType: string; size: number }> = {}
) =>
  prisma.messageAttachmentUpload.create({
    data: {
      userId: seeded.userId,
      name: overrides.name ?? "계약서양식.docx",
      mediaType: overrides.mediaType ?? DOCX,
      size: overrides.size ?? 2048,
      kind: "file",
      objectKey: `${seeded.prefix}2026-08-22/${randomUUID()}-template.docx`,
    },
  });

/* -------------------------------------------------------------------------- */
/* Binding                                                                      */
/* -------------------------------------------------------------------------- */

test("a message and its attachments are written in one transaction", async () => {
  const seeded = await seed();
  const first = await upload(seeded, { name: "a.docx" });
  const second = await upload(seeded, { name: "b.docx" });

  const bound = await prisma.$transaction((tx) =>
    bindMessageAttachments(tx, {
      userId: seeded.userId,
      ownPrefix: seeded.prefix,
      conversationId: seeded.conversationId,
      messageId: seeded.promptMessageId,
      uploadIds: [first.id, second.id],
    })
  );

  assert.equal(bound, 2);
  const rows = await prisma.messageAttachment.findMany({
    where: { messageId: seeded.promptMessageId },
    orderBy: { ordinal: "asc" },
  });
  assert.deepEqual(
    rows.map((row) => [row.ordinal, row.name]),
    [
      [0, "a.docx"],
      [1, "b.docx"],
    ]
  );
  // The size stored is the one the finalisation step measured, not a claim.
  assert.equal(rows[0].size, 2048);
  assert.equal(rows[0].objectKey, first.objectKey);
});

// The idempotency key. A retried fetch, a double submit, a re-posted save --
// all of them write the same (messageId, ordinal) and get the same rows back.
test("re-binding the same message produces no duplicate rows", async () => {
  const seeded = await seed();
  const only = await upload(seeded);

  const bind = () =>
    prisma.$transaction((tx) =>
      bindMessageAttachments(tx, {
        userId: seeded.userId,
        ownPrefix: seeded.prefix,
        conversationId: seeded.conversationId,
        messageId: seeded.promptMessageId,
        uploadIds: [only.id],
      })
    );

  assert.equal(await bind(), 1);
  assert.equal(await bind(), 0);
  assert.equal(
    await prisma.messageAttachment.count({
      where: { messageId: seeded.promptMessageId },
    }),
    1
  );
});

test("one stored object cannot be bound to two different messages", async () => {
  const seeded = await seed();
  const only = await upload(seeded);
  const second = randomUUID();
  await prisma.message.create({
    data: {
      id: second,
      conversationId: seeded.conversationId,
      role: "user",
      content: "다시",
    },
  });

  await prisma.$transaction((tx) =>
    bindMessageAttachments(tx, {
      userId: seeded.userId,
      ownPrefix: seeded.prefix,
      conversationId: seeded.conversationId,
      messageId: seeded.promptMessageId,
      uploadIds: [only.id],
    })
  );
  // Reported, not swallowed. `skipDuplicates` would turn the unique index
  // into a silent no-op: the second message would save, and the file it
  // claimed to carry would simply not be there.
  await assert.rejects(
    prisma.$transaction((tx) =>
      bindMessageAttachments(tx, {
        userId: seeded.userId,
        ownPrefix: seeded.prefix,
        conversationId: seeded.conversationId,
        messageId: second,
        uploadIds: [only.id],
      })
    ),
    (error: unknown) =>
      error instanceof MessageAttachmentBindError &&
      error.code === "ATTACHMENT_ALREADY_BOUND"
  );
  assert.equal(
    await prisma.messageAttachment.count({ where: { messageId: second } }),
    0
  );
});

test("another account's upload cannot be bound", async () => {
  const mine = await seed();
  const theirs = await seed();
  const stranger = await upload(theirs);

  await assert.rejects(
    prisma.$transaction((tx) =>
      bindMessageAttachments(tx, {
        userId: mine.userId,
        ownPrefix: mine.prefix,
        conversationId: mine.conversationId,
        messageId: mine.promptMessageId,
        uploadIds: [stranger.id],
      })
    ),
    (error: unknown) =>
      error instanceof MessageAttachmentBindError &&
      error.code === "ATTACHMENT_UPLOAD_FORBIDDEN"
  );
  assert.equal(await prisma.messageAttachment.count(), 0);
});

test("an upload id that does not exist is refused, not skipped", async () => {
  const seeded = await seed();
  await assert.rejects(
    prisma.$transaction((tx) =>
      bindMessageAttachments(tx, {
        userId: seeded.userId,
        ownPrefix: seeded.prefix,
        conversationId: seeded.conversationId,
        messageId: seeded.promptMessageId,
        uploadIds: [randomUUID()],
      })
    ),
    (error: unknown) =>
      error instanceof MessageAttachmentBindError &&
      error.code === "UNKNOWN_ATTACHMENT_UPLOAD"
  );
});

/* -------------------------------------------------------------------------- */
/* Resolution                                                                   */
/* -------------------------------------------------------------------------- */

const bindOne = async (seeded: Seeded) => {
  const only = await upload(seeded);
  await prisma.$transaction((tx) =>
    bindMessageAttachments(tx, {
      userId: seeded.userId,
      ownPrefix: seeded.prefix,
      conversationId: seeded.conversationId,
      messageId: seeded.promptMessageId,
      uploadIds: [only.id],
    })
  );
  const row = await prisma.messageAttachment.findFirstOrThrow({
    where: { messageId: seeded.promptMessageId },
  });
  return { upload: only, attachment: row };
};

test("a later turn resolves the attachment id back to its private key", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);

  const [resolved] = await resolveMessageAttachmentReferences({
    userId: seeded.userId,
    ownPrefix: seeded.prefix,
    conversationId: seeded.conversationId,
    references: [{ attachmentId: attachment.id }],
  });
  assert.equal(resolved.objectKey, attachment.objectKey);
  assert.equal(resolved.mediaType, DOCX);
  assert.equal(resolved.size, 2048);
});

// Ownership is part of the query, so another account's id is "not found"
// rather than "forbidden" -- there is no branch that could report the
// difference.
test("another account's attachment id resolves to nothing", async () => {
  const mine = await seed();
  const theirs = await seed();
  const { attachment } = await bindOne(theirs);

  await assert.rejects(
    resolveMessageAttachmentReferences({
      userId: mine.userId,
      ownPrefix: mine.prefix,
      conversationId: mine.conversationId,
      references: [{ attachmentId: attachment.id }],
    }),
    (error: unknown) =>
      error instanceof MessageAttachmentResolveError &&
      error.code === "ATTACHMENT_NOT_FOUND"
  );
});

test("another account's upload id resolves to nothing either", async () => {
  const mine = await seed();
  const theirs = await seed();
  const stranger = await upload(theirs);

  await assert.rejects(
    resolveMessageAttachmentReferences({
      userId: mine.userId,
      ownPrefix: mine.prefix,
      conversationId: mine.conversationId,
      references: [{ uploadId: stranger.id }],
    }),
    (error: unknown) =>
      error instanceof MessageAttachmentResolveError &&
      error.code === "ATTACHMENT_NOT_FOUND"
  );
});

test("an attachment from another conversation is not carried forward", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);
  const otherConversation = randomUUID();
  await prisma.conversation.create({
    data: { id: otherConversation, userId: seeded.userId, title: "다른 대화" },
  });

  await assert.rejects(
    resolveMessageAttachmentReferences({
      userId: seeded.userId,
      ownPrefix: seeded.prefix,
      conversationId: otherConversation,
      references: [{ attachmentId: attachment.id }],
    }),
    (error: unknown) =>
      error instanceof MessageAttachmentResolveError &&
      error.code === "ATTACHMENT_NOT_FOUND"
  );
});

/* -------------------------------------------------------------------------- */
/* What the conversation read may say                                           */
/* -------------------------------------------------------------------------- */

test("the public select returns no storage key and no owner", async () => {
  const seeded = await seed();
  await bindOne(seeded);

  const rows = await prisma.messageAttachment.findMany({
    where: { messageId: seeded.promptMessageId },
    select: PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  });
  const serialised = JSON.stringify(rows);
  assert.equal(serialised.includes("attachments/"), false);
  assert.equal(serialised.includes(seeded.userId), false);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "id",
    "kind",
    "mediaType",
    "name",
    "ordinal",
    "size",
  ]);
});

test("a file-only message is stored with empty content, not with file names", async () => {
  const seeded = await seed();
  await bindOne(seeded);
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: seeded.promptMessageId },
  });
  assert.equal(message.content, "");
  assert.equal(message.content.includes(".docx"), false);
});

/* -------------------------------------------------------------------------- */
/* Deletion                                                                     */
/* -------------------------------------------------------------------------- */

test("deleting a conversation enqueues its attachment objects before the cascade", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);

  await prisma.$transaction(async (tx) => {
    await enqueueMessageAttachmentCleanupForConversations(tx, [
      seeded.conversationId,
    ]);
    await tx.conversation.delete({ where: { id: seeded.conversationId } });
  });

  assert.equal(await prisma.messageAttachment.count(), 0);
  const tombstones = await prisma.messageAttachmentCleanup.findMany();
  assert.deepEqual(
    tombstones.map((row) => [row.objectKey, row.reason, row.completedAt]),
    [[attachment.objectKey, "conversation_deleted", null]]
  );
});

test("deleting an account enqueues sent files and unsent uploads alike", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);
  // An upload the person finalised and never sent. No conversation names it,
  // so a conversation-shaped sweep would never have reached it.
  const abandoned = await upload(seeded, { name: "안 보낸 파일.docx" });

  await prisma.$transaction(async (tx) => {
    await enqueueMessageAttachmentCleanupForUser(tx, seeded.userId);
    await tx.user.delete({ where: { id: seeded.userId } });
  });

  const tombstones = await prisma.messageAttachmentCleanup.findMany({
    orderBy: { objectKey: "asc" },
  });
  assert.deepEqual(
    tombstones.map((row) => row.objectKey).sort(),
    [attachment.objectKey, abandoned.objectKey].sort()
  );
  assert.equal(
    tombstones.every((row) => row.reason === "account_deleted"),
    true
  );
});

// The rule that makes a comparison turn work: the attachment belongs to the
// question, and the question is one message all three models answer.
test("clearing one model's answers leaves the shared question's files alone", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);
  await prisma.message.create({
    data: {
      conversationId: seeded.conversationId,
      role: "assistant",
      content: "답변",
      modelId: "gpt-5-6-luna",
    },
  });

  const enqueued = await prisma.$transaction(async (tx) => {
    const count = await enqueueMessageAttachmentCleanupForMessages(tx, {
      conversationId: seeded.conversationId,
      modelId: "gpt-5-6-luna",
      role: "assistant",
    });
    await tx.message.deleteMany({
      where: {
        conversationId: seeded.conversationId,
        modelId: "gpt-5-6-luna",
        role: "assistant",
      },
    });
    return count;
  });

  assert.equal(enqueued, 0);
  assert.equal(await prisma.messageAttachmentCleanup.count(), 0);
  const surviving = await prisma.messageAttachment.findFirstOrThrow();
  assert.equal(surviving.objectKey, attachment.objectKey);
});

test("deleting the user message itself does enqueue its files", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);

  await prisma.$transaction(async (tx) => {
    await enqueueMessageAttachmentCleanupForMessages(tx, {
      conversationId: seeded.conversationId,
      role: "user",
    });
    await tx.message.deleteMany({
      where: { conversationId: seeded.conversationId, role: "user" },
    });
  });

  const tombstones = await prisma.messageAttachmentCleanup.findMany();
  assert.deepEqual(
    tombstones.map((row) => [row.objectKey, row.reason]),
    [[attachment.objectKey, "message_deleted"]]
  );
});

/* -------------------------------------------------------------------------- */
/* Constraints                                                                  */
/* -------------------------------------------------------------------------- */

test("the database refuses a kind outside the two the reader knows", async () => {
  const seeded = await seed();
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MessageAttachment"
        ("id","messageId","conversationId","userId","ordinal","name","mediaType","size","kind","objectKey")
       VALUES ($1,$2,$3,$4,0,'x.docx',$5,10,'binary',$6)`,
      randomUUID(),
      seeded.promptMessageId,
      seeded.conversationId,
      seeded.userId,
      DOCX,
      `${seeded.prefix}x.docx`
    )
  );
});

test("the database refuses a negative size", async () => {
  const seeded = await seed();
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MessageAttachment"
        ("id","messageId","conversationId","userId","ordinal","name","mediaType","size","kind","objectKey")
       VALUES ($1,$2,$3,$4,0,'x.docx',$5,-1,'file',$6)`,
      randomUUID(),
      seeded.promptMessageId,
      seeded.conversationId,
      seeded.userId,
      DOCX,
      `${seeded.prefix}y.docx`
    )
  );
});

test("the database refuses a cleanup reason nobody writes", async () => {
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MessageAttachmentCleanup" ("id","objectKey","reason","updatedAt")
       VALUES ($1,$2,'because','now()')`,
      randomUUID(),
      "attachments/whatever"
    )
  );
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                   */
/* -------------------------------------------------------------------------- */

// The conversation read pages messages fifty at a time, so an attachment on an
// early turn comes back on an early page or not at all. The page shape here is
// the route's own (`orderBy` + `cursor` + `take`), paired with the shared
// public select, so a change to either that stopped carrying attachments
// through a page boundary fails here.
test("an attachment survives the conversation read's paging", async () => {
  const seeded = await seed();
  const { attachment } = await bindOne(seeded);
  await prisma.message.createMany({
    data: Array.from({ length: 60 }, (_, index) => ({
      conversationId: seeded.conversationId,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `turn-${index}`,
      modelId: index % 2 === 0 ? "gpt-5-6-luna" : null,
    })),
  });

  const pageSize = 50;
  const readPage = (cursor: string | null) =>
    prisma.message.findMany({
      where: { conversationId: seeded.conversationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        role: true,
        content: true,
        attachments: {
          orderBy: { ordinal: "asc" as const },
          select: PUBLIC_MESSAGE_ATTACHMENT_SELECT,
        },
      },
    });

  const first = await readPage(null);
  assert.equal(first.length, pageSize + 1);
  const second = await readPage(first[pageSize - 1].id);
  const all = [...first.slice(0, pageSize), ...second];

  const withFiles = all.filter((message) => message.attachments.length > 0);
  assert.equal(withFiles.length, 1);
  assert.equal(withFiles[0].id, seeded.promptMessageId);
  assert.equal(withFiles[0].attachments[0].name, "계약서양식.docx");
  // And the page carries no storage key, on any page.
  assert.equal(JSON.stringify(all).includes(attachment.objectKey), false);
  assert.equal(JSON.stringify(all).includes("attachments/"), false);
});
