import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The routes of temporary Chat and answer ratings, against real rows.
 *
 * Its own process under scripts/run-db-integration-tests.mjs: `mock.module`
 * replaces next-auth for every module in the process, which is how a request
 * here carries a signed-in session.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

type Handler = (request: Request, context?: unknown) => Promise<Response>;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let chatCreate: { POST: Handler };
let reviewCreate: { POST: Handler };
let list: { GET: Handler };
let conversation: { PATCH: Handler; DELETE: Handler };
let generateTitle: { POST: Handler };
let exportOne: { GET: Handler };
let ratings: { GET: Handler; PUT: Handler };

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  chatCreate = await import(mod("app/api/products/chat/conversations/route.ts"));
  reviewCreate = await import(mod("app/api/products/review/conversations/route.ts"));
  list = await import(mod("app/api/conversations/route.ts"));
  conversation = await import(mod("app/api/conversations/[conversationId]/route.ts"));
  generateTitle = await import(mod("app/api/conversations/[conversationId]/generate-title/route.ts"));
  exportOne = await import(mod("app/api/conversations/[conversationId]/export/route.ts"));
  ratings = await import(mod("app/api/chat/answer-ratings/route.ts"));
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatAnswerRating",
      "Message",
      "Conversation",
      "ConversationProject",
      "UserSettings",
      "ChatUsageBucket",
      "AppSetting",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  sessionOverride = null;
});
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const signIn = async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, plan: "Pro" } });
  sessionOverride = { user: { id: user.id } };
  return user;
};
const enableTemporaryChat = () =>
  prisma.appSetting.create({ data: { key: "feature.temporaryChatEnabled", value: "true" } });

