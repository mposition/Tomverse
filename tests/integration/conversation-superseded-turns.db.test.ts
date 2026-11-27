import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * "Regenerate" and "edit your last message" mark the replaced turn on the
 * server (`Message.supersededAt`, lib/chatSupersededMessages.ts). Against real
 * rows, this proves the four things only the database can say:
 *
 *  - only the owner of an unlocked conversation writes the mark, and only to
 *    that conversation's rows, by either spelling of a message id;
 *  - the conversation read carries the mark;
 *  - POST /api/chat leaves marked turns out of what the provider is sent,
 *    whatever the client sent;
 *  - the chat route records the turn a send replaces in the transaction that
 *    saves the finished answer, and records nothing when no answer is saved.
 *
 * Its own process under scripts/run-db-integration-tests.mjs: `mock.module`
 * replaces next-auth (the session) and `ai` (the provider stream) for every
 * module in the process.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

const MODEL_ID = "claude-sonnet-5";
process.env.ANTHROPIC_API_KEY ||= "db-integration-test-key";

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

type Script = { text: string; fail: boolean };
let script: Script = { text: "a new answer", fail: false };
let providerMessages: unknown[] = [];

const require = createRequire(import.meta.url);
mock.module("ai", {
  namedExports: {
    ...(require("ai") as Record<string, unknown>),
    streamText: (options: Record<string, unknown>) => {
      providerMessages.push(options.messages);
      const { text, fail } = script;
      return {
        textStream: new ReadableStream<string>({
          start(controller) {
            if (fail) controller.error(new Error("provider stream broke"));
            else {
              controller.enqueue(text);
              controller.close();
            }
          },
        }),
        response: Promise.resolve({ id: `resp-${randomUUID()}`, modelId: MODEL_ID }),
        usage: Promise.resolve({
          inputTokens: 1_000,
          outputTokens: fail ? 0 : 50,
          cachedInputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
        }),
        finishReason: Promise.resolve(fail ? "error" : "stop"),
        rawFinishReason: Promise.resolve(fail ? "error" : "end_turn"),
        content: Promise.resolve([]),
        providerMetadata: Promise.resolve({}),
      };
    },
  },
});

// Nothing here may reach the network.
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

type Handler = (request: Request, context?: unknown) => Promise<Response>;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let scopedMessageId: (typeof import("@/lib/messageRequestIdentity"))["scopedMessageId"];
let createConversationUnlockCookie: (typeof import("@/lib/conversationLock"))["createConversationUnlockCookie"];
let superseded: { PUT: Handler };
let conversationRoute: { GET: Handler };
let chatRoute: { POST: Handler };
let importGuest: { POST: Handler };

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ scopedMessageId } = (await import(mod("lib/messageRequestIdentity.ts"))) as typeof import("@/lib/messageRequestIdentity"));
  ({ createConversationUnlockCookie } = (await import(mod("lib/conversationLock.ts"))) as typeof import("@/lib/conversationLock"));
  superseded = await import(mod("app/api/conversations/[conversationId]/superseded/route.ts"));
  conversationRoute = await import(mod("app/api/conversations/[conversationId]/route.ts"));
  chatRoute = await import(mod("app/api/chat/route.ts"));
  importGuest = await import(mod("app/api/conversations/import-guest/route.ts"));
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ContextManifest",
      "RoutingAttempt",
      "RoutingRun",
      "ProviderDailyUsage",
      "TokenEstimateShadowSample",
      "ChatAttemptUsageAdjustment",
      "ChatAttemptUsage",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditLedgerEntry",
      "CreditLot",
      "Message",
      "Conversation",
      "UserSettings",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  sessionOverride = null;
  script = { text: "a new answer", fail: false };
  providerMessages = [];
});
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: {
      email: `superseded-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
const signInAs = (user: { id: string; email: string | null }) => {
  sessionOverride = { user: { id: user.id, email: user.email } };
};
const createConversation = (userId: string) =>
  prisma.conversation.create({
    data: { userId, title: "Replaced turns", selectedModels: JSON.stringify([MODEL_ID]) },
  });

/**
 * A conversation's turns as the browser saved them: each row's id is the
 * scoped form of the request id the browser holds.
 */
const seedTurns = async (conversationId: string, turns: Array<[string, string]>) => {
  let at = Date.now() - 60_000;
  for (const [clientId, content] of turns) {
    const role = clientId.startsWith("q") ? "user" : "assistant";
    await prisma.message.create({
      data: {
        id: scopedMessageId(conversationId, clientId),
        conversationId,
        role,
        content,
        modelId: role === "assistant" ? MODEL_ID : null,
        createdAt: new Date((at += 1_000)),
      },
    });
  }
};
const markOf = async (conversationId: string, clientId: string) =>
  (await prisma.message.findUniqueOrThrow({ where: { id: scopedMessageId(conversationId, clientId) } })).supersededAt;

const put = (conversationId: string, body: unknown, headers: Record<string, string> = {}) =>
  superseded.PUT(
    new Request(`https://tomverse.test/api/conversations/${conversationId}/superseded`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ conversationId }) }
  );

