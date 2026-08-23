import assert from "node:assert/strict";
import test from "node:test";
import {
  toChatRequestMessage,
  toGuestPersistableMessage,
} from "../lib/chatMessageSerialization";
import type { Message } from "../components/chat/types";

/**
 * Persistence boundary for the per-message error report context.
 *
 * The serializers are allowlists: `errorReport` (and with it the raw
 * errorReportToken) must never reach the /api/chat transcript or the guest
 * localStorage snapshot, whatever new fields Message grows. A reload that
 * loses the token is by design -- the report then verifies as missing_token.
 */

const errorMessage: Message = {
  id: "m-1",
  role: "assistant",
  content: "오류가 발생했습니다.",
  status: "error",
  modelId: "gpt-5-6-luna",
  errorCode: "AI_PROVIDER_ERROR",
  errorHadAttachments: false,
  createdAt: "2026-08-03T00:00:00.000Z",
  errorReport: {
    traceId: "11111111-2222-4333-8444-555555555555",
    traceProvenance: "server_generated",
    errorReportToken: "terr1.payload.signature",
    errorCode: "AI_PROVIDER_ERROR",
    errorClassificationSource: "server",
    occurredAt: "2026-08-03T00:00:00.000Z",
  },
};

test("the /api/chat transcript never carries errorReport", () => {
  const serialized = toChatRequestMessage(errorMessage);
  assert.equal("errorReport" in serialized, false);
  assert.equal(JSON.stringify(serialized).includes("terr1."), false);
  // The transport fields themselves survive.
  assert.equal(serialized.id, "m-1");
  assert.equal(serialized.content, "오류가 발생했습니다.");
  assert.equal(serialized.errorCode, "AI_PROVIDER_ERROR");
});

test("the guest localStorage snapshot never carries errorReport", () => {
  const persisted = toGuestPersistableMessage(errorMessage);
  assert.equal("errorReport" in persisted, false);
  assert.equal(JSON.stringify(persisted).includes("errorReportToken"), false);
});

test("attachment data is stripped only when the bytes live in object storage", () => {
  const withAttachments: Message = {
    id: "m-2",
    role: "user",
    content: "hello",
    attachments: [
      {
        id: "a-1",
        name: "photo.png",
        mediaType: "image/png",
        size: 10,
        data: "data:image/png;base64,AAAA",
        objectKey: "guest/a-1",
        kind: "file",
      },
      {
        id: "a-2",
        name: "notes.txt",
        mediaType: "text/plain",
        size: 4,
        data: "abcd",
        kind: "text",
      },
    ],
  };
  const serialized = toChatRequestMessage(withAttachments);
  assert.equal(serialized.attachments?.[0].data, undefined);
  assert.equal(serialized.attachments?.[0].objectKey, "guest/a-1");
  // An inline-only attachment (no objectKey) keeps its data: stripping it
  // would lose the only copy of the bytes.
  assert.equal(serialized.attachments?.[1].data, "abcd");
});

test("a message without runtime-only fields round-trips unchanged", () => {
  const plain: Message = {
    id: "m-3",
    role: "assistant",
    content: "안녕하세요",
    status: "normal",
    searchMetadata: null,
  };
  assert.deepEqual(toChatRequestMessage(plain), plain);
});

/**
 * §13.4's count is server-computed and is never a client claim. Keeping it
 * out of the transcript is what makes that true across a resend: a persisted
 * count would come back as an assertion about an answer nobody re-counted,
 * and the request would then carry the client's number.
 */
const memoryAnswer: Message = {
  id: "m-2",
  role: "assistant",
  content: "답변입니다.",
  status: "normal",
  modelId: "gpt-5-6-luna",
  createdAt: "2026-08-04T00:00:00.000Z",
  memoryUsedCount: 3,
  knowledgeChunkCount: 2,
};

test("the /api/chat transcript never carries the context counts", () => {
  const serialized = toChatRequestMessage(memoryAnswer);
  assert.equal("memoryUsedCount" in serialized, false);
  // docs/policy/external-conversation-import-and-memory.md §14.3: the same exclusion,
  // and it needs no code of its own --
  // pickTransportFields is an allowlist, so a new runtime-only field is out
  // by default. This asserts that property rather than a line of code.
  assert.equal("knowledgeChunkCount" in serialized, false);
  assert.equal(serialized.content, memoryAnswer.content);
});

test("the guest snapshot never carries the context counts", () => {
  // A guest has no account memory and no assistant profile at all, so a
  // persisted count could only ever be wrong -- but the allowlist is what
  // makes that structural rather than a thing to remember.
  const persisted = toGuestPersistableMessage(memoryAnswer);
  assert.equal("memoryUsedCount" in persisted, false);
  assert.equal("knowledgeChunkCount" in persisted, false);
});

/**
 * The attachment reference boundary (docs/policy/user-attachment-persistence.md).
 *
 * A signed-in composer holds an opaque id, never a storage key, and the
 * transcript carries whichever id actually identifies the file: the durable
 * attachment row once the message is saved, the upload before that. Sending
 * both would be asking the server which of its own facts to prefer.
 */
test("a signed-in attachment travels as an opaque id, never as a key", () => {
  const message: Message = {
    id: "m-4",
    role: "user",
    content: "",
    attachments: [
      {
        id: "local-1",
        name: "계약서.docx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 2048,
        uploadId: "upl_1",
        kind: "file",
      },
    ],
  };
  const serialized = toChatRequestMessage(message);
  assert.equal(serialized.attachments?.[0].uploadId, "upl_1");
  assert.equal(serialized.attachments?.[0].objectKey, undefined);
  assert.equal(JSON.stringify(serialized).includes("attachments/"), false);
});

test("the durable attachment id wins once the message has been saved", () => {
  const message: Message = {
    id: "m-5",
    role: "user",
    content: "이 파일 봐 주세요",
    attachments: [
      {
        id: "local-1",
        name: "보고서.pdf",
        mediaType: "application/pdf",
        size: 4096,
        uploadId: "upl_1",
        attachmentId: "ma_1",
        kind: "file",
      },
    ],
  };
  const serialized = toChatRequestMessage(message);
  assert.equal(serialized.attachments?.[0].attachmentId, "ma_1");
  assert.equal(serialized.attachments?.[0].uploadId, undefined);
});

test("an image preview is dropped once the bytes are in storage, by any id", () => {
  const message: Message = {
    id: "m-6",
    role: "user",
    content: "",
    attachments: [
      {
        id: "local-1",
        name: "photo.png",
        mediaType: "image/png",
        size: 10,
        data: "data:image/png;base64,AAAA",
        uploadId: "upl_2",
        kind: "file",
      },
      {
        id: "local-2",
        name: "shot.png",
        mediaType: "image/png",
        size: 10,
        data: "data:image/png;base64,BBBB",
        attachmentId: "ma_2",
        kind: "file",
      },
    ],
  };
  const serialized = toChatRequestMessage(message);
  assert.equal(serialized.attachments?.[0].data, undefined);
  assert.equal(serialized.attachments?.[1].data, undefined);
});

// A file-only turn is a complete turn. It used to be stored as the file names
// joined with commas, because the save endpoint demanded text.
test("a message with attachments and no text keeps its empty content", () => {
  const message: Message = {
    id: "m-7",
    role: "user",
    content: "",
    attachments: [
      {
        id: "local-1",
        name: "명단.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 512,
        attachmentId: "ma_3",
        kind: "file",
      },
    ],
  };
  const serialized = toChatRequestMessage(message);
  assert.equal(serialized.content, "");
  assert.equal(serialized.content.includes("명단"), false);
});
