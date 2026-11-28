// Contract: a Review image group and every panel's answer are written in one
// transaction, so a panel whose own request the image allowance refuses (429)
// still has its paid image in the conversation, and nothing is paid for that
// the transcript cannot show.

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

type MessageRow = { id: string; conversationId: string; role: string; content: string; modelId?: string | null };
type GroupRow = { id: string; conversationId: string; groupIdempotencyKey: string; targets: Array<{ modelId: string }> };

const GROUP = "6f1c1d3e-1111-4a2b-9c3d-0000000000aa";
const IMAGES = ["fal-ai/nano-banana-2", "gpt-image-2"]; // sorted: index 0, 1
const PANELS = ["google-chat", "openai-chat"]; // in IMAGES order

let messages = new Map<string, MessageRow>();
let groups: GroupRow[] = [];
let locks: string[] = [];
let requests: Array<Record<string, unknown>> = [];
let messageCount = 0;
// A racing writer: runs inside the named transaction ("reserve" or "replay")
// with its rows, at the read before the answers ("read") or at their insert.
let race: { tag: string; at: "read" | "insert"; write: (rows: Map<string, MessageRow>) => void } | null = null;
let conversationUpdates = 0;
let mocksInstalled = false;

const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

/** A transaction client over a copy of the rows, committed only on success. */
const makeTx = (rows: Map<string, MessageRow>, tag: string) => ({
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    locks.push(`${tag}:${String(values[0] ?? strings.join(""))}`);
    return 1;
  },
  $queryRaw: async () => [{ count: BigInt(messageCount), bytes: BigInt(0) }],
  message: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      if (race?.tag === tag && race.at === "read") race.write(rows);
      return where.id.in.flatMap((id) => (rows.has(id) ? [{ ...rows.get(id)! }] : []));
    },
    count: async () => messageCount,
    createMany: async ({ data, skipDuplicates }: { data: MessageRow[]; skipDuplicates?: boolean }) => {
      assert.notEqual(skipDuplicates, true, "a panel answer is never skipped");
      if (race?.tag === tag && race.at === "insert") race.write(rows);
      // The unique index sees rows committed by others since the read, too.
      for (const row of data) if (rows.has(row.id) || messages.has(row.id)) throw uniqueViolation();
      for (const row of data) rows.set(row.id, { ...row });
      return { count: data.length };
    },
  },
});

const transaction = async <T>(tag: string, fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
  const staged = new Map([...messages].map(([id, row]) => [id, { ...row }]));
  const result = await fn(makeTx(staged, tag));
  for (const [id, row] of staged) messages.set(id, row);
  return result;
};

const prismaMock = {
  conversation: {
    findFirst: async () => ({ kind: "chat", productKey: "review", continuationBridge: null, archivedAt: null, password: null }),
    update: async () => {
      conversationUpdates += 1;
      return {};
    },
  },
  message: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      if (where.role === "user") return { content: "a red fox" };
      const row = messages.get(String(where.id));
      return row && row.conversationId === where.conversationId && row.role === "assistant" &&
        row.content.startsWith((where.content as { startsWith: string }).startsWith)
        ? { id: row.id, role: row.role, content: row.content } : null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = messages.get(where.id);
      return row ? { conversationId: row.conversationId, role: row.role, content: row.content } : null;
    },
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.flatMap((id) => (messages.has(id) ? [{ ...messages.get(id)! }] : [])),
    create: async ({ data }: { data: MessageRow }) => {
      if (messages.has(data.id)) throw uniqueViolation();
      messages.set(data.id, { ...data });
      return data;
    },
  },
  imageGenerationGroup: {
    findMany: async ({ where }: { where: { groupIdempotencyKey: { in: string[] } } }) =>
      groups.filter((group) => where.groupIdempotencyKey.in.includes(group.groupIdempotencyKey)),
  },
  $transaction: (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => transaction("replay", fn),
};

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaMock } });
    mock.module(mod("lib/chatImageIntent.ts"), {
      namedExports: { chatImageTriageModelId: async () => "gpt-6-luna" },
    });
    mock.module(mod("lib/imageGenerationService.ts"), {
      namedExports: {
        requestImageGeneration: async (input: Record<string, unknown>) => {
          requests.push(input);
          const key = String(input.idempotencyKey);
          const modelIds = input.modelIds as string[];
          let group = groups.find((item) => item.groupIdempotencyKey === key);
          const reused = Boolean(group);
          if (!group) {
            // The reservation transaction: account and scope locks, then
            // onReserved, then the group -- all or nothing.
            await transaction("reserve", async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"credit-account:user-1"}))`;
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"image-scope:user-1"}))`;
              await (input.onReserved as ((tx: unknown, id: string) => Promise<unknown>) | undefined)?.(tx, String(input.conversationId));
            });
            group = {
              id: `group-${groups.length + 1}`,
              conversationId: String(input.conversationId),
              groupIdempotencyKey: key,
              targets: modelIds.map((modelId) => ({ modelId })),
            };
            groups.push(group);
          }
          return {
            groupId: group.id,
            conversationId: group.conversationId,
            reused,
            targets: group.targets.map((target, index) => ({
              modelId: target.modelId,
              generationId: `gen-${index}`,
              status: reused ? "processing" : "pending",
            })),
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
  messages = new Map();
  groups = [];
  locks = [];
  requests = [];
  messageCount = 0;
  race = null;
  conversationUpdates = 0;
  delete process.env.API_MAX_MESSAGES_PER_CONVERSATION;
};

