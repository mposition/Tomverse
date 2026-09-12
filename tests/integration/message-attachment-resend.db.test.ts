import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Prisma } from "@prisma/client";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const objects = new Map<string, Buffer>();
let reads: string[] = [], writes: string[] = [], deletes: string[] = [];
let readFailure: unknown = null;
let writeHook: ((key: string) => Promise<void>) | null = null;
mock.module(mod("lib/r2.ts"), { namedExports: {
  readOwnR2ObjectBytes: async (key: string, options: { maxBytes: number }) => {
    reads.push(key);
    if (readFailure) throw readFailure;
    const bytes = objects.get(key);
    if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    assert.ok(bytes.length <= options.maxBytes);
    return Buffer.from(bytes);
  },
  writeR2Object: async (key: string, bytes: Buffer) => {
    writes.push(key);
    if (writeHook) await writeHook(key);
    objects.set(key, Buffer.from(bytes));
  },
  deleteR2Object: async (key: string) => { deletes.push(key); objects.delete(key); },
} });
let prisma: typeof import("@/lib/prisma").prisma;
let bindMessageAttachments: typeof import("@/lib/messageAttachmentStorage").bindMessageAttachments;
let accountAttachmentPrefix: typeof import("@/lib/messageAttachmentStorage").accountAttachmentPrefix;
let drainMessageAttachmentCleanupQueue: typeof import("@/lib/messageAttachmentStorage").drainMessageAttachmentCleanupQueue;
let saveMessagesWithAttachmentReferences: typeof import("@/lib/messageAttachmentResend").saveMessagesWithAttachmentReferences;
before(async () => {
  assert.equal(process.env.NODE_ENV, "test", "Destructive fixture requires the isolated test environment.");
  ({ prisma } = await import("@/lib/prisma"));
  ({ bindMessageAttachments, accountAttachmentPrefix, drainMessageAttachmentCleanupQueue } = await import("@/lib/messageAttachmentStorage"));
  ({ saveMessagesWithAttachmentReferences } = await import("@/lib/messageAttachmentResend"));
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "MessageAttachmentCleanup", "MessageAttachment", "MessageAttachmentUpload", "Message", "Conversation", "User" RESTART IDENTITY CASCADE');
  objects.clear(); reads = []; writes = []; deletes = []; readFailure = null; writeHook = null;
});
async function seed() {
  const userId = randomUUID(), conversationId = randomUUID(), sourceMessageId = randomUUID();
  const email = `${userId}@example.invalid`, ownPrefix = accountAttachmentPrefix(email);
  await prisma.user.create({ data: { id: userId, email } });
  await prisma.conversation.create({ data: { id: conversationId, userId, title: "Resend fixture" } });
  await prisma.message.create({ data: { id: sourceMessageId, conversationId, role: "user", content: "Original" } });
  const objectKey = `${ownPrefix}original.txt`;
  objects.set(objectKey, Buffer.from("test"));
  const source = await prisma.messageAttachment.create({ data: {
    userId, conversationId, messageId: sourceMessageId, ordinal: 0,
    objectKey, name: "original.txt", mediaType: "text/plain", size: 4, kind: "text",
  } });
  const messageId = randomUUID();
  const input = {
    userId, conversationId, ownPrefix,
    messages: [{ id: messageId, content: "", attachmentReferences: [{ attachmentId: source.id }] }],
    beforeCreate: async (tx: Prisma.TransactionClient) => { void tx; },
  };
  return { input, source, messageId, objectKey };
}
async function pendingKeys() {
  return (await prisma.messageAttachmentCleanup.findMany({ where: { completedAt: null } })).map((row) => row.objectKey);
}
async function assertOriginal(key: string) {
  assert.equal(objects.get(key)?.toString(), "test");
  assert.ok(await prisma.messageAttachment.findUnique({ where: { objectKey: key } }));
  assert.equal(deletes.includes(key), false);
}
async function freshUpload(input: { userId: string; ownPrefix: string }) {
  const objectKey = `${input.ownPrefix}fresh-${randomUUID()}.txt`;
  objects.set(objectKey, Buffer.from("new!"));
  return prisma.messageAttachmentUpload.create({ data: {
    userId: input.userId, objectKey, name: "fresh.txt", mediaType: "text/plain", size: 4, kind: "text",
  } });
}

