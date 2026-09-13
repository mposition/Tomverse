import assert from "node:assert/strict";
import test from "node:test";

import {
  draftAttachmentReferences,
  isActiveChatResponseAttempt,
  mergeChatResponseAttempts,
  messageFromChatResponseAttempt,
  parseChatDraftConflict,
  parseChatDraftMessageReceipt,
  parseChatDraftResponse,
  parseChatMessageSaveResponse,
  parseMessageSaveMapping,
  parsePublicChatDraft,
  parsePublicChatResponseAttempt,
  replaceAttemptBackedMessage,
  sameDraftSnapshot,
} from "../components/chat/chatDurableRecoveryClient.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-8222-8222-222222222222";

const boundAttachment = (overrides = {}) => ({
  id: "bound_attachment_1",
  messageId: MESSAGE_ID,
  ordinal: 0,
  name: "notes.pdf",
  mediaType: "application/pdf",
  size: 44,
  kind: "file",
  attachmentId: "bound_attachment_1",
  ...overrides,
});

test("message save acknowledgement is strict and validates every attachment binding", () => {
  const valid = {
    success: true,
    created: 1,
    draftConsumed: true,
    messageMappings: [{ requestId: REQUEST_ID, messageId: MESSAGE_ID }],
    attachments: [boundAttachment()],
  };
  assert.deepEqual(parseChatMessageSaveResponse(valid, {
    requestId: REQUEST_ID,
    expectedAttachmentCount: 1,
  })?.attachments.map(({ id, ordinal }) => ({ id, ordinal })), [{
    id: "bound_attachment_1", ordinal: 0,
  }]);

  for (const malformed of [
    null,
    {},
    { ...valid, draftConsumed: false },
    { ...valid, draftConsumed: undefined },
    { ...valid, created: undefined },
    { ...valid, messageMappings: [] },
    { ...valid, messageMappings: [{ requestId: REQUEST_ID, messageId: REQUEST_ID }] },
    { ...valid, messageMappings: [{ requestId: MESSAGE_ID, messageId: MESSAGE_ID }] },
    { ...valid, attachments: [] },
    { ...valid, attachments: [boundAttachment({ id: "" })] },
    { ...valid, attachments: [boundAttachment({ ordinal: 1 })] },
    { ...valid, attachments: [boundAttachment({ messageId: REQUEST_ID })] },
  ]) {
    assert.equal(parseChatMessageSaveResponse(malformed, {
      requestId: REQUEST_ID,
      expectedAttachmentCount: 1,
    }), null);
  }

  assert.equal(parseChatMessageSaveResponse({
    ...valid,
    attachments: [boundAttachment(), boundAttachment({ id: "bound_attachment_2" })],
  }, { requestId: REQUEST_ID, expectedAttachmentCount: 2 }), null,
  "duplicate ordinals cannot satisfy a complete binding");

  assert.deepEqual(parseMessageSaveMapping(valid, REQUEST_ID), {
    requestId: REQUEST_ID,
    messageId: MESSAGE_ID,
  });
  assert.equal(parseMessageSaveMapping({ ...valid, messageMappings: [] }, REQUEST_ID), null);
});

test("message receipt parser rejects malformed outcomes and committed attachment maps", () => {
  assert.deepEqual(parseChatDraftMessageReceipt({
    outcome: "committed",
    requestId: REQUEST_ID,
    messageId: MESSAGE_ID,
    attachments: [boundAttachment({ messageId: undefined })],
  }, { requestId: REQUEST_ID, expectedAttachmentCount: 1 })?.attachments.map(({ id, ordinal }) => ({ id, ordinal })), [{
    id: "bound_attachment_1", ordinal: 0,
  }]);
  assert.deepEqual(parseChatDraftMessageReceipt({
    outcome: "unchanged", attachments: [],
  }, { requestId: REQUEST_ID, expectedAttachmentCount: 1 }), { outcome: "unchanged", attachments: [] });

  for (const malformed of [
    null,
    {},
    { outcome: "committed", requestId: REQUEST_ID, messageId: MESSAGE_ID, attachments: [] },
    { outcome: "committed", requestId: MESSAGE_ID, messageId: MESSAGE_ID, attachments: [boundAttachment({ messageId: undefined })] },
    { outcome: "committed", requestId: REQUEST_ID, messageId: "not-a-uuid", attachments: [boundAttachment({ messageId: undefined })] },
    { outcome: "committed", requestId: REQUEST_ID, messageId: MESSAGE_ID, attachments: [boundAttachment({ id: "", messageId: undefined })] },
    { outcome: "committed", requestId: REQUEST_ID, messageId: MESSAGE_ID, attachments: [boundAttachment({ ordinal: 4, messageId: undefined })] },
    { outcome: "unchanged", attachments: [boundAttachment()] },
    { outcome: "invented", attachments: [] },
  ]) {
    assert.equal(parseChatDraftMessageReceipt(malformed, {
      requestId: REQUEST_ID,
      expectedAttachmentCount: 1,
    }), null);
  }
});

