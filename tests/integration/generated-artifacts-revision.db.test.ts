import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const objects = new Map<string, Buffer>();
let reads: string[] = [], writes: string[] = [], deletes: string[] = [], reservations: number[] = [];
let writeHook: ((key: string) => Promise<void>) | null = null;
let readFailure: unknown;
mock.module(mod("lib/r2.ts"), { namedExports: {
  readOwnR2ObjectBytes: async (key: string, { maxBytes }: { maxBytes: number }) => {
    reads.push(key);
    if (readFailure) throw readFailure;
    const bytes = objects.get(key);
    if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    if (bytes.byteLength > maxBytes) {
      const { BoundedBufferError } = await import("@/lib/boundedBuffer");
      throw new BoundedBufferError();
    }
    return Buffer.from(bytes);
  },
  writeR2Object: async (key: string, bytes: Buffer) => {
    writes.push(key); objects.set(key, Buffer.from(bytes));
    await writeHook?.(key);
  },
  deleteR2Object: async (key: string) => { deletes.push(key); objects.delete(key); },
} });
let prisma: typeof import("@/lib/prisma").prisma;
let copy: typeof import("@/lib/generatedArtifactRevision").copyGeneratedArtifactForRevision;
let storage: typeof import("@/lib/messageAttachmentStorage");
before(async () => {
  assert.equal(process.env.NODE_ENV, "test", "Destructive fixtures require the isolated test runner.");
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  ({ prisma } = await import("@/lib/prisma"));
  ({ copyGeneratedArtifactForRevision: copy } = await import("@/lib/generatedArtifactRevision"));
  storage = await import("@/lib/messageAttachmentStorage");
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "MessageArtifactCleanup", "MessageArtifact", "MessageAttachmentCleanup", "MessageAttachment", "MessageAttachmentUpload", "Message", "Conversation", "User" RESTART IDENTITY CASCADE');
  objects.clear(); reads = []; writes = []; deletes = []; reservations = []; writeHook = null; readFailure = null;
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function seed(text = "Original target text") {
  const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), artifactId = randomUUID();
  const email = `${userId}@example.invalid`;
  await prisma.user.create({ data: { id: userId, email } });
  await prisma.conversation.create({ data: { id: conversationId, userId, title: "Revision", selectedModels: '["gpt-6-luna"]' } });
  await prisma.message.create({ data: { id: messageId, conversationId, role: "assistant", content: "File" } });
  const objectKey = `message-artifacts/${userId}/${conversationId}/${artifactId}.txt`;
  objects.set(objectKey, Buffer.from(text));
  await prisma.messageArtifact.create({ data: {
    id: artifactId, userId, conversationId, messageId, ordinal: 0, format: "txt", filename: "same.txt",
    mediaType: "text/plain; charset=utf-8", byteSize: Buffer.byteLength(text), status: "ready", objectKey,
  } });
  const input = {
    action: "generated-artifact-copy" as const, artifactId, conversationId, operationId: randomUUID(),
    userId, email, request: new Request("http://localhost/api/chat", { method: "PUT" }), maxBytes: 10 * 1024 * 1024,
    reserveBytes: async (bytes: number) => { reservations.push(bytes); },
  };
  return { input, objectKey, messageId, hash: sha(objects.get(objectKey)!) };
}
async function pendingKeys() {
  return (await prisma.messageAttachmentCleanup.findMany({ where: { completedAt: null } })).map((row) => row.objectKey);
}
async function assertOriginal(source: { objectKey: string; hash: string }) {
  assert.equal(sha(objects.get(source.objectKey)!), source.hash);
  assert.equal(deletes.includes(source.objectKey), false);
  assert.equal((await pendingKeys()).includes(source.objectKey), false);
}
async function bind(input: Awaited<ReturnType<typeof seed>>["input"], uploadId: string) {
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.message.create({ data: { id, conversationId: input.conversationId, role: "user", content: "Create a revised file" } });
    await storage.bindMessageAttachments(tx, {
      userId: input.userId, ownPrefix: storage.accountAttachmentPrefix(input.email), conversationId: input.conversationId, messageId: id, uploadIds: [uploadId],
    });
  });
  return prisma.messageAttachment.findFirstOrThrow({ where: { messageId: id } });
}