test("restored attachment-only question gets its own object and atomic durable card", async () => {
  const { input, source, messageId, objectKey } = await seed();
  assert.deepEqual(await saveMessagesWithAttachmentReferences(input), { count: 1 });
  const row = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId } });
  assert.notEqual(row.id, source.id); assert.notEqual(row.objectKey, objectKey);
  assert.equal(row.name, "original.txt"); assert.equal(row.ordinal, 0);
  assert.equal(objects.get(row.objectKey)?.toString(), "test");
  assert.equal(await prisma.message.count({ where: { id: messageId, content: "" } }), 1);
  assert.deepEqual(await pendingKeys(), []); await assertOriginal(objectKey);
});
test("sequential idempotent resend returns the same rows without reading or copying again", async () => {
  const { input, messageId } = await seed();
  await saveMessagesWithAttachmentReferences(input);
  const first = await prisma.messageAttachment.findMany({ where: { messageId } });
  assert.deepEqual(await saveMessagesWithAttachmentReferences(input), { count: 0 });
  assert.deepEqual(await prisma.messageAttachment.findMany({ where: { messageId } }), first);
  assert.equal(reads.length, 1); assert.equal(writes.length, 1); assert.deepEqual(await pendingKeys(), []);
});
test("mixed stored and fresh references preserve ordinal and server metadata", async () => {
  const { input, source, messageId } = await seed();
  const upload = await freshUpload(input);
  await saveMessagesWithAttachmentReferences({ ...input, messages: [{ id: messageId, content: "", attachmentReferences: [{ uploadId: upload.id }, { attachmentId: source.id }] }] });
  const rows = await prisma.messageAttachment.findMany({ where: { messageId }, orderBy: { ordinal: "asc" } });
  assert.deepEqual(rows.map((row) => [row.ordinal, row.name]), [[0, "fresh.txt"], [1, "original.txt"]]);
  assert.equal(rows[0].objectKey, upload.objectKey); assert.equal(writes.length, 1);
});
test("fully persisted reference retry reads back at capacity without quota check or new I/O", async () => {
  const { input, messageId } = await seed();
  await saveMessagesWithAttachmentReferences(input);
  const previous = await prisma.messageAttachment.findMany({ where: { messageId } });
  assert.deepEqual(await saveMessagesWithAttachmentReferences({ ...input,
    beforeCreate: async () => { assert.fail("A readback must not reserve quota."); },
  }), { count: 0 });
  assert.deepEqual(await prisma.messageAttachment.findMany({ where: { messageId } }), previous);
  assert.equal(reads.length, 1); assert.equal(writes.length, 1);
});
test("another user's or another conversation's source and missing ids are refused before I/O", async () => {
  const first = await seed(), second = await seed();
  const otherConversation = randomUUID();
  await prisma.conversation.create({ data: { id: otherConversation, userId: first.input.userId, title: "Other" } });
  for (const candidate of [
    { ...first.input, messages: [{ ...first.input.messages[0], attachmentReferences: [{ attachmentId: second.source.id }] }] },
    { ...first.input, conversationId: otherConversation },
    { ...first.input, messages: [{ ...first.input.messages[0], attachmentReferences: [{ attachmentId: "unknown" }] }] },
    { ...first.input, ownPrefix: "attachments/wrong/" },
  ]) await assert.rejects(saveMessagesWithAttachmentReferences(candidate), { code: "ATTACHMENT_UNAVAILABLE" });
  assert.deepEqual(reads, []); assert.deepEqual(writes, []);
});
test("unavailable source, missing bytes and temporary storage failure remain distinct", async () => {
  const { input, source, objectKey, messageId } = await seed();
  await prisma.messageAttachment.update({ where: { id: source.id }, data: { unavailableAt: new Date(), unavailableReason: "storage_object_missing" } });
  await assert.rejects(saveMessagesWithAttachmentReferences(input), { code: "ATTACHMENT_UNAVAILABLE", status: 410 });
  assert.equal(reads.length, 0);
  await prisma.messageAttachment.update({ where: { id: source.id }, data: { unavailableAt: null, unavailableReason: null } });
  objects.delete(objectKey);
  await assert.rejects(saveMessagesWithAttachmentReferences(input), { status: 410 });
  readFailure = Object.assign(new Error("private detail"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  await assert.rejects(saveMessagesWithAttachmentReferences(input), { code: "ATTACHMENT_STORAGE_UNAVAILABLE", status: 503 });
  assert.equal(await prisma.message.count({ where: { id: messageId } }), 0);
  assert.equal((await prisma.messageAttachment.findUniqueOrThrow({ where: { id: source.id } })).unavailableAt, null);
});
test("partial copy failure queues only newly prepared keys and never mutates the original", async () => {
  const { input, source, objectKey, messageId } = await seed();
  const secondKey = `${input.ownPrefix}second.txt`;
  objects.set(secondKey, Buffer.from("test"));
  const second = await prisma.messageAttachment.create({ data: {
    userId: input.userId, conversationId: input.conversationId, messageId: source.messageId,
    ordinal: 1, objectKey: secondKey, name: "second.txt", mediaType: "text/plain", size: 4, kind: "text",
  } });
  writeHook = async () => { if (writes.length === 2) throw new Error("failed PUT"); };
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, messages: [{ id: messageId, content: "", attachmentReferences: [{ attachmentId: source.id }, { attachmentId: second.id }] }] }), { status: 503 });
  assert.equal(writes.length, 2); assert.deepEqual(new Set(await pendingKeys()), new Set(writes));
  assert.equal(await prisma.message.count({ where: { id: messageId } }), 0);
  await drainMessageAttachmentCleanupQueue(); await assertOriginal(objectKey);
  assert.equal(objects.size, 2); await assertOriginal(secondKey);
});
test("capacity refusal happens before storage writes; authoritative transaction failure cleans copies", async () => {
  const { input, messageId, objectKey } = await seed();
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, beforeCreate: async () => { throw new Error("quota"); } }), /quota/);
  assert.equal(writes.length, 0);
  let checks = 0;
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, beforeCreate: async () => { if (++checks === 2) throw new Error("DB refusal"); } }), /DB refusal/);
  assert.equal(await prisma.message.count({ where: { id: messageId } }), 0);
  assert.deepEqual(await pendingKeys(), writes); await drainMessageAttachmentCleanupQueue(); await assertOriginal(objectKey);
});
test("source availability is checked again inside the binding transaction", async () => {
  const { input, source, messageId } = await seed();
  let checks = 0;
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, beforeCreate: async (tx) => {
    if (++checks === 2) await tx.messageAttachment.update({ where: { id: source.id }, data: { unavailableAt: new Date() } });
  } }), { status: 410 });
  assert.equal(await prisma.message.count({ where: { id: messageId } }), 0);
  assert.deepEqual(await pendingKeys(), writes);
});
test("concurrent duplicate saves persist one card and queue only the loser's fresh copy", async () => {
  const { input, messageId, objectKey } = await seed();
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  writeHook = async () => { if (writes.length === 2) release(); await both; };
  const results = await Promise.all([saveMessagesWithAttachmentReferences(input), saveMessagesWithAttachmentReferences(input)]);
  assert.deepEqual(results.map((r) => r.count).sort(), [0, 1]);
  const rows = await prisma.messageAttachment.findMany({ where: { messageId } });
  assert.equal(rows.length, 1); assert.equal(writes.length, 2);
  const queued = await pendingKeys(); assert.equal(queued.length, 1); assert.notEqual(queued[0], rows[0].objectKey);
  await drainMessageAttachmentCleanupQueue(); assert.equal(objects.size, 2);
  assert.ok(objects.has(rows[0].objectKey)); await assertOriginal(objectKey);
});
test("duplicate batch ids and an existing foreign or assistant message are rejected without copies", async () => {
  const { input, source, messageId } = await seed();
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, messages: [input.messages[0], { ...input.messages[0], content: "different", attachmentReferences: [{ attachmentId: source.id }] }] }), { status: 409 });
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, messages: [{ ...input.messages[0], attachmentReferences: [{ attachmentId: source.id }, { attachmentId: source.id }] }] }), { status: 409 });
  await prisma.message.create({ data: { id: messageId, conversationId: input.conversationId, role: "assistant", content: "answer" } });
  await assert.rejects(saveMessagesWithAttachmentReferences(input), { status: 409 });
  const other = await seed();
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...other.input, messages: [{ ...other.input.messages[0], id: messageId }] }), { status: 409 });
  assert.equal(writes.length, 0);
});
test("legacy already-bound upload refusal is preserved when another batch message uses references", async () => {
  const { input, messageId } = await seed();
  const upload = await freshUpload(input), oldId = randomUUID();
  await prisma.message.create({ data: { id: oldId, conversationId: input.conversationId, role: "user", content: "old" } });
  await prisma.$transaction((tx) => bindMessageAttachments(tx, { ...input, messageId: oldId, uploadIds: [upload.id] }));
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, messages: [...input.messages, { id: randomUUID(), content: "legacy", attachmentUploadIds: [upload.id] }] }), { code: "ATTACHMENT_ALREADY_BOUND" });
  assert.equal(await prisma.message.count({ where: { id: messageId } }), 0); assert.deepEqual(await pendingKeys(), writes);
});
test("a write delayed beyond default transaction timeout finishes before the winner transaction starts", async () => {
  const { input } = await seed(); let checks = 0;
  writeHook = async () => {
    assert.equal(checks, 1); // The short capacity precheck has already closed.
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    assert.equal(checks, 1); assert.deepEqual(await pendingKeys(), []);
  };
  assert.deepEqual(await saveMessagesWithAttachmentReferences({ ...input, beforeCreate: async () => { checks++; } }), { count: 1 });
  assert.equal(checks, 2); assert.deepEqual(await pendingKeys(), []);
});
test("a real default-duration Prisma transaction timeout rolls back and queues settled copies", async () => {
  const { input, messageId, objectKey } = await seed(); let checks = 0;
  await assert.rejects(saveMessagesWithAttachmentReferences({ ...input, beforeCreate: async (tx) => {
    if (++checks === 2) await tx.$executeRawUnsafe("SELECT pg_sleep(5.2)");
  } }), { code: "P2028" });
  assert.equal(await prisma.message.count({ where: { id: messageId } }), 0);
  assert.deepEqual(await pendingKeys(), writes); await drainMessageAttachmentCleanupQueue(); await assertOriginal(objectKey);
});