const attempt = (overrides = {}) => ({
  assistantMessageId: "assistant_1",
  conversationId: "conversation_1",
  sourceUserMessageId: "user_1",
  requestedModelId: "gpt-5-6-luna",
  actualModelId: null,
  provider: null,
  status: "streaming",
  partialContent: "durable partial",
  checkpointRevision: 2,
  finishReason: null,
  failureCode: null,
  terminalAt: null,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:01.000Z",
  ...overrides,
});

test("draft parser allowlists safe attachment metadata", () => {
  const parsed = parsePublicChatDraft({
    scopeKey: "conversation_1",
    text: "Unsent",
    attachmentReferences: [{ attachmentId: "attachment_1" }],
    attachments: [{
      id: "attachment_1",
      ordinal: 0,
      name: "notes.pdf",
      mediaType: "application/pdf",
      size: 44,
      kind: "file",
      attachmentId: "attachment_1",
      objectKey: "must-not-cross-client-boundary",
      data: "data:must-not-cross-client-boundary",
    }],
    revision: 3,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:01.000Z",
  });
  assert.ok(parsed);
  assert.equal(parsed.attachments[0].name, "notes.pdf");
  assert.equal("objectKey" in parsed.attachments[0], false);
  assert.equal("data" in parsed.attachments[0], false);
});

test("draft parser refuses a malformed or partial public snapshot", () => {
  const valid = {
    scopeKey: "conversation_1",
    text: "x",
    attachmentReferences: [{ attachmentId: "attachment_1" }],
    attachments: [{
      id: "attachment_1",
      ordinal: 0,
      name: "one.txt",
      mediaType: "text/plain",
      size: 1,
      kind: "text",
      attachmentId: "attachment_1",
    }],
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
  };
  assert.equal(parsePublicChatDraft(null), null);
  assert.equal(parsePublicChatDraft({ revision: 1 }), null);
  assert.equal(parsePublicChatDraft({
    scopeKey: "conversation_1", text: "x", attachmentReferences: [],
    attachments: [{ id: "x" }], revision: 1,
    createdAt: "now", updatedAt: "now",
  }), null);
  assert.equal(parsePublicChatDraft(valid, "conversation_2"), null);
  assert.equal(parsePublicChatDraft({
    ...valid,
    attachments: [{ ...valid.attachments[0], attachmentId: "attachment_2" }],
  }, "conversation_1"), null);
  assert.equal(parsePublicChatDraft({
    ...valid,
    attachmentReferences: [{
      attachmentId: "attachment_1",
      uploadId: "upload_1",
    }],
  }, "conversation_1"), null);
  assert.equal(parsePublicChatDraft({
    ...valid,
    attachments: [{ ...valid.attachments[0], ordinal: 1 }],
  }, "conversation_1"), null);
});