test("exact selected bytes become an opaque independent input; same-name newer artifact is ignored", async () => {
  const source = await seed();
  await prisma.messageArtifact.create({ data: {
    id: randomUUID(), userId: source.input.userId, conversationId: source.input.conversationId,
    messageId: source.messageId, ordinal: 1, format: "txt", filename: "same.txt", mediaType: "text/plain; charset=utf-8",
    byteSize: 10, status: "ready", objectKey: `message-artifacts/${source.input.userId}/${source.input.conversationId}/newer.txt`,
  } });
  const result = await copy(source.input);
  assert.deepEqual(Object.keys(result).sort(), ["kind", "mediaType", "name", "size", "uploadId"]);
  const upload = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: result.uploadId } });
  assert.notEqual(upload.objectKey, source.objectKey);
  assert.ok(upload.objectKey.startsWith(storage.accountAttachmentPrefix(source.input.email)));
  assert.equal(sha(objects.get(upload.objectKey)!), source.hash);
  assert.equal(await prisma.message.count(), 1, "Selecting creates no user message");
  await assertOriginal(source);
});

test("settled operation retry reuses the same bound winner without reading, writing or reserving again", async () => {
  const source = await seed(), first = await copy(source.input);
  const attachment = await bind(source.input, first.uploadId);
  const counts = [reads.length, writes.length, reservations.length];
  assert.deepEqual(await copy(source.input), first);
  assert.deepEqual([reads.length, writes.length, reservations.length], counts);
  assert.equal((await pendingKeys()).includes(attachment.objectKey), false);
  await assertOriginal(source);
});

test("concurrent operation attempts converge and clean only the unregistered random loser", async () => {
  const source = await seed();
  let arrivals = 0, release!: () => void;
  const together = new Promise<void>((resolve) => { release = resolve; });
  writeHook = async () => { if (++arrivals === 2) release(); await together; };
  const [first, second] = await Promise.all([copy(source.input), copy(source.input)]);
  assert.deepEqual(first, second);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0], writes[1]);
  assert.equal(await prisma.messageAttachmentUpload.count(), 1);
  const bound = await bind(source.input, first.uploadId);
  const cleanup = await pendingKeys();
  assert.equal(cleanup.length, 1);
  assert.notEqual(cleanup[0], bound.objectKey);
  await storage.drainMessageAttachmentCleanupQueue();
  assert.ok(objects.has(bound.objectKey));
  assert.equal(objects.has(cleanup[0]), false);
  await assertOriginal(source);
});

for (const scenario of ["other owner", "other conversation", "locked", "not ready", "unsupported", "outside prefix", "oversize"] as const) {
  test(`prepare rejects ${scenario} before storage/quota and preserves source`, async () => {
    const source = await seed();
    let code = "ATTACHMENT_UNAVAILABLE";
    switch (scenario) {
      case "other owner": source.input.userId = randomUUID(); break;
      case "other conversation": source.input.conversationId = randomUUID(); break;
      case "locked": await prisma.conversation.update({ where: { id: source.input.conversationId }, data: { password: "locked" } }); code = "CONVERSATION_LOCKED"; break;
      case "not ready": await prisma.messageArtifact.update({ where: { id: source.input.artifactId }, data: { status: "failed", objectKey: null, byteSize: 0, failureCode: "generation_failed" } }); break;
      case "unsupported": await prisma.messageArtifact.update({ where: { id: source.input.artifactId }, data: { format: "pdf", filename: "same.pdf", mediaType: "application/pdf" } }); code = "UNSUPPORTED_ATTACHMENT_TYPE"; break;
      case "outside prefix": await prisma.messageArtifact.update({ where: { id: source.input.artifactId }, data: { objectKey: "another-owner/input.txt" } }); break;
      case "oversize": source.input.maxBytes = 2; code = "ATTACHMENT_TOO_LARGE"; break;
    }
    await assert.rejects(copy(source.input), { code });
    assert.equal(reads.length, 0); assert.equal(writes.length, 0); assert.equal(reservations.length, 0);
    await assertOriginal(source);
  });
}

