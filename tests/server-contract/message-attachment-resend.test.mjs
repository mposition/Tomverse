import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let state, copied, readKeys, storageFailure, failDb, capacityFailure, capacityChecks;
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
  if (value && typeof value === "object" && "in" in value) {
    return value.in.includes(row[key]);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Boolean(row[key]) && matches(row[key], value);
  }
  return row[key] === value;
});
const table = (name) => {
  const materialize = (row) => row && name === "messages"
    ? { ...row, attachments: state.attachments.filter((attachment) => attachment.messageId === row.id).sort((a, b) => a.ordinal - b.ordinal) }
    : row;
  return ({
  findUnique: async ({ where }) => materialize(state[name].find((row) => matches(row, where)) ?? null),
  findFirst: async ({ where }) => materialize(state[name].find((row) => matches(row, where)) ?? null),
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
};
const db = {
  message: table("messages"), messageAttachment: table("attachments"),
  messageAttachmentUpload: table("uploads"), messageAttachmentCleanup: table("cleanup"),
  chatComposerDraft: {
    findUnique: async ({ where }) => state.drafts.find((row) =>
      row.userId === where.userId_scopeKey.userId &&
      row.scopeKey === where.userId_scopeKey.scopeKey
    ) ?? null,
    deleteMany: async ({ where }) => {
      const before = state.drafts.length;
      state.drafts = state.drafts.filter((row) => !matches(row, where));
      return { count: before - state.drafts.length };
    },
  },
  conversation: { findUnique: async ({ where }) => where.id === "conversation" ? {
    userId: "owner", password: null,
    kind: state.conversationKind,
    productKey: state.conversationProductKey,
  } : null },
  $executeRaw: async () => 1,
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
const message = (overrides = {}) => ({ clientRequestId: randomUUID(), role: "user", content: "", attachmentReferences: [{ attachmentId: "source" }], ...overrides });
const save = (messages, conversationId = "conversation", draftConsume) => POST(new Request(`https://example.invalid/api/conversations/${conversationId}/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, ...(draftConsume ? { draftConsume } : {}) }),
}), { params: Promise.resolve({ conversationId }) });
test.beforeEach(() => {
  state = { conversationKind: "chat", conversationProductKey: "chat",
    messages: [], uploads: [], cleanup: [], drafts: [], attachments: [{
    id: "source", userId: "owner", conversationId: "conversation", messageId: "old-question", ordinal: 0,
    objectKey: `${prefix}original.txt`, name: "original.txt", mediaType: "text/plain", size: 4, kind: "text", unavailableAt: null,
  }] };
  copied = []; readKeys = []; storageFailure = null; failDb = false; capacityFailure = false; capacityChecks = 0;
});

test("actual route and helper persist a restored attachment-only question and return public new IDs", async () => {
  const prompt = message(), response = await save([prompt]); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.created, 1); assert.equal(body.attachments.length, 1);
  const mapping = body.messageMappings[0];
  assert.deepEqual(mapping.requestId, prompt.clientRequestId);
  assert.notEqual(mapping.messageId, prompt.clientRequestId);
  const card = body.attachments[0]; assert.equal(card.messageId, mapping.messageId); assert.equal(card.ordinal, 0); assert.notEqual(card.id, "source");
  assert.equal(JSON.stringify(body).includes(prefix), false); assert.equal("uploadId" in card, false); assert.equal("objectKey" in card, false);
  assert.equal(copied.length, 1); assert.equal(state.cleanup.length, 0); assert.equal(state.attachments[0].objectKey, `${prefix}original.txt`);
});
test("a pre-durable browser id remains an external request id across a rolling deploy", async () => {
  const legacyRequestId = randomUUID();
  const response = await save([{
    id: legacyRequestId,
    role: "user",
    content: "A tab opened before the deploy can finish one safe send.",
  }]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.messageMappings[0].requestId, legacyRequestId);
  assert.notEqual(body.messageMappings[0].messageId, legacyRequestId);
  assert.equal(state.messages.some((row) => row.id === legacyRequestId), false);

  const ambiguous = await save([{
    id: randomUUID(),
    clientRequestId: randomUUID(),
    role: "user",
    content: "Two identities are not accepted.",
  }]);
  assert.equal(ambiguous.status, 400);
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
test("a client request id copied from another Message is namespaced before any replay lookup", async () => {
  const prompt = message();
  state.messages.push({
    id: prompt.clientRequestId,
    role: "user",
    content: "victim",
    modelId: null,
    conversationId: "victim-conversation",
    conversation: { userId: "victim" },
  });
  const response = await save([prompt]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.messageMappings[0].requestId, prompt.clientRequestId);
  assert.notEqual(body.messageMappings[0].messageId, prompt.clientRequestId);
  assert.equal(state.messages.find((row) => row.id === prompt.clientRequestId).content, "victim");
});

test("victim UUID injection cannot bind text, fresh uploads or references to the victim Message", async () => {
  const variants = ["text", "upload", "reference"];
  for (const [index, variant] of variants.entries()) {
    const victimId = `${index + 3}3333333-3333-4333-8333-333333333333`;
    const victimAttachmentId = `victim-attachment-${index}`;
    state.messages.push({
      id: victimId,
      role: "user",
      content: "victim",
      modelId: null,
      conversationId: `victim-conversation-${index}`,
      conversation: { userId: "victim" },
    });
    state.attachments.push({
      id: victimAttachmentId,
      userId: "victim",
      conversationId: `victim-conversation-${index}`,
      messageId: victimId,
      ordinal: 0,
      objectKey: `victim/${index}.txt`,
      name: "private.txt",
      mediaType: "text/plain",
      size: 4,
      kind: "text",
      unavailableAt: null,
      uploadId: null,
      sourceAttachmentId: null,
    });
    if (variant === "upload") {
      state.uploads.push({
        id: `fresh-${index}`,
        userId: "owner",
        objectKey: `${prefix}fresh-${index}.txt`,
        name: "fresh.txt",
        mediaType: "text/plain",
        size: 4,
        kind: "text",
        boundAt: null,
      });
    }
    const prompt = message({
      clientRequestId: victimId,
      content: variant === "text" ? `safe ${variant}` : "",
      attachmentReferences: variant === "reference"
        ? [{ attachmentId: "source" }]
        : undefined,
      attachmentUploadIds: variant === "upload" ? [`fresh-${index}`] : undefined,
    });
    const response = await save([prompt]);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.messageMappings[0].requestId, victimId);
    assert.notEqual(body.messageMappings[0].messageId, victimId);
    const attackerMessage = state.messages.find(
      (row) => row.id === body.messageMappings[0].messageId
    );
    assert.equal(attackerMessage?.conversationId, "conversation");
    assert.equal(attackerMessage?.role, "user");
    assert.equal(
      state.attachments.filter((row) => row.messageId === victimId).length,
      1,
      `${variant} must not mutate the victim attachment set`
    );
    if (variant !== "text") {
      assert.equal(
        state.attachments.filter(
          (row) => row.messageId === body.messageMappings[0].messageId
        ).length,
        1,
        `${variant} must bind only to the attacker's derived Message`
      );
    }
  }
});

