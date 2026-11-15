import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const objects = new Map<string, Buffer>();
let reads = 0;
mock.module(mod("lib/r2.ts"), { namedExports: {
  readOwnR2ObjectBytes: async (key: string, input: { maxBytes: number }) => {
    reads++;
    const bytes = objects.get(key);
    if (!bytes || bytes.length > input.maxBytes) throw new Error("Missing fixture object");
    return Buffer.from(bytes);
  },
  writeR2Object: async (key: string, bytes: Buffer) => { objects.set(key, Buffer.from(bytes)); },
  deleteR2Object: async (key: string) => { objects.delete(key); },
  listExpiredR2Objects: async () => [],
} });

let prisma: typeof import("@/lib/prisma").prisma;
let storage: typeof import("@/lib/messageAttachmentStorage");
let artifactStorage: typeof import("@/lib/generatedArtifactStorage");
let copy: typeof import("@/lib/generatedArtifactRevision").copyGeneratedArtifactForRevision;
let versions: typeof import("@/lib/generatedArtifactLineage").readGeneratedArtifactVersions;
let render: typeof import("@/lib/generatedArtifactRenderers").renderSpreadsheetArtifact;
let canonicalFor: typeof import("@/lib/generatedArtifactWorkbookRevision").canonicalWorkbookSpecFor;
const spec = {
  filename: "budget.xlsx", format: "xlsx", styleHeader: true,
  worksheets: [{ name: "Budget", title: "Plan", freezeHeader: true,
    columns: [{ header: "Item", type: "text", width: 32 }, { header: "Amount", type: "number", format: "currency_usd", width: 18 }],
    rows: [["SENSITIVE_CELL", 100], ["Keep", 200]] },
  { name: "Other", freezeHeader: false, columns: [{ header: "Flag", type: "text" }], rows: [[true], [null]] }],
} as const;