for (const race of ["delete", "relock", "metadata"] as const) {
  test(`source ${race} during copy refuses registration and queues only its own failed input`, async () => {
    const source = await seed();
    writeHook = async () => {
      if (race === "delete") await prisma.messageArtifact.delete({ where: { id: source.input.artifactId } });
      if (race === "relock") await prisma.conversation.update({ where: { id: source.input.conversationId }, data: { password: "new-lock" } });
      if (race === "metadata") await prisma.messageArtifact.update({ where: { id: source.input.artifactId }, data: { filename: "changed.txt" } });
    };
    await assert.rejects(copy(source.input), { code: race === "relock" ? "CONVERSATION_LOCKED" : "ATTACHMENT_UNAVAILABLE" });
    assert.equal(await prisma.messageAttachmentUpload.count(), 0);
    assert.deepEqual(await pendingKeys(), writes);
    await storage.drainMessageAttachmentCleanupQueue();
    await assertOriginal(source);
  });
}

test("failed object PUT is cleaned without touching the source and a retry can succeed", async () => {
  const source = await seed();
  writeHook = async () => { throw new Error("synthetic write failed after write"); };
  await assert.rejects(copy(source.input), { code: "ATTACHMENT_STORAGE_UNAVAILABLE" });
  assert.deepEqual(await pendingKeys(), writes);
  writeHook = null;
  const result = await copy(source.input);
  const winner = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: result.uploadId } });
  await storage.drainMessageAttachmentCleanupQueue();
  assert.ok(objects.has(winner.objectKey));
  await assertOriginal(source);
});

test("missing bytes, measured-size disagreement, text overflow and quota refusal never publish an input", async () => {
  const source = await seed();
  objects.delete(source.objectKey);
  await assert.rejects(copy(source.input), { code: "ATTACHMENT_UNAVAILABLE" });
  objects.set(source.objectKey, Buffer.from("short"));
  await assert.rejects(copy(source.input), { code: "ATTACHMENT_UNAVAILABLE" });
  objects.set(source.objectKey, Buffer.from("larger than the row declares".repeat(20)));
  await assert.rejects(copy(source.input), { code: "ATTACHMENT_UNAVAILABLE" });
  objects.set(source.objectKey, Buffer.from("x".repeat(300_001)));
  await prisma.messageArtifact.update({ where: { id: source.input.artifactId }, data: { byteSize: 300_001 } });
  await assert.rejects(copy(source.input), { code: "ATTACHMENT_TEXT_TOO_LARGE" });
  objects.set(source.objectKey, Buffer.from("valid"));
  await prisma.messageArtifact.update({ where: { id: source.input.artifactId }, data: { byteSize: 5 } });
  source.input.reserveBytes = async () => { throw Object.assign(new Error("quota"), { code: "UPLOAD_STORAGE_QUOTA_EXCEEDED" }); };
  await assert.rejects(copy(source.input), { code: "UPLOAD_STORAGE_QUOTA_EXCEEDED" });
  assert.equal(await prisma.messageAttachmentUpload.count(), 0); assert.equal(writes.length, 0);
});

test("registration DB failure rolls back the upload and queues its own already-written copy", async () => {
  const source = await seed();
  await prisma.$executeRawUnsafe('ALTER TABLE "MessageAttachmentUpload" ADD CONSTRAINT revision_fixture_reject CHECK (name <> \'same.txt\') NOT VALID');
  try { await assert.rejects(copy(source.input)); }
  finally { await prisma.$executeRawUnsafe('ALTER TABLE "MessageAttachmentUpload" DROP CONSTRAINT revision_fixture_reject'); }
  assert.equal(await prisma.messageAttachmentUpload.count(), 0);
  assert.deepEqual(await pendingKeys(), writes);
  const result = await copy(source.input);
  const winner = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: result.uploadId } });
  await storage.drainMessageAttachmentCleanupQueue();
  assert.ok(objects.has(winner.objectKey));
  await assertOriginal(source);
});

