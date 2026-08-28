import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";

import { PUBLIC_MESSAGE_ATTACHMENT_SELECT } from "@/lib/messageAttachmentCore";
import {
  accountAttachmentPrefix,
  markMessageAttachmentUnavailable,
  recordMessageAttachmentSeen,
  resolveMessageAttachmentReferences,
} from "@/lib/messageAttachmentStorage";
import { prisma } from "@/lib/prisma";

/**
 * The availability half of the attachment contract, against a real database.
 *
 * docs/policy/user-attachment-persistence.md §11. Four things Postgres has to
 * answer for, and none of them can be checked without it:
 *
 *   * the expand migration really added nullable columns with no default, so
 *     every pre-existing row reads as "never checked" rather than as available;
 *   * marking a row unavailable deletes nothing -- not the attachment row, not
 *     the message, not the name or the size the card renders;
 *   * only a confirmed 404 writes the verdict, so a credentials outage cannot
 *     record an account as having lost its history;
 *   * the first write wins, so the timestamp keeps saying when this was
 *     discovered rather than when it was last re-confirmed.
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

type Seeded = {
  userId: string;
  email: string;
  prefix: string;
  conversationId: string;
  messageId: string;
  attachmentId: string;
  objectKey: string;
};

const seed = async (): Promise<Seeded> => {
  const userId = randomUUID();
  const email = `${userId}@example.invalid`;
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const prefix = accountAttachmentPrefix(email);
  const objectKey = `${prefix}2026-08-26/${randomUUID()}-nda.jpg`;
  await prisma.user.create({ data: { id: userId, email } });
  await prisma.conversation.create({
    data: { id: conversationId, userId, title: "비밀유지계약" },
  });
  await prisma.message.create({
    data: { id: messageId, conversationId, role: "user", content: "" },
  });
  const attachment = await prisma.messageAttachment.create({
    data: {
      messageId,
      conversationId,
      userId,
      ordinal: 0,
      name: "nda-signed.jpg",
      mediaType: "image/jpeg",
      size: 41_231,
      kind: "file",
      objectKey,
    },
  });
  return {
    userId,
    email,
    prefix,
    conversationId,
    messageId,
    attachmentId: attachment.id,
    objectKey,
  };
};

const notFound = () =>
  Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });

/*
  The migration is expand-only.

  Every column it added is nullable with no default and nothing backfilled it,
  because NULL is the honest value for a row nobody has checked. A default of
  "available" would have been the migration asserting something it did not look
  at, and the audit tool would then have no way to tell the two apart.
*/
test("a freshly written attachment has no availability verdict at all", async () => {
  const seeded = await seed();
  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
    select: {
      unavailableAt: true,
      unavailableReason: true,
      availabilityCheckedAt: true,
    },
  });
  assert.equal(row.unavailableAt, null);
  assert.equal(row.unavailableReason, null);
  assert.equal(row.availabilityCheckedAt, null);
});

test("a confirmed 404 marks the row and keeps everything the card renders", async () => {
  const seeded = await seed();
  const marked = await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
    error: notFound(),
  });
  assert.equal(marked, true);

  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
  });
  assert.ok(row.unavailableAt instanceof Date);
  assert.equal(row.unavailableReason, "storage_object_missing");
  assert.ok(row.availabilityCheckedAt instanceof Date);
  // §11: the row survives, and so does everything the person needs to know
  // which file they lost.
  assert.equal(row.name, "nda-signed.jpg");
  assert.equal(row.size, 41_231);
  assert.equal(row.objectKey, seeded.objectKey);
  // The message it belongs to is untouched.
  const message = await prisma.message.findUnique({ where: { id: seeded.messageId } });
  assert.ok(message);
});

/*
  The distinction the whole feature turns on.

  A 403 from a rotated key and a 500 from the bucket both mean "we do not
  know". Writing either as a permanent verdict would, during a five-minute
  outage, record every attachment an account owns as lost -- and nothing clears
  the column afterwards, because it is only ever set from a confirmed answer.
*/
test("a 403 and a 500 record nothing", async () => {
  const seeded = await seed();
  for (const error of [
    Object.assign(new Error("AccessDenied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    }),
    Object.assign(new Error("InternalError"), {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    }),
    Object.assign(new Error("timeout"), { name: "Error", code: "ETIMEDOUT" }),
  ]) {
    const marked = await markMessageAttachmentUnavailable({
      attachmentId: seeded.attachmentId,
      userId: seeded.userId,
      error,
    });
    assert.equal(marked, false);
  }
  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
    select: { unavailableAt: true, unavailableReason: true },
  });
  assert.equal(row.unavailableAt, null);
  assert.equal(row.unavailableReason, null);
});