const panelInput = (index: number, extra: Record<string, unknown> = {}) => ({
  userId: "user-1",
  conversationId: "conv-1",
  sourceUserMessageId: "msg-user",
  assistantMessageId: `${GROUP}_${index}`,
  modelId: PANELS[index],
  imageModelIds: [IMAGES[index]],
  imageGroupModelIds: IMAGES,
  imageGroupPanelModelIds: PANELS,
  preset: "standard" as const,
  ...extra,
});

const rejects = async (fn: () => Promise<unknown>, code: string) => {
  await assert.rejects(fn, (error: unknown) => (error as { code?: string }).code === code);
};

test("the panel that reserves the group writes every panel's answer in the reservation", async () => {
  reset();
  const { turn, read } = await load();
  const result = await turn.startChatImageTurn(panelInput(1));
  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0].onReserved, "function");
  assert.deepEqual(result.imageModelIds, ["gpt-image-2"]);
  assert.deepEqual(result.pendingGenerationIds, ["gen-0", "gen-1"]);
  assert.deepEqual(
    [...messages.values()].map(({ id, role, modelId }) => ({ id, role, modelId })),
    [
      { id: `${GROUP}_0`, role: "assistant", modelId: "google-chat" },
      { id: `${GROUP}_1`, role: "assistant", modelId: "openai-chat" },
    ]
  );
  // The quota lock is taken inside the reservation, after its account and
  // scope locks -- the order every other message writer uses.
  assert.deepEqual(locks, [
    "reserve:credit-account:user-1",
    "reserve:image-scope:user-1",
    "reserve:messages:user-1",
  ]);
  assert.equal(conversationUpdates, 1);

  // The other panel's own request never landed (the 429): its answer and its
  // image are in the transcript all the same, and the read endpoint finds it.
  const transcript = await read.attachChatImageTurns("user-1", "conv-1", [...messages.values()]);
  assert.deepEqual(transcript.map((row: { imageTurn?: unknown }) => row.imageTurn), [
    { groupId: "group-1", modelIds: ["fal-ai/nano-banana-2"] },
    { groupId: "group-1", modelIds: ["gpt-image-2"] },
  ]);
  const sibling = await read.readChatImageTurnAnswer({
    userId: "user-1", conversationId: "conv-1", assistantMessageId: `${GROUP}_0`, request: new Request("http://x"),
  });
  assert.deepEqual(sibling, {
    content: "[Image generated] a red fox",
    imageTurn: { groupId: "group-1", modelIds: ["fal-ai/nano-banana-2"] },
  });
});

test("a later panel of a reserved group reserves nothing and writes nothing", async () => {
  reset();
  const { turn } = await load();
  await turn.startChatImageTurn(panelInput(0));
  locks = [];
  conversationUpdates = 0;
  const result = await turn.startChatImageTurn(panelInput(1));
  assert.equal(groups.length, 1);
  assert.equal(messages.size, 2);
  assert.deepEqual(result.imageModelIds, ["gpt-image-2"]);
  assert.deepEqual(locks, []);
  assert.equal(conversationUpdates, 0);
});

test("a sibling id held by another row refuses before anything is reserved", async () => {
  const { turn } = await load();
  for (const held of [
    { conversationId: "other-conv", role: "assistant", content: "[Image generated] elsewhere" },
    { conversationId: "conv-1", role: "assistant", content: "a text answer" },
    { conversationId: "conv-1", role: "user", content: "[Image generated] typed by hand" },
  ]) {
    reset();
    messages.set(`${GROUP}_0`, { id: `${GROUP}_0`, ...held });
    await rejects(() => turn.startChatImageTurn(panelInput(1)), "ASSISTANT_MESSAGE_CONFLICT");
    assert.equal(requests.length, 0);
    assert.equal(groups.length, 0);
  }
});

test("a sibling id taken after the early check rolls the reservation back", async () => {
  const { turn } = await load();
  const foreign = { id: `${GROUP}_0`, conversationId: "conv-1", role: "assistant", content: "a text answer" };
  const imageAnswer = { ...foreign, content: "[Image generated] a racing image answer" };
  // Seen by the in-transaction read (a text answer), or only by the insert's
  // unique index (even an image answer: nothing is skipped).
  for (const [at, row] of [["read", foreign], ["insert", foreign], ["insert", imageAnswer]] as const) {
    reset();
    // A row the read sees is in this transaction's view; one only the insert
    // meets was committed by the racing writer after the read.
    race = { tag: "reserve", at, write: (rows) => (at === "read" ? rows : messages).set(row.id, { ...row }) };
    await rejects(() => turn.startChatImageTurn(panelInput(1)), "ASSISTANT_MESSAGE_CONFLICT");
    assert.equal(groups.length, 0, "no group commits without every panel's answer");
    assert.equal(messages.has(`${GROUP}_1`), false, "the reservation's rows roll back with it");
  }
});