test("same scoped request is idempotent and a changed replay rolls the transaction back", async () => {
  const prompt = message({ content: "same request", attachmentReferences: undefined });
  const first = await (await save([prompt])).json();
  const second = await (await save([prompt])).json();
  assert.equal(first.messageMappings[0].messageId, second.messageMappings[0].messageId);
  assert.equal(second.created, 0);
  const changed = await save([{ ...prompt, content: "changed replay" }]);
  assert.equal(changed.status, 409);
  assert.equal(state.messages.find((row) => row.id === first.messageMappings[0].messageId).content, "same request");
});
test("mixed reference batches reject changed text and legacy-upload replays atomically", async () => {
  const assertMixedReplayRejected = async (original, changed) => {
    const first = await save([original]);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const messageId = firstBody.messageMappings[0].messageId;
    const beforeMessages = structuredClone(state.messages);
    const beforeAttachments = structuredClone(state.attachments);
    const readsBefore = readKeys.length;
    const copiesBefore = copied.length;
    const addedReference = message({ content: "new referenced turn" });

    const replay = await save([changed, addedReference]);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "MESSAGE_SAVE_CONFLICT");
    assert.deepEqual(state.messages, beforeMessages);
    assert.deepEqual(state.attachments, beforeAttachments);
    assert.equal(readKeys.length, readsBefore, "a doomed mixed replay must read no source bytes");
    assert.equal(copied.length, copiesBefore, "a doomed mixed replay must copy no object");
    assert.equal(state.messages.find((row) => row.id === messageId).content, original.content);
  };

  const text = message({ content: "original text", attachmentReferences: undefined });
  await assertMixedReplayRejected(text, { ...text, content: "changed text" });

  state = { ...state, messages: [], cleanup: [], attachments: state.attachments.slice(0, 1) };
  copied = [];
  const uploadId = "legacy-fresh";
  state.uploads.push({
    id: uploadId,
    userId: "owner",
    objectKey: `${prefix}legacy-fresh.txt`,
    name: "legacy-fresh.txt",
    mediaType: "text/plain",
    size: 4,
    kind: "text",
    boundAt: null,
  });
  const legacy = message({
    content: "legacy original",
    modelId: "gpt-5-6-luna",
    attachmentReferences: undefined,
    attachmentUploadIds: [uploadId],
  });
  await assertMixedReplayRejected(legacy, { ...legacy, modelId: "gemini-3-1-pro" });
});
test("missing and foreign opaque upload ids have one public response", async () => {
  state.uploads.push({
    id: "foreign-upload",
    userId: "somebody-else",
    objectKey: "attachments/somebody-else/foreign.txt",
    name: "foreign.txt",
    mediaType: "text/plain",
    size: 4,
    kind: "text",
    boundAt: null,
  });
  const request = (uploadId) => message({
    attachmentReferences: undefined,
    attachmentUploadIds: [uploadId],
  });
  const missing = await save([request("missing-upload")]);
  const foreign = await save([request("foreign-upload")]);

  assert.equal(missing.status, 400);
  assert.equal(foreign.status, 400);
  assert.equal(missing.headers.get("content-type"), foreign.headers.get("content-type"));
  assert.deepEqual(await missing.json(), await foreign.json());
  assert.deepEqual(await save([request("missing-upload")]).then((response) => response.json()), {
    error: "An attachment in this message is not available.",
    code: "ATTACHMENT_UNAVAILABLE",
  });
});
test("legacy upload-only save and its already-bound refusal remain unchanged", async () => {
  state.uploads.push({ id: "fresh", userId: "owner", objectKey: `${prefix}fresh.txt`, name: "fresh.txt", mediaType: "text/plain", size: 4, kind: "text", boundAt: null });
  const prompt = { clientRequestId: randomUUID(), role: "user", content: "", attachmentUploadIds: ["fresh"] };
  assert.equal((await save([prompt])).status, 200); assert.equal((await save([prompt])).status, 200);
  const other = await save([{ ...prompt, clientRequestId: randomUUID() }]); assert.equal(other.status, 400);
  assert.equal((await other.json()).code, "ATTACHMENT_ALREADY_BOUND"); assert.deepEqual(copied, []);
});

