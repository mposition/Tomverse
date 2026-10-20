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
let conversation: Row = { kind: "chat" };
let source: Row = { content: "  간단한 고양이 아이콘 그려줘 " };
let existing: Row = null;
let groups: Array<{ id: string; groupIdempotencyKey: string }> = [];
const requests: Array<Record<string, unknown>> = [];
const created: Array<Record<string, unknown>> = [];
let groupQueries = 0;
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
            reused: false,
            targets: [
              { targetId: "t1", modelId: "gpt-image-2", provider: "openai", generationId: "gen-1", status: "pending", reservedCredits: 15 },
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
  conversation = { kind: "chat" };
  source = { content: "  간단한 고양이 아이콘 그려줘 " };
  existing = null;
  groups = [];
  requests.length = 0;
  created.length = 0;
  groupQueries = 0;
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

test("someone else's conversation, an image conversation, or no question: nothing is reserved", async () => {
  const { turn } = await load();
  reset();
  conversation = null;
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_NOT_FOUND");
  reset();
  conversation = { kind: "image" };
  await rejects(() => turn.startChatImageTurn(input), "CONVERSATION_KIND_NOT_SUPPORTED");
  reset();
  source = null;
  await rejects(() => turn.startChatImageTurn(input), "SOURCE_MESSAGE_NOT_FOUND");
  assert.equal(requests.length, 0);
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
  groups = [{ id: "group-9", groupIdempotencyKey: "a2" }];
  const withImage = await read.attachChatImageTurns("user-1", "conv-1", [
    ...plain,
    { id: "a2", role: "assistant", content: "[Image generated] cat" },
  ]);
  assert.equal(groupQueries, 1);
  assert.deepEqual(withImage.at(-1), {
    id: "a2",
    role: "assistant",
    content: "[Image generated] cat",
    imageTurn: { groupId: "group-9" },
  });
  assert.equal("imageTurn" in withImage[1], false);
});