test("a full message quota refuses the whole group, checked under the quota lock", async () => {
  reset();
  const { turn } = await load();
  process.env.API_MAX_MESSAGES_PER_CONVERSATION = "11";
  messageCount = 10; // room for one answer, not two
  await rejects(() => turn.startChatImageTurn(panelInput(0)), "MESSAGE_STORAGE_QUOTA_EXCEEDED");
  assert.equal(groups.length, 0);
  assert.equal(messages.size, 0);
  assert.ok(locks.includes("reserve:messages:user-1"));
  // With room for both, the same request reserves and writes them.
  process.env.API_MAX_MESSAGES_PER_CONVERSATION = "12";
  await turn.startChatImageTurn(panelInput(0));
  assert.equal(groups.length, 1);
  assert.equal(messages.size, 2);
});

test("the client's panel list is checked whole before anything is reserved", async () => {
  const { turn } = await load();
  for (const extra of [
    { imageGroupPanelModelIds: ["google-chat"] }, // wrong length
    { imageGroupPanelModelIds: ["openai-chat", "openai-chat"] }, // a panel twice
    { imageGroupPanelModelIds: ["openai-chat", "google-chat"] }, // own panel elsewhere
    { modelId: "claude-chat" }, // not this request's panel
    { imageGroupModelIds: undefined }, // a panel list without a group
  ]) {
    reset();
    await rejects(() => turn.startChatImageTurn(panelInput(1, extra)), "IMAGE_MODEL_SELECTION_INVALID");
    assert.equal(requests.length, 0);
  }
  reset();
  // An image model twice is refused (the group check or the panel check).
  await assert.rejects(() => turn.startChatImageTurn(panelInput(1, { imageGroupModelIds: ["gpt-image-2", "gpt-image-2"] })));
  assert.equal(requests.length, 0);
});

test("an older client keeps one answer per request", async () => {
  reset();
  const { turn } = await load();
  await turn.startChatImageTurn(panelInput(1, { imageGroupPanelModelIds: undefined }));
  assert.equal(requests[0].onReserved, undefined);
  assert.deepEqual([...messages.keys()], [`${GROUP}_1`]);
});

test("a replay of an older client's group writes the answers it lacks, all or none", async () => {
  reset();
  const { turn } = await load();
  // An older client's first panel: the group and its own answer only.
  await turn.startChatImageTurn(panelInput(1, { imageGroupPanelModelIds: undefined }));
  locks = [];
  conversationUpdates = 0;
  await turn.startChatImageTurn(panelInput(1));
  assert.equal(groups.length, 1);
  assert.deepEqual([...messages.keys()].sort(), [`${GROUP}_0`, `${GROUP}_1`]);
  assert.equal(messages.get(`${GROUP}_0`)?.modelId, "google-chat");
  assert.deepEqual(locks, ["replay:messages:user-1"]);
  assert.equal(conversationUpdates, 1);

  // A full quota writes none of them.
  reset();
  await turn.startChatImageTurn(panelInput(1, { imageGroupPanelModelIds: undefined }));
  process.env.API_MAX_MESSAGES_PER_CONVERSATION = "1";
  messageCount = 1;
  await rejects(() => turn.startChatImageTurn(panelInput(1)), "MESSAGE_STORAGE_QUOTA_EXCEEDED");
  assert.deepEqual([...messages.keys()], [`${GROUP}_1`]);
});

test("two replays racing for the same missing answers both succeed; a foreign row still refuses", async () => {
  reset();
  const { turn } = await load();
  await turn.startChatImageTurn(panelInput(1, { imageGroupPanelModelIds: undefined }));
  // The other replay commits the missing answer just before this insert.
  const racing = {
    id: `${GROUP}_0`, conversationId: "conv-1", role: "assistant", content: "[Image generated] a red fox", modelId: "google-chat",
  };
  race = { tag: "replay", at: "insert", write: () => messages.set(racing.id, { ...racing }) };
  const result = await turn.startChatImageTurn(panelInput(1));
  assert.deepEqual(result.imageModelIds, ["gpt-image-2"]);

  reset();
  await turn.startChatImageTurn(panelInput(1, { imageGroupPanelModelIds: undefined }));
  race = { tag: "replay", at: "insert", write: () =>
    messages.set(`${GROUP}_0`, { id: `${GROUP}_0`, conversationId: "conv-1", role: "assistant", content: "a text answer" }) };
  await rejects(() => turn.startChatImageTurn(panelInput(1)), "ASSISTANT_MESSAGE_CONFLICT");
});