before(async () => {
  assert.equal(process.env.NODE_ENV, "test", "Use the dedicated DB integration target guard.");
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  ({ prisma } = await import("@/lib/prisma"));
  storage = await import("@/lib/messageAttachmentStorage");
  artifactStorage = await import("@/lib/generatedArtifactStorage");
  ({ copyGeneratedArtifactForRevision: copy } = await import("@/lib/generatedArtifactRevision"));
  ({ readGeneratedArtifactVersions: versions } = await import("@/lib/generatedArtifactLineage"));
  ({ renderSpreadsheetArtifact: render } = await import("@/lib/generatedArtifactRenderers"));
  ({ canonicalWorkbookSpecFor: canonicalFor } = await import("@/lib/generatedArtifactWorkbookRevision"));
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "MessageArtifactCleanup", "MessageAttachmentCleanup", "MessageAttachment", "MessageAttachmentUpload", "MessageArtifact", "Message", "Conversation", "User" RESTART IDENTITY CASCADE');
  objects.clear(); reads = 0; process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
});
async function seed() {
  const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), id = randomUUID();
  const email = `${userId}@example.invalid`;
  await prisma.user.create({ data: { id: userId, email } });
  await prisma.conversation.create({ data: { id: conversationId, userId, title: "Revision", selectedModels: '["gpt-6-luna"]' } });
  await prisma.message.create({ data: { id: messageId, conversationId, role: "assistant", content: "File" } });
  const canonical = canonicalFor(structuredClone(spec) as never)!;
  assert.ok(canonical);
  const bytes = Buffer.from(render(canonical.spec).bytes);
  const objectKey = `message-artifacts/${userId}/${conversationId}/${id}.xlsx`;
  objects.set(objectKey, bytes);
  await prisma.messageArtifact.create({ data: { id, userId, conversationId, messageId,
    ordinal: 0, format: "xlsx", filename: "budget.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    byteSize: bytes.length, status: "ready", objectKey, canonicalSpec: canonical, lineageId: id } });
  return { userId, conversationId, messageId, id, email, canonical, objectKey,
    request: new Request("http://localhost/api/chat", { method: "PUT" }) };
}
async function prepare(source: Awaited<ReturnType<typeof seed>>, operationId = randomUUID()) {
  return copy({ action: "generated-artifact-copy", artifactId: source.id,
    conversationId: source.conversationId, operationId, userId: source.userId,
    email: source.email, request: source.request, maxBytes: 10 * 1024 * 1024, reserveBytes: async () => {} });
}
async function bind(source: Awaited<ReturnType<typeof seed>>, uploadId: string) {
  const messageId = randomUUID();
  await prisma.$transaction(async tx => {
    await tx.message.create({ data: { id: messageId, conversationId: source.conversationId, role: "user", content: "Change amount" } });
    await storage.bindMessageAttachments(tx, { userId: source.userId, ownPrefix: storage.accountAttachmentPrefix(source.email),
      conversationId: source.conversationId, messageId, uploadIds: [uploadId] });
  });
  return prisma.messageAttachment.findFirstOrThrow({ where: { messageId } });
}
async function child(source: Awaited<ReturnType<typeof seed>>, parentArtifactId = source.id, lineageId = source.id) {
  const messageId = randomUUID(), id = randomUUID();
  await prisma.$transaction(async tx => {
    await tx.message.create({ data: { id: messageId, conversationId: source.conversationId, role: "assistant", content: "Revision" } });
    await artifactStorage.persistArtifactRows(tx, { userId: source.userId, conversationId: source.conversationId, messageId,
      stored: [{ id, ordinal: 0, format: "xlsx", filename: "budget.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 100,
        objectKey: `message-artifacts/${source.userId}/${source.conversationId}/${id}.xlsx`, modelId: "gpt-6-luna",
        canonicalSpec: source.canonical, parentArtifactId, lineageId }], failed: [] });
  });
  return id;
}
const list = (source: Awaited<ReturnType<typeof seed>>, overrides = {}) => versions({
  userId: source.userId, artifactId: source.id, request: source.request, ...overrides,
});

test("a prepared XLSX has independent bytes and an independently retained canonical source receipt", async () => {
  const source = await seed();
  const before = createHash("sha256").update(objects.get(source.objectKey)!).digest("hex");
  const upload = await prepare(source);
  assert.equal(upload.revisionMode, "workbook");
  assert.deepEqual(Object.keys(upload).sort(), ["kind", "mediaType", "name", "revisionMode", "size", "uploadId"]);
  const row = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: upload.uploadId } });
  assert.equal(row.sourceArtifactId, source.id); assert.equal(row.sourceLineageId, source.id);
  assert.deepEqual(row.sourceCanonicalSpec, source.canonical);
  assert.notEqual(row.objectKey, source.objectKey);
  assert.deepEqual(objects.get(row.objectKey), objects.get(source.objectKey));
  const bound = await bind(source, upload.uploadId);
  assert.deepEqual(bound.sourceCanonicalSpec, source.canonical);
  assert.equal(createHash("sha256").update(objects.get(source.objectKey)!).digest("hex"), before);
});

test("settled replay retains the exact workbook mode and performs no second source read", async () => {
  const source = await seed(), operation = randomUUID();
  const first = await prepare(source, operation); await bind(source, first.uploadId);
  const before = reads;
  assert.deepEqual(await prepare(source, operation), first); assert.equal(reads, before);
});

test("source deletion nulls edges but preserves independent input snapshots and group continuity", async () => {
  const source = await seed(), upload = await prepare(source), bound = await bind(source, upload.uploadId);
  const next = await child(source);
  await prisma.message.delete({ where: { id: source.messageId } });
  const input = await prisma.messageAttachment.findUniqueOrThrow({ where: { id: bound.id } });
  assert.equal(input.sourceArtifactId, null); assert.deepEqual(input.sourceCanonicalSpec, source.canonical);
  const pending = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: upload.uploadId } });
  assert.equal(pending.sourceArtifactId, null); assert.deepEqual(pending.sourceCanonicalSpec, source.canonical);
  const result = await list(source, { artifactId: next });
  assert.equal(result.artifacts.length, 1); assert.equal(result.artifacts[0].parentArtifactId, null);
  assert.equal(result.artifacts[0].lineageId, source.id);
  const restored = await child(source, source.id, source.id);
  assert.equal((await prisma.messageArtifact.findUniqueOrThrow({ where: { id: restored } })).parentArtifactId, null);
});