test("draft conflict parser accepts only a coherent server snapshot", () => {
  const currentDraft = {
    scopeKey: "conversation_1",
    text: "server winner",
    attachmentReferences: [],
    attachments: [],
    revision: 4,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:01.000Z",
  };
  assert.deepEqual(parseChatDraftConflict({
    code: "CHAT_DRAFT_REVISION_CONFLICT",
    currentRevision: null,
    currentDraft: null,
  }, "conversation_1"), { currentRevision: 0, currentDraft: null });
  assert.deepEqual(parseChatDraftConflict({
    code: "CHAT_DRAFT_REVISION_CONFLICT",
    currentRevision: 4,
    currentDraft,
  }, "conversation_1"), { currentRevision: 4, currentDraft });
  assert.deepEqual(parseChatDraftConflict({
    code: "CHAT_DRAFT_ATTACHMENT_INVALID",
    currentRevision: 4,
    currentDraft,
  }, "conversation_1"), { currentRevision: 4, currentDraft });
  for (const malformed of [
    null,
    {},
    { code: "OTHER", currentRevision: null, currentDraft: null },
    { code: "CHAT_DRAFT_REVISION_CONFLICT" },
    { code: "CHAT_DRAFT_REVISION_CONFLICT", currentRevision: 4, currentDraft: null },
    { code: "CHAT_DRAFT_REVISION_CONFLICT", currentRevision: null, currentDraft },
    {
      code: "CHAT_DRAFT_REVISION_CONFLICT",
      currentRevision: 3,
      currentDraft,
    },
    {
      code: "CHAT_DRAFT_REVISION_CONFLICT",
      currentRevision: 4,
      currentDraft: { ...currentDraft, text: undefined },
    },
  ]) {
    assert.equal(parseChatDraftConflict(malformed, "conversation_1"), null);
  }
});

test("draft response parser requires an explicit scoped draft envelope", () => {
  const draft = {
    scopeKey: "conversation_1",
    text: "server",
    attachmentReferences: [],
    attachments: [],
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
  };
  assert.deepEqual(parseChatDraftResponse({ draft: null }, "conversation_1"), {
    draft: null,
  });
  assert.deepEqual(parseChatDraftResponse({ draft }, "conversation_1"), { draft });
  assert.equal(parseChatDraftResponse({}, "conversation_1"), null);
  assert.equal(parseChatDraftResponse({ draft: undefined }, "conversation_1"), null);
  assert.equal(parseChatDraftResponse({ draft }, "conversation_2"), null);
});

test("draft writes use opaque references only and wait for unfinished uploads", () => {
  assert.deepEqual(draftAttachmentReferences([
    { id: "one", name: "one", mediaType: "text/plain", size: 1, kind: "text", uploadId: "upload_1" },
    { id: "two", name: "two", mediaType: "text/plain", size: 2, kind: "text", attachmentId: "attachment_2", objectKey: "ignored" },
  ]), [{ uploadId: "upload_1" }, { attachmentId: "attachment_2" }]);
  assert.equal(draftAttachmentReferences([
    { id: "pending", name: "pending", mediaType: "text/plain", size: 1, kind: "text" },
  ]), null);
});

test("snapshot comparison is ordered and identity based", () => {
  const first = { id: "one", name: "a", mediaType: "text/plain", size: 1, kind: "text", uploadId: "up_1" };
  const second = { id: "two", name: "b", mediaType: "text/plain", size: 1, kind: "text", uploadId: "up_2" };
  assert.equal(sameDraftSnapshot(
    { text: "x", attachments: [first, second] },
    { text: "x", attachments: [{ ...first }, { ...second }] }
  ), true);
  assert.equal(sameDraftSnapshot(
    { text: "x", attachments: [first, second] },
    { text: "x", attachments: [second, first] }
  ), false);
  assert.equal(sameDraftSnapshot(
    { text: "x", attachments: [first] },
    { text: "x", attachments: [{ ...first, id: "server-generated-id" }] }
  ), true, "the upload reference, not an ephemeral client id, owns identity");
  assert.equal(sameDraftSnapshot(
    { text: "x", attachments: [{ ...first, attachmentId: "bound_1", uploadId: undefined }] },
    { text: "x", attachments: [{ ...first, id: "hydrated-id", attachmentId: "bound_1", uploadId: undefined }] }
  ), true, "a durable attachment reference survives hydration ids changing");
});

test("attempt parser is strict on required public state", () => {
  const parsed = parsePublicChatResponseAttempt(attempt());
  assert.ok(parsed);
  assert.equal(isActiveChatResponseAttempt(parsed), true);
  assert.equal(parsePublicChatResponseAttempt(attempt({ checkpointRevision: -1 })), null);
  assert.equal(parsePublicChatResponseAttempt(attempt({ status: "invented" })), null);
});

