// Contract: a Tomverse Chat image turn reserves through requestImageGeneration
// on the chat conversation itself, keyed by the assistant message id, with the
// saved question as the prompt -- and only while the operator has it on.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

type Row = Record<string, unknown> | null;
let triageOn = true;
let conversation: Row = { kind: "chat", productKey: "chat", continuationBridge: null };
let source: Row = { content: "  간단한 고양이 아이콘 그려줘 " };
let existing: Row = null;
let groups: Array<{ id: string; groupIdempotencyKey: string; targets: Array<{ modelId: string }> }> = [];
const requests: Array<Record<string, unknown>> = [];
const created: Array<Record<string, unknown>> = [];
let groupQueries = 0;
let reused = false;
let replayStatus = "pending";
let mocksInstalled = false;

const prismaMock = {
  conversation: {
    findFirst: async () => conversation,
    update: async () => ({}),
  },
  message: {
    findFirst: async () => source,
    findUnique: async () => existing,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return data;
    },
  },
  imageGenerationGroup: {
    findMany: async () => {
      groupQueries += 1;
      return groups;
    },
  },
};

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaMock } });
    mock.module(mod("lib/chatImageIntent.ts"), {
      namedExports: { chatImageTriageModelId: async () => (triageOn ? "gpt-6-luna" : null) },
    });
    mock.module(mod("lib/imageEditSource.ts"), {
      namedExports: {
        // A landscape photo on the question.
        findChatImageEditSource: async () => ({ attachmentId: "att-1", size: "1536x1024" }),
      },
    });
    mock.module(mod("lib/imageGenerationService.ts"), {
      namedExports: {
        requestImageGeneration: async (input: Record<string, unknown>) => {
          requests.push(input);
          return {
            generationId: "gen-1",
            groupId: "group-1",
            conversationId: input.conversationId,
            status: "pending",
            reservedCredits: 15,
            reused,
            targets: [
              { targetId: "t1", modelId: "gpt-image-2", provider: "openai", generationId: "gen-1", status: reused ? replayStatus : "pending", reservedCredits: 15 },
            ],
          };
        },
      },
    });
  }
  return {
    turn: await import(mod("lib/chatImageTurn.ts")),
    read: await import(mod("lib/chatImageTurnRead.ts")),
  };
}

const reset = () => {
  triageOn = true;
  conversation = { kind: "chat", productKey: "chat", continuationBridge: null };
  source = { content: "  간단한 고양이 아이콘 그려줘 " };
  existing = null;
  groups = [];
  requests.length = 0;
  created.length = 0;
  groupQueries = 0;
  reused = false;
  replayStatus = "pending";
};

const input = {
  userId: "user-1",
  conversationId: "conv-1",
  sourceUserMessageId: "msg-user",
  assistantMessageId: "6f1c1d3e-1111-4a2b-9c3d-000000000001",
  modelId: "gpt-6-luna",
  imageModelIds: ["gpt-image-2"],
  preset: "draft" as const,
};

const rejects = async (fn: () => Promise<unknown>, code: string) => {
  await assert.rejects(fn, (error: unknown) => (error as { code?: string }).code === code);
};

