import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let state, copied, readKeys, storageFailure, failDb, capacityFailure, capacityChecks;
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) =>
  value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value
);
const table = (name) => ({
  findUnique: async ({ where }) => state[name].find((row) => matches(row, where)) ?? null,
  findFirst: async ({ where }) => state[name].find((row) => matches(row, where)) ?? null,
  findMany: async ({ where } = {}) => state[name].filter((row) => matches(row, where)).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)),
  create: async ({ data }) => { const row = { id: randomUUID(), boundAt: null, ...data }; state[name].push(row); return row; },
  createMany: async ({ data }) => {
    if (name === "messages" && failDb) throw new Error("database refused");
    let count = 0;
    for (const candidate of data) {
      if (state[name].some((row) => (candidate.id && row.id === candidate.id) || (candidate.objectKey && row.objectKey === candidate.objectKey) || (name === "attachments" && row.messageId === candidate.messageId && row.ordinal === candidate.ordinal))) continue;
      state[name].push({ id: randomUUID(), boundAt: null, ...candidate,
        ...(name === "messages" ? { conversation: { userId: "owner" } } : {}) }); count++;
    }
    return { count };
  },
  updateMany: async ({ where, data }) => {
    const rows = state[name].filter((row) => matches(row, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length };
  },
});
const db = {
  message: table("messages"), messageAttachment: table("attachments"),
  messageAttachmentUpload: table("uploads"), messageAttachmentCleanup: table("cleanup"),
  conversation: { findUnique: async ({ where }) => where.id === "conversation" ? { userId: "owner", password: null } : null },
};
const prisma = { ...db, $transaction: async (callback) => {
  const snapshot = structuredClone(state);
  try { return await callback(db); } catch (error) { state = snapshot; throw error; }
} };
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
mock.module(mod("lib/r2.ts"), { namedExports: {
  readOwnR2ObjectBytes: async (key, { maxBytes }) => {
    readKeys.push(key); if (storageFailure) throw storageFailure;
    assert.equal(maxBytes, 4); return Buffer.from("test");
  },
  writeR2Object: async (key, bytes) => { assert.equal(bytes.toString(), "test"); copied.push(key); },
  deleteR2Object: async () => { assert.fail("The save route must queue cleanup, never delete inline."); },
} });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner", email: "owner@example.invalid" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { isEnabledRuntimeModelId: async () => true } });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  hasConversationUnlockGrant: () => true, conversationLockedResponse: () => new Response(null, { status: 423 }),
} });
mock.module(mod("lib/generatedArtifactStorage.ts"), { namedExports: { enqueueArtifactCleanupForMessages: async () => {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {},
  assertMessageCapacity: async () => { capacityChecks++; if (capacityFailure) throw new Error("capacity refused"); },
  readLimitedJson: async (req, _limit, schema) => schema.parse(await req.json()),
  apiSecurityResponse: (error) => error instanceof ZodError ? Response.json({ code: "INVALID_REQUEST" }, { status: 400 }) : null,
} });
const { accountAttachmentPrefix } = await import(mod("lib/messageAttachmentStorage.ts"));
const { POST } = await import(mod("app/api/conversations/[conversationId]/messages/route.ts"));
const prefix = accountAttachmentPrefix("owner@example.invalid");
const message = (overrides = {}) => ({ id: randomUUID(), role: "user", content: "", attachmentReferences: [{ attachmentId: "source" }], ...overrides });
const save = (messages, conversationId = "conversation") => POST(new Request(`https://example.invalid/api/conversations/${conversationId}/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }),
}), { params: Promise.resolve({ conversationId }) });
test.beforeEach(() => {
  state = { messages: [], uploads: [], cleanup: [], attachments: [{
    id: "source", userId: "owner", conversationId: "conversation", messageId: "old-question", ordinal: 0,
    objectKey: `${prefix}original.txt`, name: "original.txt", mediaType: "text/plain", size: 4, kind: "text", unavailableAt: null,
  }] };
  copied = []; readKeys = []; storageFailure = null; failDb = false; capacityFailure = false; capacityChecks = 0;
});

test("actual route and helper persist a restored attachment-only question and return public new IDs", async () => {
  const prompt = message(), response = await save([prompt]); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.created, 1); assert.equal(body.attachments.length, 1);
  const card = body.attachments[0]; assert.equal(card.messageId, prompt.id); assert.equal(card.ordinal, 0); assert.notEqual(card.id, "source");
  assert.equal(JSON.stringify(body).includes(prefix), false); assert.equal("uploadId" in card, false); assert.equal("objectKey" in card, false);
  assert.equal(copied.length, 1); assert.equal(state.cleanup.length, 0); assert.equal(state.attachments[0].objectKey, `${prefix}original.txt`);
});
test("actual route keeps mixed fresh/stored order and idempotent readback without recopy", async () => {
  state.uploads.push({ id: "fresh", userId: "owner", objectKey: `${prefix}fresh.txt`, name: "fresh.txt", mediaType: "text/plain", size: 4, kind: "text", boundAt: null });
  const prompt = message({ attachmentReferences: [{ uploadId: "fresh" }, { attachmentId: "source" }] });
  const first = await (await save([prompt])).json();
  assert.deepEqual(first.attachments.map((row) => [row.ordinal, row.name]), [[0, "fresh.txt"], [1, "original.txt"]]);
  capacityFailure = true; // Fully persisted new-format readback does not reserve quota.
  const again = await (await save([prompt])).json(); assert.equal(again.created, 0); assert.deepEqual(again.attachments, first.attachments);
  assert.equal(copied.length, 1); assert.equal(state.cleanup.length, 0);
});
test("strict route schema rejects ambiguous, excessive, duplicate and client-metadata references before copying", async () => {
  const invalid = [
    message({ attachmentReferences: [{ attachmentId: "source", uploadId: "fresh" }] }),
    message({ attachmentReferences: [{ attachmentId: "source", objectKey: "stolen" }] }),
    message({ attachmentReferences: [{ attachmentId: "source", name: "override" }] }),
    message({ attachmentReferences: [{ attachmentId: "source" }, { attachmentId: "source" }] }),
    message({ attachmentReferences: [{ uploadId: "fresh" }, { uploadId: "fresh" }] }),
    message({ attachmentReferences: Array.from({ length: 6 }, (_, i) => ({ attachmentId: `source${i}` })) }),
    message({ attachmentReferences: [{}] }), message({ attachmentReferences: [] }),
    message({ attachmentUploadIds: ["fresh"] }),
  ];
  for (const prompt of invalid) assert.equal((await save([prompt])).status, 400);
  const duplicate = message(); assert.equal((await save([duplicate, { ...duplicate, content: "other" }])).status, 400);
  assert.deepEqual(readKeys, []); assert.deepEqual(copied, []); assert.equal(capacityChecks, 0);
});
test("route rejects wrong conversation and source ownership including same owner in another conversation", async () => {
  assert.equal((await save([message()], "not-owned")).status, 403);
  for (const field of ["userId", "conversationId"]) {
    const previous = state.attachments[0][field]; state.attachments[0][field] = "someone-else";
    assert.equal((await save([message()])).status, 410); state.attachments[0][field] = previous;
  }
  assert.equal((await save([message({ attachmentReferences: [{ attachmentId: "missing" }] })])).status, 410);
  assert.deepEqual(copied, []); assert.equal(state.messages.length, 0);
});
test("missing and transient storage errors produce safe 410/503 before message persistence", async () => {
  storageFailure = Object.assign(new Error("sensitive source detail"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  let response = await save([message()]); assert.equal(response.status, 410); assert.equal((await response.json()).code, "ATTACHMENT_UNAVAILABLE");
  storageFailure = Object.assign(new Error("sensitive source detail"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  response = await save([message()]); assert.equal(response.status, 503);
  const text = await response.text(); assert.ok(text.includes("ATTACHMENT_STORAGE_UNAVAILABLE")); assert.equal(text.includes("sensitive"), false);
  assert.equal(state.messages.length, 0); assert.equal(state.attachments[0].unavailableAt, null);
});
test("database failure queues only new copies while capacity failure copies nothing", async () => {
  capacityFailure = true; assert.equal((await save([message()])).status, 500); assert.equal(copied.length, 0);
  capacityFailure = false; failDb = true; assert.equal((await save([message()])).status, 500);
  assert.deepEqual(state.cleanup.map((row) => row.objectKey), copied); assert.equal(state.messages.length, 0);
  assert.equal(state.cleanup.some((row) => row.objectKey.endsWith("original.txt")), false);
});
test("new reference replay cannot use a foreign message id or an assistant row", async () => {
  const prompt = message();
  state.messages.push({ id: prompt.id, role: "assistant", conversationId: "conversation", conversation: { userId: "owner" } });
  assert.equal((await save([prompt])).status, 409);
  state.messages[0].role = "user"; state.messages[0].conversation.userId = "other";
  assert.equal((await save([prompt])).status, 409); assert.deepEqual(copied, []);
});
test("legacy upload-only save and its already-bound refusal remain unchanged", async () => {
  state.uploads.push({ id: "fresh", userId: "owner", objectKey: `${prefix}fresh.txt`, name: "fresh.txt", mediaType: "text/plain", size: 4, kind: "text", boundAt: null });
  const prompt = { id: randomUUID(), role: "user", content: "", attachmentUploadIds: ["fresh"] };
  assert.equal((await save([prompt])).status, 200); assert.equal((await save([prompt])).status, 200);
  const other = await save([{ ...prompt, id: randomUUID() }]); assert.equal(other.status, 400);
  assert.equal((await other.json()).code, "ATTACHMENT_ALREADY_BOUND"); assert.deepEqual(copied, []);
});