test("branches persist actual parent identities and never group another same-name file", async () => {
  const source = await seed(), first = await child(source), second = await child(source, first), branch = await child(source);
  const unrelated = await seed();
  const result = await list(source);
  assert.deepEqual(new Set(result.artifacts.map(row => row.id)), new Set([source.id, first, second, branch]));
  assert.equal(result.artifacts.find(row => row.id === second)?.parentArtifactId, first);
  assert.equal(result.artifacts.find(row => row.id === branch)?.parentArtifactId, source.id);
  assert.ok(!JSON.stringify(result).includes(unrelated.id));
  assert.ok(!JSON.stringify(result).includes("SENSITIVE_CELL"));
  assert.ok(!JSON.stringify(result).includes("canonicalSpec"));
  assert.ok(!JSON.stringify(result).includes("message-artifacts/"));
});

test("foreign owner, conversation, source and invented lineage cannot create an output edge", async () => {
  const source = await seed(), foreign = await seed();
  const foreignParent = await child(source, foreign.id, foreign.id);
  const inventedParent = await child(source, randomUUID(), randomUUID());
  const mismatchedGroup = await child(source, source.id, foreign.id);
  const other = randomUUID();
  await prisma.conversation.create({ data: { id: other, userId: source.userId, title: "Revision", selectedModels: '["gpt-6-luna"]' } });
  const wrongConversation = await child({ ...source, conversationId: other }, source.id, source.id);
  for (const id of [foreignParent, inventedParent, mismatchedGroup, wrongConversation]) {
    const row = await prisma.messageArtifact.findUniqueOrThrow({ where: { id } });
    assert.equal(row.parentArtifactId, null);
    assert.equal(row.lineageId, id);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: row.messageId } })).content, "Revision");
  }
  assert.equal(await prisma.messageArtifact.count({ where: { userId: source.userId } }), 5);
});

test("source and receipt deletion before final persistence keeps the answer and file without an unverified edge", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const source = await seed(), upload = await prepare(source), bound = await bind(source, upload.uploadId);
  await prisma.message.deleteMany({ where: { id: { in: [source.messageId, bound.messageId] } } });
  await prisma.messageAttachmentUpload.delete({ where: { id: upload.uploadId } });
  const id = await child(source);
  const saved = await prisma.messageArtifact.findUniqueOrThrow({ where: { id } });
  assert.equal(saved.parentArtifactId, null); assert.equal(saved.lineageId, id);
  assert.deepEqual(saved.canonicalSpec, source.canonical);
  assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: saved.messageId } })).content, "Revision");
  assert.deepEqual(warnings.mock.calls.map(call => JSON.parse(call.arguments[0])), [
    { event: "generated_artifact_lineage_dropped", reason: "source_evidence_missing", count: 1 },
  ]);
});

test("version reads are owner/unlock scoped, default-off and reject foreign cursors", async () => {
  const source = await seed(), foreign = await seed();
  await assert.rejects(list(source, { userId: foreign.userId }), { status: 404 });
  await assert.rejects(list(source, { cursor: foreign.id }), { status: 404 });
  await prisma.conversation.update({ where: { id: source.conversationId }, data: { password: "locked" } });
  await assert.rejects(list(source), { status: 423 });
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "false";
  await assert.rejects(list(source), { status: 404 });
});

test("legacy root metadata is listed with descendants using real persisted group identity", async () => {
  const source = await seed();
  await prisma.messageArtifact.update({ where: { id: source.id }, data: { lineageId: null } });
  const next = await child(source);
  const result = await list(source, { artifactId: next });
  assert.deepEqual(new Set(result.artifacts.map(row => row.id)), new Set([source.id, next]));
});

test("version pages are bounded, stable, newest first and retain no duplicate cursor item", async () => {
  const source = await seed();
  await prisma.messageArtifact.createMany({ data: Array.from({ length: 51 }, (_, i) => ({
    id: randomUUID(), userId: source.userId, conversationId: source.conversationId, messageId: source.messageId,
    ordinal: i + 1, format: "txt", filename: "same.txt", mediaType: "text/plain", byteSize: 5,
    status: "ready", objectKey: `message-artifacts/${source.userId}/${source.conversationId}/${i}.txt`,
    lineageId: source.id, parentArtifactId: source.id, createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)),
  })) });
  const first = await list(source); assert.equal(first.artifacts.length, 50); assert.ok(first.nextCursor);
  const second = await list(source, { cursor: first.nextCursor }); assert.equal(second.artifacts.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.artifacts, ...second.artifacts].map(row => row.id)).size, 52);
  assert.ok(first.artifacts[0].createdAt > first.artifacts[49].createdAt);
});