test("attempt recovery is inserted after its source question and canonical Message wins", () => {
  const source = { id: "user_1", role: "user", content: "Question" };
  const later = { id: "user_2", role: "user", content: "Later" };
  const merged = mergeChatResponseAttempts(
    [source, later],
    [attempt()],
    "gpt-5-6-luna",
    "Interrupted"
  );
  assert.deepEqual(merged.messages.map((message) => message.id), [
    "user_1", "assistant_1", "user_2",
  ]);
  assert.equal(merged.messages[1].content, "durable partial");
  assert.equal(merged.attemptBackedIds.has("assistant_1"), true);

  const canonical = { id: "assistant_1", role: "assistant", content: "Stored answer", modelId: "gpt-5-6-luna" };
  const canonicalMerge = mergeChatResponseAttempts(
    [source, canonical, later],
    [attempt({ partialContent: "stale partial" })],
    "gpt-5-6-luna",
    "Interrupted"
  );
  assert.equal(canonicalMerge.messages[1].content, "Stored answer");
  assert.equal(canonicalMerge.attemptBackedIds.size, 0);
});

test("conversation recovery includes an active attempt from the previously selected model", () => {
  const source = { id: "user_1", role: "user", content: "Question" };
  const priorModelAttempt = attempt({ requestedModelId: "gpt-5-6-luna" });
  const modelScoped = mergeChatResponseAttempts(
    [source],
    [priorModelAttempt],
    "claude-sonnet-5",
    "Interrupted",
    "model"
  );
  assert.equal(modelScoped.attemptBackedIds.size, 0);

  const conversationScoped = mergeChatResponseAttempts(
    [source],
    [priorModelAttempt],
    "claude-sonnet-5",
    "Interrupted",
    "conversation"
  );
  assert.equal(conversationScoped.attemptBackedIds.has("assistant_1"), true);
});

test("an empty pre-dispatch refusal does not create a phantom assistant bubble", () => {
  const source = { id: "user_1", role: "user", content: "Question" };
  const merged = mergeChatResponseAttempts(
    [source],
    [attempt({
      status: "failed",
      partialContent: "",
      // The terminal transition itself advances the durable revision. A real
      // pre-dispatch refusal is therefore revision 1, not the impossible 0
      // fixture this regression originally used.
      checkpointRevision: 1,
      finishReason: "error",
      failureCode: "request_refused",
      terminalAt: "2026-09-13T00:00:01.000Z",
    })],
    "gpt-5-6-luna",
    "Interrupted"
  );
  assert.deepEqual(merged.messages, [source]);
  assert.equal(merged.attemptBackedIds.size, 0);
});

test("a refusal with a committed prefix remains visible", () => {
  const source = { id: "user_1", role: "user", content: "Question" };
  const merged = mergeChatResponseAttempts(
    [source],
    [attempt({
      status: "failed",
      partialContent: "A provider-visible prefix",
      checkpointRevision: 2,
      finishReason: "error",
      failureCode: "request_refused",
      terminalAt: "2026-09-13T00:00:01.000Z",
    })],
    "gpt-5-6-luna",
    "Interrupted"
  );
  assert.equal(merged.messages.at(-1)?.content, "A provider-visible prefix");
  assert.equal(merged.attemptBackedIds.has("assistant_1"), true);
});

test("poll replacement only changes messages proven to be attempt-backed", () => {
  const terminal = attempt({
    status: "failed",
    partialContent: "kept prefix",
    checkpointRevision: 3,
    finishReason: "error",
    failureCode: "worker_lease_expired",
    terminalAt: "2026-09-13T00:01:00.000Z",
  });
  const backed = messageFromChatResponseAttempt(attempt(), "Interrupted");
  const replaced = replaceAttemptBackedMessage(
    [backed],
    terminal,
    new Set(["assistant_1"]),
    "Interrupted"
  );
  assert.equal(replaced[0].content, "kept prefix");
  assert.equal(replaced[0].status, "error");
  assert.equal(replaced[0].recoveryNotice, "Interrupted");

  const canonical = { ...backed, content: "canonical" };
  assert.equal(
    replaceAttemptBackedMessage([canonical], terminal, new Set(), "Interrupted")[0].content,
    "canonical"
  );
});
