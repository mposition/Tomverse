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
};

test("the /api/chat transcript never carries the memory-used count", () => {
  const serialized = toChatRequestMessage(memoryAnswer);
  assert.equal("memoryUsedCount" in serialized, false);
  assert.equal(serialized.content, memoryAnswer.content);
});

test("the guest snapshot never carries the memory-used count", () => {
  // A guest has no account memory at all, so a persisted count could only
  // ever be wrong -- but the allowlist is what makes that structural rather
  // than a thing to remember.
  const persisted = toGuestPersistableMessage(memoryAnswer);
  assert.equal("memoryUsedCount" in persisted, false);
});

/**
 * The Auto routing badge's inputs are read from a response header on the turn
 * that produced them. Persisting them would let a reload show a routing
 * decision the current answer may not have been given -- and sending them back
 * in a transcript would be the client telling the server what the server
 * decided.
 */
const routedAnswer: Message = {
  id: "m-3",
  role: "assistant",
  content: "라우팅된 답변입니다.",
  status: "normal",
  modelId: "deepseek-v4-flash",
  createdAt: "2026-08-22T00:00:00.000Z",
  routedModelId: "deepseek-v4-flash",
  routedReason: "quality_band",
};

test("the /api/chat transcript never carries the routed model or reason", () => {
  const serialized = toChatRequestMessage(routedAnswer);
  assert.equal("routedModelId" in serialized, false);
  assert.equal("routedReason" in serialized, false);
  // The model that answered is still transported: that is `modelId`, which is
  // a fact about the message, not a claim about who chose it.
  assert.equal(serialized.modelId, "deepseek-v4-flash");
});

test("the guest snapshot never carries the routed model or reason", () => {
  // A guest is outside the cohort and can never be routed, so a persisted
  // routing decision could only ever be wrong -- but the allowlist is what
  // makes that structural rather than a thing to remember.
  const persisted = toGuestPersistableMessage(routedAnswer);
  assert.equal("routedModelId" in persisted, false);
  assert.equal("routedReason" in persisted, false);
});