test("an image turn reserves on the chat conversation, keyed by the answer id", async () => {
  reset();
  const { turn } = await load();
  const result = await turn.startChatImageTurn(input);
  assert.deepEqual(result, {
    groupId: "group-1",
    imageModelIds: ["gpt-image-2"],
    content: "[Image generated] 간단한 고양이 아이콘 그려줘",
    pendingGenerationIds: ["gen-1"],
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(
    {
      prompt: requests[0].prompt,
      quality: requests[0].quality,
      size: requests[0].size,
      conversationId: requests[0].conversationId,
      idempotencyKey: requests[0].idempotencyKey,
      modelIds: requests[0].modelIds,
      chatTurnHost: requests[0].chatTurnHost,
    },
    {
      prompt: "간단한 고양이 아이콘 그려줘",
      quality: "low",
      size: "1024x1024",
      conversationId: "conv-1",
      idempotencyKey: input.assistantMessageId,
      modelIds: ["gpt-image-2"],
      chatTurnHost: true,
    }
  );
  assert.deepEqual(created, [
    {
      id: input.assistantMessageId,
      conversationId: "conv-1",
      role: "assistant",
      content: "[Image generated] 간단한 고양이 아이콘 그려줘",
      modelId: "gpt-6-luna",
    },
  ]);
});

test("no preset is standard; no models is the default model", async () => {
  reset();
  const { turn } = await load();
  await turn.startChatImageTurn({ ...input, preset: null, imageModelIds: [] });
  assert.equal(requests[0].quality, "medium");
  assert.equal(requests[0].modelIds, undefined);
});

test("switched off, nothing is reserved", async () => {
  reset();
  triageOn = false;
  const { turn } = await load();
  await rejects(() => turn.startChatImageTurn(input), "CHAT_IMAGE_TURN_DISABLED");
  assert.equal(requests.length, 0);
});

test("someone else's, an image or a continued conversation, or no question: nothing is reserved", async () => {
  const { turn } = await load();
  reset();
  conversation = null;
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_NOT_FOUND");
  reset();
  conversation = { kind: "image" };
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_KIND_NOT_SUPPORTED");
  reset();
  conversation = { kind: "chat", productKey: "studio", continuationBridge: null };
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_KIND_NOT_SUPPORTED");
  reset();
  conversation = { kind: "chat", productKey: "chat", continuationBridge: { id: "bridge" } };
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_KIND_NOT_SUPPORTED");
  reset();
  source = null;
  await rejects(() => turn.startChatImageTurn(input), "SOURCE_MESSAGE_NOT_FOUND");
  assert.equal(requests.length, 0);
});

test("Explicit Review image answers keep the original conversation and shared reservation", async () => {
  const { turn } = await load();
  for (const productKey of ["review"]) {
    reset(); triageOn = false;
    conversation = { kind: "chat", productKey, continuationBridge: null };
    await turn.startChatImageTurn(input);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, input.conversationId);
    assert.equal(requests[0].chatTurnHost, true);
    assert.equal(created[0].modelId, input.modelId);
  }
});

test("locked Review conversations refuse before any image reservation", async () => {
  const { turn } = await load();
  for (const extra of [{ password: "locked-password" }]) {
    reset();
    conversation = { kind: "chat", productKey: "review", continuationBridge: null, ...extra };
    await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_LOCKED");
    assert.equal(requests.length, 0);
  }
});

test("a replay reuses the answer and its group key; a foreign answer id is refused", async () => {
  const { turn } = await load();
  reset();
  existing = { conversationId: "conv-1", role: "assistant", content: "[Image generated] earlier" };
  const result = await turn.startChatImageTurn(input);
  assert.equal(result.content, "[Image generated] earlier");
  assert.equal(created.length, 0);
  assert.equal(requests[0].idempotencyKey, input.assistantMessageId);
  reset();
  existing = { conversationId: "other", role: "assistant", content: "x" };
  await rejects(() => turn.startChatImageTurn(input), "ASSISTANT_MESSAGE_CONFLICT");
  assert.equal(requests.length, 0);
  reset();
  // A text answer's id: replaying it would charge for an image no transcript shows.
  existing = { conversationId: "conv-1", role: "assistant", content: "a text answer" };
  await rejects(() => turn.startChatImageTurn(input), "ASSISTANT_MESSAGE_CONFLICT");
  assert.equal(requests.length, 0);
});

test("the transcript read attaches groups only to image answers", async () => {
  const { read } = await load();
  reset();
  const plain = [
    { id: "u", role: "user", content: "hi" },
    { id: "a", role: "assistant", content: "hello" },
  ];
  assert.deepEqual(await read.attachChatImageTurns("user-1", "conv-1", plain), plain);
  assert.equal(groupQueries, 0);
  groups = [{ id: "group-9", groupIdempotencyKey: "a2", targets: [{ modelId: "gpt-image-2" }] }];
  const withImage = await read.attachChatImageTurns("user-1", "conv-1", [
    ...plain,
    { id: "a2", role: "assistant", content: "[Image generated] cat" },
  ]);
  assert.equal(groupQueries, 1);
  assert.deepEqual(withImage.at(-1), {
    id: "a2",
    role: "assistant",
    content: "[Image generated] cat",
    imageTurn: { groupId: "group-9", modelIds: ["gpt-image-2"] },
  });
  assert.equal("imageTurn" in withImage[1], false);
});

test("a replay starts work that never ran, and leaves started work alone", async () => {
  const { turn } = await load();
  reset();
  reused = true;
  existing = { conversationId: "conv-1", role: "assistant", content: "[Image generated] cat" };
  assert.deepEqual((await turn.startChatImageTurn(input)).pendingGenerationIds, ["gen-1"]);
  reset();
  reused = true;
  replayStatus = "processing";
  existing = { conversationId: "conv-1", role: "assistant", content: "[Image generated] cat" };
  assert.deepEqual((await turn.startChatImageTurn(input)).pendingGenerationIds, []);
});

test("a follow-up makes the image from its rewrite; the answer names the question", async () => {
  reset();
  const { turn } = await load();
  const result = await turn.startChatImageTurn({ ...input, prompt: "  a simple blue cat icon " });
  assert.equal(requests[0].prompt, "a simple blue cat icon");
  assert.equal(result.content, "[Image generated] 간단한 고양이 아이콘 그려줘");
});


test("unclassified conversations cannot gain Review image authority with the Chat switch off", async () => {
  const { turn } = await load();
  reset(); triageOn = false;
  conversation = { kind: "chat", productKey: null, continuationBridge: null };
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_KIND_NOT_SUPPORTED");
  assert.equal(requests.length, 0);
});

test("invalid comparison suffixes refuse before reserving images", async () => {
  const { turn } = await load();
  for (const suffix of ["999", "no-index", "-1"]) {
    reset();
    conversation = { kind: "chat", productKey: "review", continuationBridge: null };
    await rejects(() => turn.startChatImageTurn({ ...input, assistantMessageId: `${input.assistantMessageId}_${suffix}`,
      imageGroupModelIds: input.imageModelIds }), "IMAGE_MODEL_SELECTION_INVALID");
    assert.equal(requests.length, 0);
  }
});

test("an edit keeps the photo's shape only where every model sells that size", async () => {
  reset();
  const { turn } = await load();
  await turn.startChatImageTurn({ ...input, edit: true });
  assert.equal(requests[0].size, "1536x1024");
  assert.deepEqual(requests[0].editSource, { attachmentId: "att-1" });
  // Grok Imagine sells only the 1K square, so its edit is square.
  reset();
  await turn.startChatImageTurn({
    ...input,
    assistantMessageId: "6f1c1d3e-1111-4a2b-9c3d-000000000009",
    imageModelIds: ["grok-imagine-image-quality-20260403"],
    edit: true,
  });
  assert.equal(requests[0].size, "1024x1024");
});