test("a direct duplicate cannot add, replace or remove legacy attachments", async () => {
  const original = message({
    content: "immutable request",
    attachmentReferences: undefined,
  });
  const first = await save([original]);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const storedId = firstBody.messageMappings[0].messageId;

  state.uploads.push({
    id: "late-upload",
    userId: "owner",
    objectKey: `${prefix}late.txt`,
    name: "late.txt",
    mediaType: "text/plain",
    size: 4,
    kind: "text",
    boundAt: null,
  });
  const lateAttachment = await save([{
    ...original,
    attachmentUploadIds: ["late-upload"],
  }]);
  assert.equal(lateAttachment.status, 409);
  assert.equal((await lateAttachment.json()).code, "MESSAGE_SAVE_CONFLICT");
  assert.equal(state.attachments.some((row) => row.messageId === storedId), false);
  assert.equal(state.uploads.find((row) => row.id === "late-upload").boundAt, null);

  const attached = message({
    content: "fixed attachment request",
    attachmentReferences: undefined,
    attachmentUploadIds: ["late-upload"],
  });
  const attachedSave = await save([attached]);
  assert.equal(attachedSave.status, 200);
  const attachedBody = await attachedSave.json();
  const attachedId = attachedBody.messageMappings[0].messageId;
  assert.equal(state.attachments.filter((row) => row.messageId === attachedId).length, 1);

  const removed = await save([{ ...attached, attachmentUploadIds: undefined }]);
  assert.equal(removed.status, 409);
  assert.equal((await removed.json()).code, "MESSAGE_SAVE_CONFLICT");
  assert.equal(state.attachments.filter((row) => row.messageId === attachedId).length, 1);
});