const drain = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) return;
  for (;;) if ((await reader.read()).done) break;
};

/* ------------------------------------------------------------ the write -- */

test("the owner marks a turn by either id spelling; nothing else is touched", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q1", "first"], ["a1", "first answer"], ["q2", "second"], ["a2", "second answer"]]);
  const elsewhere = await createConversation(owner.id);
  await seedTurns(elsewhere.id, [["q1", "other"], ["a1", "other answer"]]);
  signInAs(owner);

  // The page's request id for the question, the stored id for the answer.
  const response = await put(conversation.id, { messageIds: ["q1", scopedMessageId(conversation.id, "a1")] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { marked: 2 });
  const first = await markOf(conversation.id, "q1");
  assert.ok(first instanceof Date);
  assert.ok(await markOf(conversation.id, "a1"));
  assert.equal(await markOf(conversation.id, "q2"), null);
  assert.equal(await markOf(conversation.id, "a2"), null);
  // The same request ids in another conversation of the same owner are other rows.
  assert.equal(await markOf(elsewhere.id, "q1"), null);
  assert.equal(await markOf(elsewhere.id, "a1"), null);

  // Repeating keeps the first time; an id from another conversation matches nothing.
  const again = await put(conversation.id, { messageIds: ["q1", scopedMessageId(elsewhere.id, "q1")] });
  assert.deepEqual(await again.json(), { marked: 0 });
  assert.equal((await markOf(conversation.id, "q1"))!.getTime(), first!.getTime());
  assert.equal(await markOf(elsewhere.id, "q1"), null);
});

test("another account, a signed-out caller and a malformed list write nothing", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q1", "first"], ["a1", "first answer"]]);

  assert.equal((await put(conversation.id, { messageIds: ["q1"] })).status, 401);

  const stranger = await createUser();
  signInAs(stranger);
  assert.equal((await put(conversation.id, { messageIds: ["q1", "a1"] })).status, 403);
  // A conversation that does not exist is refused the same way.
  assert.equal((await put("missing-conversation", { messageIds: ["q1"] })).status, 403);

  signInAs(owner);
  for (const body of [
    { messageIds: [] },
    { messageIds: ["q1", "a1", "q2", "a2", "q3"] },
    { messageIds: ["not an id"] },
    { messageIds: ["q1"], extra: true },
    {},
  ]) {
    assert.equal((await put(conversation.id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await prisma.message.count({ where: { supersededAt: { not: null } } }), 0);
});

test("a locked conversation takes the mark only with its unlock grant", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q1", "first"], ["a1", "first answer"]]);
  const locked = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { password: "superseded-lock-fixture" },
  });
  signInAs(owner);

  const refused = await put(conversation.id, { messageIds: ["q1", "a1"] });
  assert.equal(refused.status, 423);
  assert.equal((await refused.json()).code, "CONVERSATION_LOCKED");
  assert.equal(await markOf(conversation.id, "q1"), null);

  const cookie = createConversationUnlockCookie(owner.id, conversation.id, locked.passwordVersion).split(";")[0]!;
  const unlocked = await put(conversation.id, { messageIds: ["q1", "a1"] }, { cookie });
  assert.equal(unlocked.status, 200);
  assert.deepEqual(await unlocked.json(), { marked: 2 });
});