test("the discovery timestamp is not overwritten by a re-confirmation", async () => {
  const seeded = await seed();
  const first = new Date("2026-08-26T12:00:00.000Z");
  await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
    error: notFound(),
    now: first,
  });
  const second = await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
    error: notFound(),
    now: new Date("2026-08-27T12:00:00.000Z"),
  });
  assert.equal(second, false, "a second confirmation is not a new discovery");

  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
    select: { unavailableAt: true, availabilityCheckedAt: true },
  });
  assert.equal(row.unavailableAt!.toISOString(), first.toISOString());
  // ...but the check time moved, which is how the audit tells "looked again"
  // from "never looked".
  assert.equal(
    row.availabilityCheckedAt!.toISOString(),
    "2026-08-27T12:00:00.000Z"
  );
});

test("another account cannot mark a row it does not own", async () => {
  const seeded = await seed();
  const strangerId = randomUUID();
  await prisma.user.create({
    data: { id: strangerId, email: `${strangerId}@example.invalid` },
  });

  const marked = await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: strangerId,
    error: notFound(),
  });
  assert.equal(marked, false);
  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
    select: { unavailableAt: true, availabilityCheckedAt: true },
  });
  assert.equal(row.unavailableAt, null);
  // Not even the check time: the scoped update matched no row at all.
  assert.equal(row.availabilityCheckedAt, null);
});

test("recording a sighting never clears an existing verdict", async () => {
  const seeded = await seed();
  await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
    error: notFound(),
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  await recordMessageAttachmentSeen({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
  });
  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
    select: { unavailableAt: true },
  });
  // A key is written once and never rewritten, so an object that "came back"
  // is a fact for a person to look at, not a column this code should reverse.
  assert.equal(row.unavailableAt!.toISOString(), "2026-08-26T12:00:00.000Z");
});

/*
  The refusal has to survive a reload, and the read that carries it has to stay
  an allowlist. The verdict travels; the location never does.
*/
test("the conversation read carries the verdict and still no storage key", async () => {
  const seeded = await seed();
  await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
    error: notFound(),
  });
  const row = await prisma.messageAttachment.findUniqueOrThrow({
    where: { id: seeded.attachmentId },
    select: PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  });
  assert.equal("objectKey" in row, false);
  assert.equal(row.unavailableReason, "storage_object_missing");
  assert.ok(row.unavailableAt instanceof Date);
  assert.equal(JSON.stringify(row).includes("attachments/"), false);
});

/*
  The resolver has to carry the verdict, because that is what lets the chat
  route refuse a known-missing file without a second HEAD request -- and
  therefore without a round trip on every message of every later turn.
*/
test("resolution reports a row that is already known to be gone", async () => {
  const seeded = await seed();
  await markMessageAttachmentUnavailable({
    attachmentId: seeded.attachmentId,
    userId: seeded.userId,
    error: notFound(),
  });
  const [resolved] = await resolveMessageAttachmentReferences({
    userId: seeded.userId,
    ownPrefix: seeded.prefix,
    conversationId: seeded.conversationId,
    references: [{ attachmentId: seeded.attachmentId }],
  });
  assert.ok(resolved.unavailableAt instanceof Date);
  assert.equal(resolved.unavailableReason, "storage_object_missing");
  // Still resolves the key, because a resolution is not a read.
  assert.equal(resolved.objectKey, seeded.objectKey);
});

test("an unrecognised reason in the column does not reach the resolver's type", async () => {
  const seeded = await seed();
  await prisma.messageAttachment.update({
    where: { id: seeded.attachmentId },
    data: { unavailableAt: new Date(), unavailableReason: "eaten_by_a_dog" },
  });
  const [resolved] = await resolveMessageAttachmentReferences({
    userId: seeded.userId,
    ownPrefix: seeded.prefix,
    conversationId: seeded.conversationId,
    references: [{ attachmentId: seeded.attachmentId }],
  });
  assert.ok(resolved.unavailableAt instanceof Date);
  assert.equal(resolved.unavailableReason, null);
});