test("a generated upload cannot bind or resolve lineage in a different conversation", async () => {
  const source = await seed(), upload = await prepare(source), conversationId = randomUUID();
  await prisma.conversation.create({ data: { id: conversationId, userId: source.userId, title: "Revision", selectedModels: '["gpt-6-luna"]' } });
  await assert.rejects(bind({ ...source, conversationId }, upload.uploadId), { code: "ATTACHMENT_UPLOAD_FORBIDDEN" });
  await assert.rejects(storage.resolveMessageAttachmentReferences({ userId: source.userId,
    ownPrefix: storage.accountAttachmentPrefix(source.email), conversationId, references: [{ uploadId: upload.uploadId }] }), { code: "ATTACHMENT_NOT_FOUND" });
});

test("resend copies preserve independent snapshots after the original output is deleted", async () => {
  const source = await seed(), upload = await prepare(source), bound = await bind(source, upload.uploadId);
  await prisma.message.delete({ where: { id: source.messageId } });
  const { saveMessagesWithAttachmentReferences } = await import("@/lib/messageAttachmentResend");
  const messageId = randomUUID();
  await saveMessagesWithAttachmentReferences({ userId: source.userId, conversationId: source.conversationId,
    ownPrefix: storage.accountAttachmentPrefix(source.email), beforeCreate: async () => {},
    messages: [{ id: messageId, content: "Retry", attachmentReferences: [{ attachmentId: bound.id }] }] });
  const copied = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId } });
  assert.equal(copied.sourceArtifactId, null); assert.equal(copied.sourceLineageId, source.id);
  assert.deepEqual(copied.sourceCanonicalSpec, source.canonical); assert.notEqual(copied.objectKey, bound.objectKey);
});

test("flag-off ordinary generation stores no canonical content or lineage even from an in-flight revision", async () => {
  const source = await seed(); process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "false";
  const rendered = render(source.canonical.spec);
  const stored = await artifactStorage.putArtifactObject({ userId: source.userId, conversationId: source.conversationId,
    ordinal: 1, format: "xlsx", filename: "new.xlsx", mediaType: rendered.mediaType, bytes: rendered.bytes,
    modelId: "gpt-6-luna", canonicalSpec: source.canonical, parentArtifactId: source.id, lineageId: source.id });
  assert.equal(stored.canonicalSpec, undefined);
  assert.equal(stored.parentArtifactId, undefined); assert.equal(stored.lineageId, undefined);
  await prisma.$transaction(tx => artifactStorage.persistArtifactRows(tx, { userId: source.userId,
    conversationId: source.conversationId, messageId: source.messageId,
    stored: [{ ...stored, parentArtifactId: source.id, lineageId: source.id, canonicalSpec: source.canonical }], failed: [] }));
  const row = await prisma.messageArtifact.findUniqueOrThrow({ where: { id: stored.id } });
  assert.equal(row.canonicalSpec, null); assert.equal(row.parentArtifactId, null); assert.equal(row.lineageId, null);
});

test("account JSON includes the owner's retained canonical content but no storage keys or foreign content", async () => {
  const source = await seed(), foreign = await seed(), upload = await prepare(source); await bind(source, upload.uploadId);
  const { buildAccountDataExport } = await import("@/lib/accountDataExport");
  const exported = await buildAccountDataExport(source.userId), serialized = JSON.stringify(exported);
  assert.ok(serialized.includes("SENSITIVE_CELL")); assert.ok(serialized.includes("canonicalSpec"));
  assert.ok(serialized.includes("sourceCanonicalSpec")); assert.ok(!serialized.includes(foreign.id));
  assert.ok(!serialized.includes("message-artifacts/")); assert.ok(!serialized.includes("attachments/"));
});

