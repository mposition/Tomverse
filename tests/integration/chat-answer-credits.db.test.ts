import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * A saved Chat answer shows the credits it actually cost
 * (ChatCreditReservation.assistantMessageId, lib/chatAnswerCredits.ts).
 * Against real rows and the real chat route, this proves what only the
 * database can say:
 *
 *  - a saved turn's reservation names its answer from the insert, and the
 *    figure the answer shows is the one settlement wrote -- the same figure an
 *    unsaved turn of the same model settles at;
 *  - a failed turn is refunded and shows nothing;
 *  - several reservations of one answer are summed, one still open withholds
 *    the answer, and a row from before the column (NULL) shows nothing;
 *  - only the owner reads, only their own reservations count, and only for a
 *    Chat conversation.
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

let failNextStream = false;
const require = createRequire(import.meta.url);
mock.module("ai", {
  namedExports: {
    ...(require("ai") as Record<string, unknown>),
    streamText: () => {
      const fail = failNextStream;
      return {
        textStream: new ReadableStream<string>({
          start(controller) {
            if (fail) controller.error(new Error("provider stream broke"));
            else {
              controller.enqueue("an answer worth paying for");
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
let createConversationUnlockCookie: (typeof import("@/lib/conversationLock"))["createConversationUnlockCookie"];
let readSettledAnswerCredits: (typeof import("@/lib/chatAnswerCredits"))["readSettledAnswerCredits"];
let scopedMessageId: (typeof import("@/lib/messageRequestIdentity"))["scopedMessageId"];
let chatRoute: { POST: Handler };
let conversationRoute: { GET: Handler };
let answerCredits: { GET: Handler };

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ createConversationUnlockCookie } = (await import(mod("lib/conversationLock.ts"))) as typeof import("@/lib/conversationLock"));
  ({ readSettledAnswerCredits } = (await import(mod("lib/chatAnswerCredits.ts"))) as typeof import("@/lib/chatAnswerCredits"));
  ({ scopedMessageId } = (await import(mod("lib/messageRequestIdentity.ts"))) as typeof import("@/lib/messageRequestIdentity"));
  chatRoute = await import(mod("app/api/chat/route.ts"));
  conversationRoute = await import(mod("app/api/conversations/[conversationId]/route.ts"));
  answerCredits = await import(mod("app/api/conversations/[conversationId]/answer-credits/route.ts"));
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
  failNextStream = false;
});
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: {
      email: `answer-credits-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
const signInAs = (user: { id: string; email: string | null }) => {
  sessionOverride = { user: { id: user.id, email: user.email } };
};
const createChat = (userId: string, data: Record<string, unknown> = {}) =>
  prisma.conversation.create({
    data: {
      userId,
      title: "Answer credits",
      selectedModels: JSON.stringify([MODEL_ID]),
      productKey: "chat",
      ...data,
    },
  });
const createAnswer = (conversationId: string, id = randomUUID()) =>
  prisma.message.create({
    data: { id, conversationId, role: "assistant", content: "stored answer", modelId: MODEL_ID },
  });

/** A reservation row as settlement leaves it; only the fields the read uses vary. */
const createReservation = (input: {
  userId: string;
  assistantMessageId: string | null;
  status: string;
  settledCredits: number;
}) => {
  const id = `chat-res-${randomUUID()}`;
  return prisma.chatCreditReservation.create({
    data: {
      id,
      userId: input.userId,
      subjectKey: `user:${input.userId}`,
      traceId: randomUUID(),
      source: "chat",
      provider: "anthropic",
      modelId: MODEL_ID,
      idempotencyKey: `chat-credit-reservation:${id}:v1`,
      reservationPayload: {},
      reservedCredits: 5,
      reservedCostMicroUsd: BigInt(1_000),
      planReservedCredits: 5,
      addOnReservedCredits: 0,
      expiresAt: new Date(Date.now() + 600_000),
      status: input.status,
      settledCredits: input.settledCredits,
      ...(input.status === "reserved" ? {} : { settledAt: new Date() }),
      assistantMessageId: input.assistantMessageId,
    },
  });
};

const drain = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) return;
  for (;;) if ((await reader.read()).done) break;
};

const QUESTION = "What does this cost?";

/**
 * One turn as the browser sends it. A saved turn's question is committed
 * first (the messages route does this) and the request names it, which is
 * what binds the paid answer to it.
 */
const ask = async (conversationId: string | null, assistantMessageId: string | null) => {
  const clientId = randomUUID();
  let sourceUserMessageId: string | undefined;
  if (conversationId) {
    sourceUserMessageId = scopedMessageId(conversationId, clientId);
    await prisma.message.create({
      data: { id: sourceUserMessageId, conversationId, role: "user", content: QUESTION },
    });
  }
  return chatRoute.POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: clientId, role: "user", content: QUESTION }],
        modelId: MODEL_ID,
        ...(conversationId ? { conversationId, sourceUserMessageId } : {}),
        ...(assistantMessageId ? { assistantMessageId } : {}),
      }),
    })
  );
};

/** The settlement runs as the stream ends; wait for it rather than for a timer. */
const settledReservations = async (userId: string, expected: number) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await prisma.chatCreditReservation.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length >= expected && rows.every((row) => row.status !== "reserved")) return rows;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  assert.fail("the reservation never settled");
};

const readConversation = async (conversationId: string, headers: Record<string, string> = {}) =>
  conversationRoute.GET(
    new Request(`https://tomverse.test/api/conversations/${conversationId}`, { headers }),
    { params: Promise.resolve({ conversationId }) }
  );
const shownCredits = async (conversationId: string) => {
  const response = await readConversation(conversationId);
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as {
    messages: Array<{ id: string; role: string; settledCredits?: number }>;
  };
  return Object.fromEntries(
    body.messages
      .filter((message) => message.role === "assistant")
      .map((message) => [message.id, message.settledCredits ?? null])
  );
};
const askCredits = (conversationId: string, ids: string, headers: Record<string, string> = {}) =>
  answerCredits.GET(
    new Request(
      `https://tomverse.test/api/conversations/${conversationId}/answer-credits?ids=${encodeURIComponent(ids)}`,
      { headers }
    ),
    { params: Promise.resolve({ conversationId }) }
  );

/* ------------------------------------------------------- the link and its figure -- */

test("a saved turn names its answer from the insert, and the answer shows what settlement charged", async () => {
  const owner = await createUser();
  const conversation = await createChat(owner.id);
  signInAs(owner);

  // An unsaved turn first: no conversation, no answer id, so nothing to link.
  const unsaved = await ask(null, null);
  assert.equal(unsaved.status, 200, await unsaved.clone().text());
  await drain(unsaved);
  const [unsavedRow] = await settledReservations(owner.id, 1);
  assert.equal(unsavedRow!.assistantMessageId, null);

  const answerId = randomUUID();
  const saved = await ask(conversation.id, answerId);
  assert.equal(saved.status, 200, await saved.clone().text());
  await drain(saved);
  const rows = await settledReservations(owner.id, 2);
  const savedRow = rows.find((row) => row.id !== unsavedRow!.id)!;

  assert.equal(savedRow.assistantMessageId, answerId);
  assert.equal(savedRow.status, "settled");
  assert.equal(savedRow.outcome, "completed");
  assert.ok(savedRow.settledCredits >= 1, "a completed turn charged nothing");
  // The link changes no amount: the same model, the same usage, the same charge.
  assert.equal(savedRow.reservedCredits, unsavedRow!.reservedCredits);
  assert.equal(savedRow.settledCredits, unsavedRow!.settledCredits);
  assert.equal(savedRow.settledCostMicroUsd, unsavedRow!.settledCostMicroUsd);

  const answer = await prisma.message.findUniqueOrThrow({ where: { id: answerId } });
  assert.equal(answer.conversationId, conversation.id);
  assert.deepEqual(await shownCredits(conversation.id), { [answerId]: savedRow.settledCredits });

  const response = await askCredits(conversation.id, answerId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), { credits: { [answerId]: savedRow.settledCredits } });
});

test("a failed turn is refunded, keeps its link, and shows nothing", async () => {
  const owner = await createUser();
  const conversation = await createChat(owner.id);
  signInAs(owner);
  failNextStream = true;

  const answerId = randomUUID();
  const response = await ask(conversation.id, answerId);
  // The broken stream may reach the response body itself.
  await drain(response).catch(() => undefined);
  const [row] = await settledReservations(owner.id, 1);
  assert.equal(row!.assistantMessageId, answerId);
  assert.equal(row!.status, "refunded");
  assert.equal(row!.settledCredits, 0);

  assert.deepEqual(
    Object.values(await shownCredits(conversation.id)).filter((value) => value !== null),
    []
  );
  assert.deepEqual(await (await askCredits(conversation.id, answerId)).json(), { credits: {} });
});

/* --------------------------------------------------------- the rule on rows -- */

test("several reservations are summed, an open one withholds the answer, and old rows show nothing", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const conversation = await createChat(owner.id);
  const summed = await createAnswer(conversation.id);
  const pending = await createAnswer(conversation.id);
  const refunded = await createAnswer(conversation.id);
  const historical = await createAnswer(conversation.id);
  const named = await createAnswer(conversation.id);

  // A replan: the first reservation settled at nothing, the second charged.
  await createReservation({ userId: owner.id, assistantMessageId: summed.id, status: "refunded", settledCredits: 0 });
  await createReservation({ userId: owner.id, assistantMessageId: summed.id, status: "settled", settledCredits: 3 });
  await createReservation({ userId: owner.id, assistantMessageId: summed.id, status: "settled", settledCredits: 2 });
  // Part of a total is not the total.
  await createReservation({ userId: owner.id, assistantMessageId: pending.id, status: "settled", settledCredits: 4 });
  await createReservation({ userId: owner.id, assistantMessageId: pending.id, status: "reserved", settledCredits: 0 });
  await createReservation({ userId: owner.id, assistantMessageId: refunded.id, status: "refunded", settledCredits: 0 });
  // A row from before the column: charged, but it names no answer.
  await createReservation({ userId: owner.id, assistantMessageId: null, status: "settled", settledCredits: 7 });
  // Another account's request that named the owner's answer id.
  await createReservation({ userId: stranger.id, assistantMessageId: named.id, status: "settled", settledCredits: 9 });

  signInAs(owner);
  assert.deepEqual(await shownCredits(conversation.id), {
    [summed.id]: 5,
    [pending.id]: null,
    [refunded.id]: null,
    [historical.id]: null,
    [named.id]: null,
  });
  const ids = [summed.id, pending.id, refunded.id, historical.id, named.id].join(",");
  assert.deepEqual(await (await askCredits(conversation.id, ids)).json(), { credits: { [summed.id]: 5 } });

  // The stranger's own reservation is theirs alone, and reads as theirs.
  assert.deepEqual([...(await readSettledAnswerCredits(stranger.id, [named.id]))], [[named.id, 9]]);
  assert.equal((await readSettledAnswerCredits(owner.id, [named.id])).size, 0);
});

/* ------------------------------------------------------------- who may read -- */

test("only the owner of an unlocked Chat conversation reads, and only its own answers", async () => {
  const owner = await createUser();
  const conversation = await createChat(owner.id);
  const answer = await createAnswer(conversation.id);
  await createReservation({ userId: owner.id, assistantMessageId: answer.id, status: "settled", settledCredits: 3 });

  // Signed out.
  assert.equal((await askCredits(conversation.id, answer.id)).status, 401);

  // Another account: refused, as the conversation read is.
  const stranger = await createUser();
  signInAs(stranger);
  assert.equal((await askCredits(conversation.id, answer.id)).status, 403);
  assert.equal((await askCredits("missing-conversation", answer.id)).status, 403);
  assert.equal((await readConversation(conversation.id)).status, 403);

  // Malformed lists are refused before anything is read.
  signInAs(owner);
  for (const ids of ["", "not an id", Array.from({ length: 51 }, (_, i) => `a${i}`).join(",")]) {
    assert.equal((await askCredits(conversation.id, ids)).status, 400, ids);
  }

  // An answer of another of the owner's conversations is not read through this one.
  const elsewhere = await createChat(owner.id);
  const otherAnswer = await createAnswer(elsewhere.id);
  await createReservation({ userId: owner.id, assistantMessageId: otherAnswer.id, status: "settled", settledCredits: 6 });
  assert.deepEqual(await (await askCredits(conversation.id, otherAnswer.id)).json(), { credits: {} });
  assert.deepEqual(await (await askCredits(elsewhere.id, otherAnswer.id)).json(), { credits: { [otherAnswer.id]: 6 } });

  // A locked conversation needs its unlock grant.
  const locked = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { password: "answer-credits-lock-fixture" },
  });
  const refused = await askCredits(conversation.id, answer.id);
  assert.equal(refused.status, 423);
  assert.equal((await refused.json()).code, "CONVERSATION_LOCKED");
  const cookie = createConversationUnlockCookie(owner.id, conversation.id, locked.passwordVersion).split(";")[0]!;
  assert.deepEqual(await (await askCredits(conversation.id, answer.id, { cookie })).json(), {
    credits: { [answer.id]: 3 },
  });
});

test("a Review conversation carries no figure on either read", async () => {
  const owner = await createUser();
  const review = await createChat(owner.id, { productKey: "review" });
  const answer = await createAnswer(review.id);
  await createReservation({ userId: owner.id, assistantMessageId: answer.id, status: "settled", settledCredits: 3 });
  signInAs(owner);

  assert.deepEqual(await shownCredits(review.id), { [answer.id]: null });
  assert.deepEqual(await (await askCredits(review.id, answer.id)).json(), { credits: {} });
});