/* ------------------------------------------------------------- the read -- */

test("the conversation read flags the replaced messages and only those", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q1", "first"], ["a1", "first answer"], ["q2", "first"], ["a2", "better answer"]]);
  signInAs(owner);
  await put(conversation.id, { messageIds: ["q1", "a1"] });

  const response = await conversationRoute.GET(
    new Request(`https://tomverse.test/api/conversations/${conversation.id}`),
    { params: Promise.resolve({ conversationId: conversation.id }) }
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages: Array<{ id: string; superseded?: boolean; supersededAt?: unknown }> };
  const flags = Object.fromEntries(body.messages.map((message) => [message.id, message.superseded ?? false]));
  assert.deepEqual(flags, {
    [scopedMessageId(conversation.id, "q1")]: true,
    [scopedMessageId(conversation.id, "a1")]: true,
    [scopedMessageId(conversation.id, "q2")]: false,
    [scopedMessageId(conversation.id, "a2")]: false,
  });
  // A flag, never the column itself.
  assert.ok(body.messages.every((message) => !("supersededAt" in message)));
});

/* --------------------------------------------------------- the chat route -- */

const ask = (conversationId: string, messages: unknown[], extra: Record<string, unknown> = {}) =>
  chatRoute.POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        modelId: MODEL_ID,
        conversationId,
        assistantMessageId: randomUUID(),
        ...extra,
      }),
    })
  );
const sentText = () => JSON.stringify(providerMessages.at(-1) ?? null);

test("the chat route leaves a replaced turn out of the context whatever the client sent", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [
    ["q1", "OLD-QUESTION"],
    ["a1", "OLD-ANSWER"],
    ["q2", "KEPT-QUESTION"],
    ["a2", "KEPT-ANSWER"],
  ]);
  signInAs(owner);
  await put(conversation.id, { messageIds: ["q1", "a1"] });

  // A client that never heard of the replacement sends the whole transcript:
  // the question by its request id, the answer by its stored id.
  const response = await ask(conversation.id, [
    { id: "q1", role: "user", content: "OLD-QUESTION" },
    { id: scopedMessageId(conversation.id, "a1"), role: "assistant", content: "OLD-ANSWER" },
    { id: "q2", role: "user", content: "KEPT-QUESTION" },
    { id: "a2", role: "assistant", content: "KEPT-ANSWER" },
    { id: "q3", role: "user", content: "NEW-QUESTION" },
  ]);
  assert.equal(response.status, 200, await response.clone().text());
  await drain(response);
  assert.ok(providerMessages.length >= 1, "the provider was never called");
  const sent = sentText();
  assert.doesNotMatch(sent, /OLD-QUESTION|OLD-ANSWER/);
  assert.match(sent, /KEPT-QUESTION/);
  assert.match(sent, /KEPT-ANSWER/);
  assert.match(sent, /NEW-QUESTION/);
});

test("the message being answered stays even when it carries a replaced id", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q0", "KEPT-QUESTION"], ["a0", "KEPT-ANSWER"], ["q1", "OLD-QUESTION"], ["a1", "OLD-ANSWER"]]);
  signInAs(owner);
  await put(conversation.id, { messageIds: ["q1", "a1"] });

  const response = await ask(conversation.id, [
    { id: "q0", role: "user", content: "KEPT-QUESTION" },
    { id: "a0", role: "assistant", content: "KEPT-ANSWER" },
    { id: "q1", role: "user", content: "LAST-QUESTION" },
  ]);
  assert.equal(response.status, 200, await response.clone().text());
  await drain(response);
  assert.match(sentText(), /KEPT-ANSWER/);
  assert.match(sentText(), /LAST-QUESTION/);
});

