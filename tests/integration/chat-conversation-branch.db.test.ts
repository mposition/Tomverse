import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * "Branch from this answer" (lib/chatConversationBranch.ts) against real rows:
 * what a branch copies, what it leaves, which conversations it refuses, and
 * that the conversation limit applies and a refusal leaves nothing behind.
 *
 * Its own process: `mock.module` replaces next-auth (the session).
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;
const MODEL_ID = "claude-sonnet-5";

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

type Handler = (request: Request, context?: unknown) => Promise<Response>;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let scopedMessageId: (typeof import("@/lib/messageRequestIdentity"))["scopedMessageId"];
let branchRoute: { POST: Handler };

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ scopedMessageId } = (await import(mod("lib/messageRequestIdentity.ts"))) as typeof import("@/lib/messageRequestIdentity"));
  branchRoute = await import(mod("app/api/conversations/[conversationId]/branch/route.ts"));
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatUsageBucket",
      "MessageAttachment",
      "MessageArtifact",
      "ConversationContinuationBridge",
      "Message",
      "Conversation",
      "ConversationProject",
      "UserSettings",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  sessionOverride = null;
  delete process.env.API_MAX_CONVERSATIONS_PER_USER;
});
after(async () => {
  delete process.env.API_MAX_CONVERSATIONS_PER_USER;
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: {
      email: `branch-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
const signInAs = (user: { id: string; email: string | null }) => {
  sessionOverride = { user: { id: user.id, email: user.email } };
};
const createChat = (userId: string, extra: Record<string, unknown> = {}) =>
  prisma.conversation.create({
    data: {
      userId,
      title: "Quarterly numbers",
      productKey: "chat",
      selectedModels: JSON.stringify([MODEL_ID]),
      webSearchMode: "auto",
      ...extra,
    },
  });

/** Turns as the browser saved them: ids are the scoped form of the request id. */
const seedTurns = async (conversationId: string, turns: Array<[string, string, Record<string, unknown>?]>) => {
  let at = Date.now() - 60_000;
  for (const [clientId, content, extra] of turns) {
    const role = clientId.startsWith("q") ? "user" : "assistant";
    await prisma.message.create({
      data: {
        id: scopedMessageId(conversationId, clientId),
        conversationId,
        role,
        content,
        modelId: role === "assistant" ? MODEL_ID : null,
        createdAt: new Date((at += 1_000)),
        ...extra,
      },
    });
  }
};

const branch = (conversationId: string, body: unknown) =>
  branchRoute.POST(
    new Request(`https://tomverse.test/api/conversations/${conversationId}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ conversationId }) }
  );

const standard = async () => {
  const owner = await createUser();
  const source = await createChat(owner.id);
  await seedTurns(source.id, [
    ["q1", "first question"],
    ["a1", "first answer"],
    ["q2", "second question"],
    ["a2", "second answer"],
    ["q3", "third question"],
    ["a3", "third answer"],
  ]);
  signInAs(owner);
  return { owner, source };
};

test("a branch copies the turns up to the answer and leaves the source unchanged", async () => {
  const { source } = await standard();
  // A replaced turn is not part of the standing conversation.
  await prisma.message.updateMany({
    where: { id: { in: [scopedMessageId(source.id, "q1"), scopedMessageId(source.id, "a1")] } },
    data: { supersededAt: new Date() },
  });

  // The page's request id works as well as the stored id.
  const response = await branch(source.id, { messageId: "a2" });
  assert.equal(response.status, 201);
  const created = (await response.json()) as { id: string; title: string; surface: string; copiedMessages: number };
  assert.equal(created.surface, "chat");
  assert.equal(created.title, "Branch: Quarterly numbers");
  assert.equal(created.copiedMessages, 2, "the replaced first turn and the later turns are left out");

  const copy = await prisma.conversation.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(copy.productKey, "chat");
  assert.equal(copy.kind, "chat");
  assert.equal(copy.selectedModels, source.selectedModels);
  assert.equal(copy.webSearchMode, "auto");
  assert.equal(copy.userId, source.userId);

  const messages = await prisma.message.findMany({
    where: { conversationId: created.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [
    ["user", "second question"],
    ["assistant", "second answer"],
  ]);
  assert.equal(messages[1]!.modelId, MODEL_ID);
  assert.ok(messages.every((m) => !m.id.includes(source.id)));

  // The source is exactly as it was.
  assert.equal(await prisma.message.count({ where: { conversationId: source.id } }), 6);
  assert.equal(await prisma.message.count({ where: { conversationId: source.id, supersededAt: { not: null } } }), 2);
});

test("branching from the last answer copies everything standing, in order", async () => {
  const { source } = await standard();
  const response = await branch(source.id, { messageId: scopedMessageId(source.id, "a3") });
  assert.equal(response.status, 201);
  const { id } = (await response.json()) as { id: string };
  const messages = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(messages.map((m) => m.content), [
    "first question", "first answer", "second question", "second answer", "third question", "third answer",
  ]);
});

test("a turn's attachments are not copied and its text says so, in the client's own words", async () => {
  const { owner, source } = await standard();
  await prisma.messageAttachment.create({
    data: {
      messageId: scopedMessageId(source.id, "q1"),
      conversationId: source.id,
      userId: owner.id,
      name: "report.pdf",
      mediaType: "application/pdf",
      kind: "file",
      objectKey: `db-test/${randomUUID()}`,
    },
  });
  await prisma.messageArtifact.create({
    data: {
      messageId: scopedMessageId(source.id, "a1"),
      conversationId: source.id,
      userId: owner.id,
      format: "csv",
      filename: "table.csv",
      mediaType: "text/csv",
      byteSize: 12,
      objectKey: `db-test/${randomUUID()}`,
    },
  });
  const response = await branch(source.id, {
    messageId: "a1",
    titleTemplate: "Zweig: {title}",
    filesTemplate: "[Nicht kopiert: {names}]",
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { id: string; title: string; turnsWithOmittedFiles: number };
  assert.equal(body.title, "Zweig: Quarterly numbers");
  assert.equal(body.turnsWithOmittedFiles, 2);
  const messages = await prisma.message.findMany({ where: { conversationId: body.id }, orderBy: { createdAt: "asc" } });
  assert.equal(messages[0]!.content, "first question\n\n[Nicht kopiert: report.pdf]");
  assert.equal(messages[1]!.content, "first answer\n\n[Nicht kopiert: table.csv]");
  assert.equal(await prisma.messageAttachment.count({ where: { conversationId: body.id } }), 0);
  assert.equal(await prisma.messageArtifact.count({ where: { conversationId: body.id } }), 0);

  // A template without its placeholder is not used.
  const fallback = await branch(source.id, { messageId: "a1", titleTemplate: "no placeholder", filesTemplate: "x" });
  const next = (await fallback.json()) as { title: string };
  assert.equal(next.title, "Branch: Quarterly numbers");
});

test("a project conversation branches into the same project", async () => {
  const owner = await createUser();
  const project = await prisma.conversationProject.create({ data: { userId: owner.id, name: "Launch" } });
  const source = await createChat(owner.id, { projectId: project.id });
  await seedTurns(source.id, [["q1", "question"], ["a1", "answer"]]);
  signInAs(owner);
  const response = await branch(source.id, { messageId: "a1" });
  assert.equal(response.status, 201);
  const { id } = (await response.json()) as { id: string };
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id } })).projectId, project.id);

  await prisma.conversationProject.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
  const archived = await branch(source.id, { messageId: "a1" });
  assert.equal(archived.status, 409);
  assert.equal(((await archived.json()) as { code: string }).code, "BRANCH_PROJECT_ARCHIVED");
});

test("conversations that cannot be branched are refused and leave nothing behind", async () => {
  const { owner, source } = await standard();
  const refusedWith = async (conversationId: string, messageId: string, status: number, code: string) => {
    const before = await prisma.conversation.count();
    const response = await branch(conversationId, { messageId });
    assert.equal(response.status, status, code);
    assert.equal(((await response.json()) as { code: string }).code, code);
    assert.equal(await prisma.conversation.count(), before, `${code} created a conversation`);
  };

  await refusedWith(source.id, "q1", 409, "BRANCH_ANSWER_NOT_FINISHED");
  await refusedWith(source.id, "missing", 404, "BRANCH_ANSWER_NOT_FOUND");
  await refusedWith("missing-conversation", "a1", 404, "BRANCH_NOT_FOUND");

  const failed = await createChat(owner.id);
  await seedTurns(failed.id, [["q1", "question"], ["a1", "", { status: "error" }]]);
  await refusedWith(failed.id, "a1", 409, "BRANCH_ANSWER_NOT_FINISHED");

  const locked = await createChat(owner.id, { password: "hashed", passwordVersion: 1 });
  await seedTurns(locked.id, [["q1", "question"], ["a1", "answer"]]);
  await refusedWith(locked.id, "a1", 409, "BRANCH_LOCKED");

  const temporary = await createChat(owner.id, { temporaryExpiresAt: new Date(Date.now() + 3_600_000), memoryMode: "off" });
  await seedTurns(temporary.id, [["q1", "question"], ["a1", "answer"]]);
  await refusedWith(temporary.id, "a1", 409, "BRANCH_TEMPORARY");

  const review = await createChat(owner.id, { productKey: "review" });
  await seedTurns(review.id, [["q1", "question"], ["a1", "answer"]]);
  await refusedWith(review.id, "a1", 409, "BRANCH_NOT_CHAT");

  const image = await createChat(owner.id, { kind: "image", productKey: "studio", selectedModels: "[]" });
  await seedTurns(image.id, [["q1", "question"], ["a1", "answer"]]);
  await refusedWith(image.id, "a1", 409, "BRANCH_NOT_CHAT");

  const imported = await createChat(owner.id);
  await seedTurns(imported.id, [["q1", "question"], ["a1", "answer"]]);
  await prisma.conversationContinuationBridge.create({
    data: {
      userId: owner.id,
      conversationId: imported.id,
      provider: "chatgpt",
      sourceImportedAt: new Date(),
      sourceConversationDigest: "digest",
      sourceDigestVersion: 1,
      sourceMessageCount: 2,
      seedFromOrdinal: 0,
      seedToOrdinal: 1,
      seedMessageCount: 2,
      seedTruncatedMessageCount: 0,
      seedOmittedMessageCount: 0,
      contextSeedVersion: "v1",
      idempotencyKey: randomUUID(),
    },
  });
  await refusedWith(imported.id, "a1", 409, "BRANCH_EXTERNAL_CONTINUATION");
});

test("only the owner may branch, and a signed-out request is refused", async () => {
  const { source } = await standard();
  const stranger = await createUser();
  signInAs(stranger);
  const forbidden = await branch(source.id, { messageId: "a1" });
  assert.equal(forbidden.status, 403);
  assert.equal(await prisma.conversation.count({ where: { userId: stranger.id } }), 0);

  sessionOverride = null;
  assert.equal((await branch(source.id, { messageId: "a1" })).status, 401);
  assert.equal((await branch(source.id, { messageId: "a1", extra: 1 })).status, 401);
});

test("the conversation limit applies to a branch, and a refused branch leaves no empty conversation", async () => {
  const { source } = await standard();
  process.env.API_MAX_CONVERSATIONS_PER_USER = "1";
  const response = await branch(source.id, { messageId: "a1" });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "CONVERSATION_STORAGE_QUOTA_EXCEEDED");
  assert.equal(await prisma.conversation.count(), 1);

  delete process.env.API_MAX_CONVERSATIONS_PER_USER;
  process.env.API_MAX_MESSAGES_PER_CONVERSATION = "1";
  try {
    const tooMany = await branch(source.id, { messageId: "a1" });
    assert.equal(tooMany.status, 409);
    assert.equal(((await tooMany.json()) as { code: string }).code, "MESSAGE_STORAGE_QUOTA_EXCEEDED");
    assert.equal(await prisma.conversation.count(), 1, "the whole branch rolled back");
  } finally {
    delete process.env.API_MAX_MESSAGES_PER_CONVERSATION;
  }
});