test("the actual message route atomically consumes scopeKey new with the first stored Message", async () => {
  const prompt = message({ content: "adopt this draft", attachmentReferences: undefined });
  state.drafts.push({
    userId: "owner",
    scopeKey: "new",
    revision: 1,
    text: prompt.content,
    attachmentReferences: [],
  });
  const response = await save([prompt], "conversation", {
    scopeKey: "new",
    expectedRevision: 1,
    requestId: prompt.clientRequestId,
  });
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.success, true);
  assert.equal(responseBody.created, 1);
  assert.equal(responseBody.draftConsumed, true);
  assert.deepEqual(responseBody.messageMappings[0].requestId, prompt.clientRequestId);
  assert.equal(state.drafts.length, 0);
  assert.equal(state.messages.some((row) => row.id === responseBody.messageMappings[0].messageId), true);
});

test("draftConsume is refused outside a stored Chat while an ordinary Review message stays unchanged", async () => {
  state.conversationProductKey = "review";
  const prompt = message({ content: "ordinary review message", attachmentReferences: undefined });
  state.drafts.push({
    userId: "owner", scopeKey: "conversation", revision: 1,
    text: prompt.content, attachmentReferences: [],
  });
  const refused = await save([prompt], "conversation", {
    scopeKey: "conversation", expectedRevision: 1, requestId: prompt.clientRequestId,
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "CHAT_DRAFT_CONSUME_NOT_SUPPORTED");
  assert.equal(state.drafts.length, 1);
  assert.equal(state.messages.length, 0);

  const ordinary = await save([{ ...prompt, clientRequestId: randomUUID() }]);
  assert.equal(ordinary.status, 200);
  assert.equal(state.messages.length, 1);
});

test("scopeKey new consumption rolls back when the Message insert fails", async () => {
  const prompt = message({ content: "keep this draft", attachmentReferences: undefined });
  state.drafts.push({
    userId: "owner",
    scopeKey: "new",
    revision: 1,
    text: prompt.content,
    attachmentReferences: [],
  });
  failDb = true;
  const response = await save([prompt], "conversation", {
    scopeKey: "new",
    expectedRevision: 1,
    requestId: prompt.clientRequestId,
  });
  assert.equal(response.status, 500);
  assert.equal(state.drafts.length, 1);
  assert.equal(state.messages.length, 0);
});

test("stale or altered draft consumption is refused before any attachment object read or copy", async () => {
  const prompt = message({ content: "protected draft" });
  state.drafts.push({
    userId: "owner",
    scopeKey: "conversation",
    revision: 1,
    text: prompt.content,
    attachmentReferences: [{ attachmentId: "source" }],
  });
  for (const candidate of [
    {
      prompt,
      draftConsume: { scopeKey: "conversation", expectedRevision: 2, requestId: prompt.clientRequestId },
    },
    {
      prompt: { ...prompt, content: "altered after snapshot" },
      draftConsume: { scopeKey: "conversation", expectedRevision: 1, requestId: prompt.clientRequestId },
    },
  ]) {
    const response = await save([candidate.prompt], "conversation", candidate.draftConsume);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MESSAGE_SAVE_CONFLICT");
    assert.deepEqual(readKeys, []);
    assert.deepEqual(copied, []);
    assert.equal(state.messages.length, 0);
    assert.equal(state.drafts.length, 1);
  }
});

test("a matching draft with a stored attachment still copies, binds and consumes", async () => {
  const prompt = message({ content: "valid protected draft" });
  state.drafts.push({
    userId: "owner",
    scopeKey: "conversation",
    revision: 1,
    text: prompt.content,
    attachmentReferences: [{ attachmentId: "source" }],
  });
  const response = await save([prompt], "conversation", {
    scopeKey: "conversation",
    expectedRevision: 1,
    requestId: prompt.clientRequestId,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.created, 1);
  assert.equal(body.draftConsumed, true);
  assert.equal(readKeys.length, 1);
  assert.equal(copied.length, 1);
  assert.equal(state.drafts.length, 0);
  assert.equal(state.messages.some((row) => row.id === body.messageMappings[0].messageId), true);
});