test("a replacing send records its turn with the finished answer, and leaves it out at once", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q1", "SAME-QUESTION"], ["a1", "REPLACED-ANSWER"]]);
  signInAs(owner);

  const response = await ask(
    conversation.id,
    [
      { id: "q1", role: "user", content: "SAME-QUESTION" },
      { id: "a1", role: "assistant", content: "REPLACED-ANSWER" },
      { id: "q2", role: "user", content: "SAME-QUESTION" },
    ],
    { supersedesMessageIds: ["q1", "a1"] }
  );
  assert.equal(response.status, 200, await response.clone().text());
  await drain(response);
  assert.doesNotMatch(sentText(), /REPLACED-ANSWER/);
  // No browser reported anything: the route wrote the mark with the answer.
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id, role: "assistant", content: "a new answer" } }), 1);
  assert.ok(await markOf(conversation.id, "q1"));
  assert.ok(await markOf(conversation.id, "a1"));
});

test("a replacing send that saves no answer leaves the earlier turn standing", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  await seedTurns(conversation.id, [["q1", "SAME-QUESTION"], ["a1", "EARLIER-ANSWER"]]);
  signInAs(owner);
  script = { text: "", fail: true };

  const response = await ask(
    conversation.id,
    [
      { id: "q1", role: "user", content: "SAME-QUESTION" },
      { id: "a1", role: "assistant", content: "EARLIER-ANSWER" },
      { id: "q2", role: "user", content: "SAME-QUESTION" },
    ],
    { supersedesMessageIds: ["q1", "a1"] }
  );
  // The broken stream may reach the response body itself.
  await drain(response).catch(() => undefined);
  assert.ok(providerMessages.length >= 1, "the provider was never called");
  assert.equal(
    await prisma.message.count({ where: { conversationId: conversation.id, role: "assistant", status: { in: ["normal", "incomplete"] }, content: { not: "EARLIER-ANSWER" } } }),
    0
  );
  assert.equal(await markOf(conversation.id, "q1"), null);
  assert.equal(await markOf(conversation.id, "a1"), null);
});

test("a malformed replaced-turn list is refused before anything runs", async () => {
  const owner = await createUser();
  const conversation = await createConversation(owner.id);
  signInAs(owner);
  const response = await ask(conversation.id, [{ id: "q1", role: "user", content: "hello" }], {
    supersedesMessageIds: ["not an id"],
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_SUPERSEDED_MESSAGES");
  assert.equal(providerMessages.length, 0);
});

test("a guest conversation imported on sign-in keeps its replaced turn in its history, marked replaced", async () => {
  const owner = await createUser();
  signInAs(owner);
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, seconds)).toISOString();
  const response = await importGuest.POST(
    new Request("https://tomverse.test/api/conversations/import-guest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://tomverse.test" },
      body: JSON.stringify({
        guestConversationId: "guest-superseded-1",
        title: "Guest chat",
        selectedModels: [MODEL_ID],
        createdAt: at(0),
        messages: [
          { role: "user", content: "first question", createdAt: at(1), superseded: true },
          { role: "assistant", content: "first answer", modelId: MODEL_ID, createdAt: at(2), superseded: true },
          { role: "user", content: "asked again", createdAt: at(3) },
          { role: "assistant", content: "new answer", modelId: MODEL_ID, createdAt: at(4) },
        ],
      }),
    })
  );
  assert.equal(response.status, 200, await response.clone().text());
  const { conversationId } = (await response.json()) as { conversationId: string };
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { content: true, supersededAt: true },
  });
  // The account holds the whole history; only the replaced turn carries the mark.
  assert.deepEqual(
    rows.map((row) => [row.content, row.supersededAt !== null]),
    [["first question", true], ["first answer", true], ["asked again", false], ["new answer", false]]
  );
  // A value other than true is not a mark.
  const refused = await importGuest.POST(
    new Request("https://tomverse.test/api/conversations/import-guest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://tomverse.test" },
      body: JSON.stringify({
        guestConversationId: "guest-superseded-2",
        title: "Guest chat",
        selectedModels: [MODEL_ID],
        createdAt: at(0),
        messages: [{ role: "user", content: "x", createdAt: at(1), superseded: "yes" }],
      }),
    })
  );
  assert.equal(refused.status, 400);
});