test("a bound independent input survives assistant deletion; conversation deletion collects the bound copy only", async () => {
  const source = await seed();
  const result = await copy(source.input), bound = await bind(source.input, result.uploadId);
  const unbound = await copy({ ...source.input, operationId: randomUUID() });
  await prisma.message.delete({ where: { id: source.messageId } });
  assert.ok(await prisma.messageAttachment.findUnique({ where: { id: bound.id } }));
  await prisma.$transaction(async (tx) => {
    await storage.enqueueMessageAttachmentCleanupForConversations(tx, [source.input.conversationId], "conversation_deleted");
    await tx.conversation.delete({ where: { id: source.input.conversationId } });
  });
  assert.ok((await pendingKeys()).includes(bound.objectKey));
  assert.ok(await prisma.messageAttachmentUpload.findUnique({ where: { id: unbound.uploadId } }), "unbound inputs have no conversation FK");
});

test("disabled connection refuses preparation without model or storage activity", async () => {
  const source = await seed();
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "false";
  await assert.rejects(copy(source.input), { code: "GENERATED_ARTIFACT_REVISION_DISABLED" });
  assert.equal(reads.length, 0); assert.equal(writes.length, 0); assert.equal(reservations.length, 0);
});

for (const change of ["delete", "relock"] as const) {
  test(`final source authority waits behind a concurrent ${change} row lock and observes its commit`, async () => {
    const source = await seed();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = prisma.$transaction(async (tx) => {
      if (change === "delete") await tx.$queryRaw`SELECT "id" FROM "MessageArtifact" WHERE "id" = ${source.input.artifactId} FOR UPDATE`;
      else await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${source.input.conversationId} FOR UPDATE`;
      locked();
      await gate;
      if (change === "delete") await tx.messageArtifact.delete({ where: { id: source.input.artifactId } });
      else await tx.conversation.update({ where: { id: source.input.conversationId }, data: { password: "new-lock" } });
    });
    await ready;
    // Observe PostgreSQL's lock wait rather than guessing from a timed sleep.
    const outcome = copy(source.input).then(() => null, (error: unknown) => error);
    let observed = false;
    const deadline = Date.now() + 3500;
    try {
      while (Date.now() < deadline && !observed) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%') AS waiting`;
        observed = rows[0].waiting;
        if (!observed) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(observed, true, "source authority must acquire a real share lock");
    } finally { release(); }
    await writer;
    const error = await outcome as { code: string };
    assert.equal(error?.code, change === "delete" ? "ATTACHMENT_UNAVAILABLE" : "CONVERSATION_LOCKED");
    assert.equal(reads.length, 0); assert.equal(writes.length, 0);
    await assertOriginal(source);
  });
}

test("draft removal cleans only an unbound input; account cleanup includes all bound and unbound copies", async () => {
  const source = await seed();
  const first = await copy(source.input), bound = await bind(source.input, first.uploadId);
  const second = await copy({ ...source.input, operationId: randomUUID() });
  const unbound = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: second.uploadId } });
  const third = await copy({ ...source.input, operationId: randomUUID() });
  assert.deepEqual(await storage.discardUnboundUpload({ userId: source.input.userId, uploadId: third.uploadId }), { removed: true, kept: false });
  assert.deepEqual(await storage.discardUnboundUpload({ userId: source.input.userId, uploadId: first.uploadId }), { removed: false, kept: true });
  await prisma.$transaction(async (tx) => {
    await storage.enqueueMessageAttachmentCleanupForUser(tx, source.input.userId);
    await tx.user.delete({ where: { id: source.input.userId } });
  });
  const pending = await pendingKeys();
  assert.ok(pending.includes(bound.objectKey)); assert.ok(pending.includes(unbound.objectKey));
  assert.equal(pending.includes(source.objectKey), false, "artifact cleanup is a separate domain");
  await storage.drainMessageAttachmentCleanupQueue();
  assert.equal(objects.has(bound.objectKey), false); assert.equal(objects.has(unbound.objectKey), false);
  await assertOriginal(source);
});