const json = (url: string, method: string, body?: unknown) =>
  new Request(`https://tomverse.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });

const createTemporary = async () => {
  const response = await chatCreate.POST(json("/api/products/chat/conversations", "POST", { title: "secret", temporary: true }));
  return { response, body: await response.json() };
};

/* -------------------------------------------------------- temporary Chat -- */

test("a temporary Chat is refused while the switch is off", async () => {
  await signIn();
  const { response, body } = await createTemporary();
  assert.equal(response.status, 404);
  assert.equal(body.code, "TEMPORARY_CHAT_UNAVAILABLE");
  assert.equal(await prisma.conversation.count(), 0);
});

test("with the switch on, a temporary Chat starts with memory off, expires in 24 hours and is never listed", async () => {
  const user = await signIn();
  await enableTemporaryChat();
  const startedAt = Date.now();
  const { response, body } = await createTemporary();
  assert.equal(response.status, 200);
  assert.equal(body.temporary, true);
  const row = await prisma.conversation.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(row.memoryMode, "off");
  assert.equal(row.projectId, null);
  assert.equal(row.productKey, "chat");
  const ttl = row.temporaryExpiresAt!.getTime() - startedAt;
  assert.ok(ttl > 23.9 * 3_600_000 && ttl <= 24 * 3_600_000 + 60_000, `ttl ${ttl}`);

  const ordinary = await chatCreate.POST(json("/api/products/chat/conversations", "POST", { title: "ordinary" }));
  const ordinaryBody = await ordinary.json();
  assert.equal(ordinaryBody.temporary, false);

  const listed = await (await list.GET(json("/api/conversations", "GET"))).json();
  assert.deepEqual(listed.map((item: { id: string }) => item.id), [ordinaryBody.id]);
  assert.equal(await prisma.conversation.count({ where: { userId: user.id } }), 2);
});

test("temporary is Chat-only and outside projects", async () => {
  const user = await signIn();
  await enableTemporaryChat();
  const review = await reviewCreate.POST(json("/api/products/review/conversations", "POST", { temporary: true }));
  assert.equal(review.status, 400);
  const project = await prisma.conversationProject.create({ data: { userId: user.id, name: "p" } });
  const inProject = await chatCreate.POST(
    json("/api/products/chat/conversations", "POST", { temporary: true, projectId: project.id })
  );
  assert.equal(inProject.status, 400);
  assert.equal((await inProject.json()).code, "TEMPORARY_CHAT_NOT_ALLOWED");
  assert.equal(await prisma.conversation.count(), 0);
});

test("a temporary Chat cannot move into a project, turn memory on, get a title or be exported", async () => {
  const user = await signIn();
  await enableTemporaryChat();
  const { body } = await createTemporary();
  const project = await prisma.conversationProject.create({ data: { userId: user.id, name: "p" } });
  await prisma.message.create({ data: { conversationId: body.id, role: "user", content: "first" } });

  for (const update of [{ projectId: project.id }, { memoryMode: "on" }, { memoryMode: "inherit" }]) {
    const refused = await conversation.PATCH(json(`/api/conversations/${body.id}`, "PATCH", update), params(body.id));
    assert.equal(refused.status, 409, JSON.stringify(update));
    assert.equal((await refused.json()).code, "TEMPORARY_CHAT_NOT_ALLOWED");
  }
  const renamed = await conversation.PATCH(json(`/api/conversations/${body.id}`, "PATCH", { title: "renamed" }), params(body.id));
  assert.equal(renamed.status, 200);
  await renamed.text();

  const title = await generateTitle.POST(
    json(`/api/conversations/${body.id}/generate-title`, "POST", { expectedTitle: "renamed" }),
    params(body.id)
  );
  assert.equal(title.status, 409);
  await title.text();

  const exported = await exportOne.GET(json(`/api/conversations/${body.id}/export`, "GET"), params(body.id));
  assert.equal(exported.status, 404);
  await exported.text();

  const row = await prisma.conversation.findUniqueOrThrow({ where: { id: body.id } });
  assert.equal(row.projectId, null);
  assert.equal(row.memoryMode, "off");
});

test("leaving deletes the temporary Chat through the ordinary delete", async () => {
  await signIn();
  await enableTemporaryChat();
  const { body } = await createTemporary();
  await prisma.message.create({ data: { conversationId: body.id, role: "user", content: "first" } });
  const deleted = await conversation.DELETE(json(`/api/conversations/${body.id}`, "DELETE"), params(body.id));
  assert.equal(deleted.status, 200);
  await deleted.text();
  assert.equal(await prisma.conversation.count(), 0);
  assert.equal(await prisma.message.count(), 0);
});

/* --------------------------------------------------------- answer rating -- */

const seedAnswer = async (userId: string, options: { password?: string } = {}) => {
  const row = await prisma.conversation.create({
    data: {
      userId,
      title: "t",
      productKey: "chat",
      selectedModels: '["gpt-6-luna"]',
      ...(options.password ? { password: options.password } : {}),
    },
  });
  const question = await prisma.message.create({ data: { conversationId: row.id, role: "user", content: "q" } });
  const answer = await prisma.message.create({
    data: { conversationId: row.id, role: "assistant", content: "a", modelId: "claude-fable-5" },
  });
  return { conversation: row, question, answer };
};
const rate = async (body: unknown) => {
  const response = await ratings.PUT(json("/api/chat/answer-ratings", "PUT", body));
  return { status: response.status, body: await response.json() };
};

test("a rating is stored with the model that answered, changed in place and withdrawn", async () => {
  const user = await signIn();
  const { conversation: row, answer } = await seedAnswer(user.id);

  const up = await rate({ messageId: answer.id, rating: "up" });
  assert.equal(up.status, 200);
  assert.deepEqual(up.body.rating, { messageId: answer.id, rating: "up", reason: null });
  const stored = await prisma.chatAnswerRating.findFirstOrThrow();
  assert.equal(stored.modelId, "claude-fable-5");
  assert.equal(stored.conversationId, row.id);

  const down = await rate({ messageId: answer.id, rating: "down", reason: "inaccurate" });
  assert.deepEqual(down.body.rating, { messageId: answer.id, rating: "down", reason: "inaccurate" });
  assert.equal(await prisma.chatAnswerRating.count(), 1);

  const read = await (await ratings.GET(json(`/api/chat/answer-ratings?conversationId=${row.id}`, "GET"))).json();
  assert.deepEqual(read.ratings, [{ messageId: answer.id, rating: "down", reason: "inaccurate" }]);

  const withdrawn = await rate({ messageId: answer.id, rating: null });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.rating, null);
  assert.equal(await prisma.chatAnswerRating.count(), 0);
});

test("another account's answer, a locked conversation, a question and a bad reason are all refused", async () => {
  const stranger = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, plan: "Pro" } });
  const foreign = await seedAnswer(stranger.id);
  const user = await signIn();
  const locked = await seedAnswer(user.id, { password: "$2a$10$abcdefghijklmnopqrstuv" });
  const own = await seedAnswer(user.id);

  assert.equal((await rate({ messageId: foreign.answer.id, rating: "up" })).status, 404);
  assert.equal((await rate({ messageId: "no-such-message", rating: "up" })).status, 404);
  assert.equal((await rate({ messageId: locked.answer.id, rating: "up" })).status, 423);
  assert.equal((await rate({ messageId: own.question.id, rating: "up" })).status, 409);
  assert.equal((await rate({ messageId: own.answer.id, rating: "up", reason: "inaccurate" })).status, 400);
  assert.equal(await prisma.chatAnswerRating.count(), 0);

  // Reading another account's ratings is not found; a locked one needs its grant.
  const foreignRead = await ratings.GET(json(`/api/chat/answer-ratings?conversationId=${foreign.conversation.id}`, "GET"));
  assert.equal(foreignRead.status, 404);
  await foreignRead.text();
  const lockedRead = await ratings.GET(json(`/api/chat/answer-ratings?conversationId=${locked.conversation.id}`, "GET"));
  assert.equal(lockedRead.status, 423);
  await lockedRead.text();

  sessionOverride = null;
  assert.equal((await rate({ messageId: own.answer.id, rating: "up" })).status, 401);
});