test("migration checks reject malformed or incomplete canonical provenance", async () => {
  const source = await seed();
  await assert.rejects(prisma.messageArtifact.update({ where: { id: source.id }, data: { canonicalSpec: { version: 99, kind: "spreadsheet", spec: {} } } }));
  await assert.rejects(prisma.messageArtifact.update({ where: { id: source.id }, data: { canonicalSpec: { version: 1, kind: "spreadsheet" } } }));
  await assert.rejects(prisma.messageAttachmentUpload.create({ data: { userId: source.userId,
    name: "bad.xlsx", mediaType: "text/plain", size: 2, kind: "file", objectKey: "fixture/incomplete",
    sourceArtifactId: source.id } }));
});

test("account deletion collects canonical metadata, bound and unbound independent copies", async () => {
  const source = await seed(), boundUpload = await prepare(source), unbound = await prepare(source);
  await bind(source, boundUpload.uploadId);
  const keys = [...objects.keys()];
  assert.equal(keys.length, 3); assert.ok(unbound.uploadId);
  await prisma.$transaction(async tx => {
    await artifactStorage.enqueueArtifactCleanupForUser(tx, source.userId, "account_deleted");
    await storage.enqueueMessageAttachmentCleanupForUser(tx, source.userId, "account_deleted");
    await tx.user.delete({ where: { id: source.userId } });
  });
  assert.equal(await prisma.messageArtifact.count(), 0); assert.equal(await prisma.messageAttachment.count(), 0);
  assert.equal(await prisma.messageAttachmentUpload.count(), 0);
  await artifactStorage.drainArtifactCleanupQueue(); await storage.drainMessageAttachmentCleanupQueue();
  for (const key of keys) assert.equal(objects.has(key), false);
});

async function waitForObjectWaiters(count: number) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
    if (row.waiting >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("The fixture did not reach its shared object lock.");
}

test("bind wins a concurrent discard: the registered bound copy and original are never deleted", async () => {
  const source = await seed(), upload = await prepare(source);
  let ready!: () => void, release!: () => void;
  const bound = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const messageId = randomUUID();
  const binder = prisma.$transaction(async tx => {
    await tx.message.create({ data: { id: messageId, conversationId: source.conversationId, role: "user", content: "Bind first" } });
    await storage.bindMessageAttachments(tx, { userId: source.userId, conversationId: source.conversationId,
      messageId, uploadIds: [upload.uploadId], ownPrefix: storage.accountAttachmentPrefix(source.email) });
    ready(); await gate;
  });
  await bound;
  const discard = storage.discardUnboundUpload({ userId: source.userId, uploadId: upload.uploadId });
  try { await waitForObjectWaiters(1); } finally { release(); }
  await binder; assert.deepEqual(await discard, { removed: false, kept: true });
  const row = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId } });
  await storage.drainMessageAttachmentCleanupQueue();
  assert.deepEqual(objects.get(row.objectKey), objects.get(source.objectKey));
  assert.ok(objects.has(source.objectKey));
});

test("discard wins a concurrent bind: the late bind rolls back and cannot resurrect a tombstoned object", async () => {
  const source = await seed(), upload = await prepare(source);
  const row = await prisma.messageAttachmentUpload.findUniqueOrThrow({ where: { id: upload.uploadId } });
  const sourceHash = createHash("sha256").update(objects.get(source.objectKey)!).digest("hex");
  let locked!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attachment-object:${row.objectKey}`}, 0))`;
    locked(); await gate;
  });
  await ready;
  const discard = storage.discardUnboundUpload({ userId: source.userId, uploadId: upload.uploadId });
  let binding: Promise<unknown>;
  try {
    await waitForObjectWaiters(1);
    binding = bind(source, upload.uploadId).then(() => null, error => error);
    await waitForObjectWaiters(2);
  } finally { release(); }
  await holder; assert.deepEqual(await discard, { removed: true, kept: false });
  assert.equal(((await binding!) as { code?: string } | null)?.code, "UNKNOWN_ATTACHMENT_UPLOAD");
  assert.equal(await prisma.messageAttachment.count(), 0);
  assert.equal(await prisma.messageAttachmentUpload.count(), 0);
  assert.equal(objects.has(row.objectKey), false);
  assert.equal(createHash("sha256").update(objects.get(source.objectKey)!).digest("hex"), sourceHash);
  await assert.rejects(storage.registerFinalizedUpload({ userId: source.userId, objectKey: row.objectKey,
    ownPrefix: storage.accountAttachmentPrefix(source.email), name: row.name, mediaType: row.mediaType,
    size: row.size, kind: "file" }));
});
