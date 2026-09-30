import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_PARTIAL_MAX_CHARACTERS,
  createChatResponseAttemptCheckpointWriter,
} from "../lib/chatDurableAttemptStream.ts";

const attemptRow = (input, revision) => ({
  assistantMessageId: input.assistantMessageId,
  userId: input.userId,
  conversationId: "conversation_1",
  sourceUserMessageId: "source_1",
  fingerprint: "a".repeat(64),
  requestedModelId: "provider/model",
  actualModelId: input.actualModelId ?? null,
  provider: input.provider ?? null,
  status: "streaming",
  partialContent: input.partialContent,
  checkpointRevision: revision,
  ownerId: input.ownerId,
  leaseExpiresAt: input.leaseExpiresAt,
  finishReason: null,
  failureCode: null,
  terminalAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

test("flush always performs a fresh lease/owner CAS even below the coalescing step", async () => {
  const calls = [];
  const writer = createChatResponseAttemptCheckpointWriter(
    {
      userId: "user_1",
      assistantMessageId: "assistant_1",
      ownerId: "worker_1",
      initialRevision: 0,
      requestedModelId: "provider/model",
    },
    async (input) => {
      calls.push(input);
      return attemptRow(input, calls.length);
    }
  );
  writer.observe("short");
  const first = await writer.flush("short");
  assert.equal(calls.length, 1);
  assert.equal(first.revision, 1);
  assert.equal(first.partialContent, "short");

  const second = await writer.flush("short");
  assert.equal(calls.length, 2);
  assert.equal(second.revision, 2);
});

test("checkpoint content is a stable first-100k prefix", async () => {
  const calls = [];
  const writer = createChatResponseAttemptCheckpointWriter(
    {
      userId: "user_1",
      assistantMessageId: "assistant_1",
      ownerId: "worker_1",
      initialRevision: 0,
      requestedModelId: "provider/model",
    },
    async (input) => {
      calls.push(input);
      return attemptRow(input, calls.length);
    }
  );
  const content = "x".repeat(CHAT_DURABLE_PARTIAL_MAX_CHARACTERS + 10);
  const result = await writer.flush(content);
  assert.equal(result.partialContent.length, CHAT_DURABLE_PARTIAL_MAX_CHARACTERS);
  assert.equal(calls.at(-1).partialContent, content.slice(0, CHAT_DURABLE_PARTIAL_MAX_CHARACTERS));
});

test("a small visible prefix is checkpointed when no later chunk arrives", async () => {
  const calls = [];
  const writer = createChatResponseAttemptCheckpointWriter(
    {
      userId: "user_1",
      assistantMessageId: "assistant_1",
      ownerId: "worker_1",
      initialRevision: 0,
      requestedModelId: "provider/model",
    },
    async (input) => {
      calls.push(input);
      return attemptRow(input, calls.length);
    }
  );
  writer.observe("visible");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].partialContent, "visible");
});
