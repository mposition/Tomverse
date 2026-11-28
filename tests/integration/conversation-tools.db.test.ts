import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * Conversation tools against a database built from the migrations: archiving,
 * deleting a selection, and saved prompts.
 *
 *  - archiving moves `archivedAt` and nothing else -- not `updatedAt`, not the
 *    pin -- and the list, the account's search and the model's search each
 *    read it the way lib/conversationArchive.ts says;
 *  - a new message brings an archived conversation back;
 *  - deleting a selection leaves exactly what deleting each one alone leaves
 *    (attachment tombstones, memories grounded only there, the share link),
 *    skips a locked conversation this browser has not unlocked, and refuses a
 *    list that names another account's conversation before writing anything;
 *  - saved prompts are the owner's alone, bounded, and go with the account.
 *
 * Its own process under scripts/run-db-integration-tests.mjs: `mock.module`
 * replaces next-auth (the session) for every module in the process.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});
// Nothing here may reach the network.
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

type Handler = (request: Request, context?: unknown) => Promise<Response>;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let createConversationUnlockCookie: (typeof import("@/lib/conversationLock"))["createConversationUnlockCookie"];
let bindMessageAttachments: (typeof import("@/lib/messageAttachmentStorage"))["bindMessageAttachments"];
let accountAttachmentPrefix: (typeof import("@/lib/messageAttachmentStorage"))["accountAttachmentPrefix"];
let nativeMessageDigest: (typeof import("@/lib/nativeMemoryEvidence"))["nativeMessageDigest"];
let searchConversationMessages: (typeof import("@/lib/conversationSearch"))["searchConversationMessages"];
let searchPastChats: (typeof import("@/lib/chatHistoryReference"))["searchPastChats"];
let deleteScheduledAccounts: (typeof import("@/lib/maintenance"))["deleteScheduledAccounts"];
let SAVED_PROMPT_LIMITS: (typeof import("@/lib/savedPromptsCore"))["SAVED_PROMPT_LIMITS"];
let bulkRoute: { POST: Handler };
let singleRoute: { DELETE: Handler };
let listRoute: { GET: Handler; DELETE: Handler };
let messagesRoute: { POST: Handler };
let promptsRoute: { GET: Handler; POST: Handler };
let promptRoute: { PATCH: Handler; DELETE: Handler };

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ createConversationUnlockCookie } = (await import(mod("lib/conversationLock.ts"))) as typeof import("@/lib/conversationLock"));
  ({ bindMessageAttachments, accountAttachmentPrefix } = (await import(
    mod("lib/messageAttachmentStorage.ts")
  )) as typeof import("@/lib/messageAttachmentStorage"));
  ({ nativeMessageDigest } = (await import(mod("lib/nativeMemoryEvidence.ts"))) as typeof import("@/lib/nativeMemoryEvidence"));
  ({ searchConversationMessages } = (await import(mod("lib/conversationSearch.ts"))) as typeof import("@/lib/conversationSearch"));
  ({ searchPastChats } = (await import(mod("lib/chatHistoryReference.ts"))) as typeof import("@/lib/chatHistoryReference"));
  ({ deleteScheduledAccounts } = (await import(mod("lib/maintenance.ts"))) as typeof import("@/lib/maintenance"));
  ({ SAVED_PROMPT_LIMITS } = (await import(mod("lib/savedPromptsCore.ts"))) as typeof import("@/lib/savedPromptsCore"));
  bulkRoute = await import(mod("app/api/conversations/bulk/route.ts"));
  singleRoute = await import(mod("app/api/conversations/[conversationId]/route.ts"));
  listRoute = await import(mod("app/api/conversations/route.ts"));
  messagesRoute = await import(mod("app/api/conversations/[conversationId]/messages/route.ts"));
  promptsRoute = await import(mod("app/api/saved-prompts/route.ts"));
  promptRoute = await import(mod("app/api/saved-prompts/[promptId]/route.ts"));
});

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatUsageBucket",
      "MessageAttachmentCleanup",
      "ImageAssetCleanup",
      "MemoryEvidence",
      "MemoryItem",
      "MessageAttachment",
      "MessageAttachmentUpload",
      "SavedPrompt",
      "Message",
      "Conversation",
      "Session",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  sessionOverride = null;
  await reset();
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ORIGIN = "https://tomverse.test";

const user = async () => {
  const id = randomUUID();
  return prisma.user.create({ data: { id, email: `${id}@example.test` } });
};
const signIn = (account: { id: string; email: string | null }) => {
  sessionOverride = { user: { id: account.id, email: account.email } };
};
const conversation = (userId: string, extra: Record<string, unknown> = {}) =>
  prisma.conversation.create({
    data: { userId, title: "대화", selectedModels: '["gpt-6-luna"]', productKey: "chat", ...extra },
  });
const message = (conversationId: string, content: string) =>
  prisma.message.create({ data: { conversationId, role: "user", content } });

const bulk = (body: unknown, headers: Record<string, string> = {}) =>
  bulkRoute.POST(
    new Request(`${ORIGIN}/api/conversations/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
const deleteOne = (id: string) =>
  singleRoute.DELETE(new Request(`${ORIGIN}/api/conversations/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ conversationId: id }),
  });
const listIds = async (query = "") => {
  const response = await listRoute.GET(new Request(`${ORIGIN}/api/conversations${query}`));
  assert.equal(response.status, 200);
  const rows = (await response.json()) as Array<{ id: string; archived: boolean }>;
  return rows.map((row) => `${row.id}:${row.archived ? "archived" : "live"}`).sort();
};

/** Everything a delete is supposed to clean up, seeded the same way for each conversation. */
const seedCleanupSubjects = async (account: { id: string; email: string | null }, conversationId: string) => {
  const said = await message(conversationId, "프로젝트 예산은 천만 원입니다");
  const upload = await prisma.messageAttachmentUpload.create({
    data: {
      userId: account.id,
      name: "계약서.docx",
      mediaType: DOCX,
      size: 2048,
      kind: "file",
      objectKey: `${accountAttachmentPrefix(account.email!)}2026-11-28/${randomUUID()}-contract.docx`,
    },
  });
  await prisma.$transaction((tx) =>
    bindMessageAttachments(tx, {
      userId: account.id,
      ownPrefix: accountAttachmentPrefix(account.email!),
      conversationId,
      messageId: said.id,
      uploadIds: [upload.id],
    })
  );
  const memory = await prisma.memoryItem.create({
    data: {
      userId: account.id,
      kind: "preference",
      statement: "Budget is ten million won",
      status: "active",
      confidence: 0.9,
      userEdited: false,
      approvedAt: new Date("2026-11-01T00:00:00.000Z"),
      searchTerms: ["budget"],
      retrievalVersion: 1,
      evidences: {
        create: {
          userId: account.id,
          sourceType: "tomverse_message",
          tomverseMessageId: said.id,
          evidenceDigest: nativeMessageDigest(said.content),
        },
      },
    },
  });
  const shareToken = randomUUID();
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { shareToken, shareEnabled: true, sharedAt: new Date(), shareExpiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { memoryId: memory.id, objectKey: upload.objectKey, shareToken };
};

const leftBehind = async (subjects: { memoryId: string; objectKey: string; shareToken: string }) => ({
  memory: await prisma.memoryItem.count({ where: { id: subjects.memoryId } }),
  tombstone: await prisma.messageAttachmentCleanup.count({ where: { objectKey: subjects.objectKey } }),
  share: await prisma.conversation.count({ where: { shareToken: subjects.shareToken } }),
});

/* -------------------------------------------------------------------------- */
/* Archive                                                                     */
/* -------------------------------------------------------------------------- */

test("archiving moves archivedAt only: updatedAt and the pin stay where they were", async () => {
  const owner = await user();
  signIn(owner);
  const chat = await conversation(owner.id);
  await prisma.$executeRaw`UPDATE "Conversation" SET "pinnedAt" = NOW(), "pinSeq" = 42 WHERE "id" = ${chat.id}`;
  const before = await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } });

  const archived = await bulk({ action: "archive", conversationIds: [chat.id] });
  assert.equal(archived.status, 200);
  assert.deepEqual(await archived.json(), { done: [chat.id], skipped: [] });
  const row = await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } });
  assert.ok(row.archivedAt instanceof Date);
  assert.equal(row.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(row.pinSeq, 42);
  assert.ok(row.pinnedAt);

  const restored = await bulk({ action: "unarchive", conversationIds: [chat.id] });
  assert.deepEqual(await restored.json(), { done: [chat.id], skipped: [] });
  const back = await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } });
  assert.equal(back.archivedAt, null);
  assert.equal(back.updatedAt.getTime(), before.updatedAt.getTime());
  assert.ok(back.pinnedAt, "a restored conversation comes back pinned");
});

test("the default list leaves archived rows out; the web asks for them, and app clients keep them", async () => {
  const owner = await user();
  signIn(owner);
  const live = await conversation(owner.id);
  const put = await conversation(owner.id);
  await bulk({ action: "archive", conversationIds: [put.id] });

  assert.deepEqual(await listIds(), [`${live.id}:live`]);
  assert.deepEqual(await listIds("?archived=only"), [`${put.id}:archived`]);
  assert.deepEqual(await listIds("?archived=include"), [`${live.id}:live`, `${put.id}:archived`].sort());
  // The app clients' full list is decided by `archivedListWhere`, unit-tested
  // in tests/conversationTools.test.mjs: a bearer session cannot be minted here.
});

test("a temporary chat and another account's conversation are never archived", async () => {
  const owner = await user();
  const other = await user();
  signIn(owner);
  const temporary = await conversation(owner.id, { temporaryExpiresAt: new Date(Date.now() + 3_600_000), memoryMode: "off" });
  const theirs = await conversation(other.id);

  const refused = await bulk({ action: "archive", conversationIds: [theirs.id] });
  assert.equal(refused.status, 403);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: theirs.id } })).archivedAt, null);

  const skipped = await bulk({ action: "archive", conversationIds: [temporary.id] });
  assert.deepEqual(await skipped.json(), { done: [], skipped: [{ id: temporary.id, reason: "not_found" }] });
});

test("search returns archived hits marked; the model's past-chat search never sees them", async () => {
  const owner = await user();
  signIn(owner);
  const live = await conversation(owner.id, { memoryMode: "on" });
  const put = await conversation(owner.id, { memoryMode: "on" });
  const current = await conversation(owner.id, { memoryMode: "on" });
  await message(live.id, "보라색 우산 이야기");
  await message(put.id, "보라색 우산 보관 이야기");
  await bulk({ action: "archive", conversationIds: [put.id] });

  const answer = await searchConversationMessages({
    request: new Request(`${ORIGIN}/api/conversations/search?q=x`),
    userId: owner.id,
    query: "보라색 우산",
    displayTimeZone: "UTC",
  });
  const marks = Object.fromEntries(answer.results.map((hit) => [hit.conversationId, hit.archived]));
  assert.deepEqual(marks, { [live.id]: false, [put.id]: true });

  const reference = await searchPastChats({ userId: owner.id, query: "보라색 우산", currentConversationId: current.id });
  assert.deepEqual(reference.conversations.map((hit) => hit.id), [live.id]);
});

test("a new message brings an archived conversation back", async () => {
  const owner = await user();
  signIn(owner);
  const chat = await conversation(owner.id);
  await bulk({ action: "archive", conversationIds: [chat.id] });
  const response = await messagesRoute.POST(
    new Request(`${ORIGIN}/api/conversations/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ clientRequestId: randomUUID(), role: "user", content: "다시 이어서" }] }),
    }),
    { params: Promise.resolve({ conversationId: chat.id }) }
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).archivedAt, null);
});

/* -------------------------------------------------------------------------- */
/* Deleting a selection                                                        */
/* -------------------------------------------------------------------------- */

test("deleting a selection cleans up exactly what deleting each one alone does", async () => {
  const owner = await user();
  signIn(owner);
  const alone = await conversation(owner.id);
  const first = await conversation(owner.id);
  const second = await conversation(owner.id);
  const aloneSubjects = await seedCleanupSubjects(owner, alone.id);
  const firstSubjects = await seedCleanupSubjects(owner, first.id);
  const secondSubjects = await seedCleanupSubjects(owner, second.id);

  assert.equal((await deleteOne(alone.id)).status, 200);
  const response = await bulk({ action: "delete", conversationIds: [first.id, second.id] });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { done: string[]; skipped: unknown[] };
  assert.deepEqual(body.done.sort(), [first.id, second.id].sort());
  assert.deepEqual(body.skipped, []);

  const expected = { memory: 0, tombstone: 1, share: 0 };
  assert.deepEqual(await leftBehind(aloneSubjects), expected, "the single delete's own result");
  assert.deepEqual(await leftBehind(firstSubjects), expected);
  assert.deepEqual(await leftBehind(secondSubjects), expected);
  assert.equal(await prisma.conversation.count({ where: { userId: owner.id } }), 0);
  assert.equal(await prisma.messageAttachment.count(), 0);
});

test("a locked conversation is skipped unless this browser unlocked it, and the rest still go", async () => {
  const owner = await user();
  signIn(owner);
  const open = await conversation(owner.id);
  const locked = await conversation(owner.id, { password: "hash", passwordVersion: 3 });
  const unlocked = await conversation(owner.id, { password: "hash", passwordVersion: 1 });
  const cookie = createConversationUnlockCookie(owner.id, unlocked.id, 1).split(";")[0]!;

  const response = await bulk({ action: "delete", conversationIds: [open.id, locked.id, unlocked.id] }, { cookie });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { done: string[]; skipped: Array<{ id: string; reason: string }> };
  assert.deepEqual(body.done.sort(), [open.id, unlocked.id].sort());
  assert.deepEqual(body.skipped, [{ id: locked.id, reason: "locked" }]);
  assert.deepEqual(
    (await prisma.conversation.findMany({ where: { userId: owner.id }, select: { id: true } })).map((row) => row.id),
    [locked.id]
  );
});

test("a selection naming another account's conversation is refused before anything is deleted", async () => {
  const owner = await user();
  const other = await user();
  signIn(owner);
  const mine = await conversation(owner.id);
  const theirs = await conversation(other.id);

  const response = await bulk({ action: "delete", conversationIds: [mine.id, theirs.id] });
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { code: string }).code, "CONVERSATION_NOT_OWNED");
  assert.equal(await prisma.conversation.count({ where: { id: { in: [mine.id, theirs.id] } } }), 2);
});

test("a selection is bounded, needs a signed-in account, and a vanished id is reported as such", async () => {
  const owner = await user();
  const tooMany = Array.from({ length: 51 }, () => randomUUID());
  assert.equal((await bulk({ action: "delete", conversationIds: [randomUUID()] })).status, 401);
  signIn(owner);
  assert.equal((await bulk({ action: "delete", conversationIds: tooMany })).status, 400);
  const gone = randomUUID();
  const response = await bulk({ action: "delete", conversationIds: [gone] });
  assert.deepEqual(await response.json(), { done: [], skipped: [{ id: gone, reason: "not_found" }] });
});

/*
  Deleting in bulk is one budget: delete-all (DELETE /api/conversations) and a
  selection delete spend the same rate-limit bucket. Without that, an account
  with fifty conversations or fewer could go on deleting all of them through
  the selection after delete-all's limit was spent.
*/
const deleteAll = () => listRoute.DELETE(new Request(`${ORIGIN}/api/conversations`, { method: "DELETE" }));
const DELETE_BUCKET = "api-conversation-delete-all";

test("a selection delete is refused once delete-all has spent the day's budget, and nothing is deleted", async () => {
  const owner = await user();
  signIn(owner);
  assert.equal((await deleteAll()).status, 200);
  // The rest of today's delete-all budget spent in earlier minutes: the day
  // bucket at its limit, this minute's bucket empty.
  await prisma.$executeRaw`UPDATE "ChatUsageBucket" SET "count" = 5 WHERE "period" = ${`${DELETE_BUCKET}-day`}`;
  await prisma.$executeRaw`DELETE FROM "ChatUsageBucket" WHERE "period" = ${`${DELETE_BUCKET}-minute`}`;

  const kept = [await conversation(owner.id), await conversation(owner.id)];
  const refused = await bulk({ action: "delete", conversationIds: kept.map((row) => row.id) });
  assert.equal(refused.status, 429);
  assert.equal(await prisma.conversation.count({ where: { userId: owner.id } }), 2);
  // Archiving deletes nothing and is not held by the delete budget.
  assert.equal((await bulk({ action: "archive", conversationIds: [kept[0]!.id] })).status, 200);
});

test("delete-all and a selection delete share one bucket in either order", async () => {
  const owner = await user();
  signIn(owner);
  const rows = [await conversation(owner.id), await conversation(owner.id), await conversation(owner.id)];
  // Two selection deletes spend this minute's budget, and delete-all is refused.
  assert.equal((await bulk({ action: "delete", conversationIds: [rows[0]!.id] })).status, 200);
  assert.equal((await bulk({ action: "delete", conversationIds: [rows[1]!.id] })).status, 200);
  assert.equal((await deleteAll()).status, 429);
  assert.equal(await prisma.conversation.count({ where: { userId: owner.id } }), 1, "delete-all deleted nothing");
  // And the other way: two delete-alls in a minute, and a selection delete is refused.
  await prisma.$executeRaw`DELETE FROM "ChatUsageBucket"`;
  assert.equal((await deleteAll()).status, 200);
  const again = await conversation(owner.id);
  assert.equal((await deleteAll()).status, 200);
  const last = await conversation(owner.id);
  assert.equal((await bulk({ action: "delete", conversationIds: [last.id] })).status, 429);
  assert.equal(await prisma.conversation.count({ where: { id: last.id } }), 1);
  assert.equal(await prisma.conversation.count({ where: { id: again.id } }), 0);
});

/* -------------------------------------------------------------------------- */
/* Saved prompts                                                               */
/* -------------------------------------------------------------------------- */

const promptRequest = (path: string, method: string, body?: unknown) =>
  new Request(`${ORIGIN}/api/saved-prompts${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const listPrompts = async () =>
  ((await (await promptsRoute.GET(promptRequest("", "GET"))).json()) as { prompts: Array<{ id: string; title: string; body: string }> })
    .prompts;

test("saved prompts are the owner's alone: another account cannot read, edit or delete them", async () => {
  const owner = await user();
  const other = await user();
  signIn(owner);
  const created = await promptsRoute.POST(promptRequest("", "POST", { title: "  회의록 정리 ", body: "아래 회의록을 요약해 줘" }));
  assert.equal(created.status, 201);
  const { prompt } = (await created.json()) as { prompt: { id: string; title: string } };
  assert.equal(prompt.title, "회의록 정리");

  signIn(other);
  assert.deepEqual(await listPrompts(), []);
  const context = { params: Promise.resolve({ promptId: prompt.id }) };
  assert.equal((await promptRoute.PATCH(promptRequest(`/${prompt.id}`, "PATCH", { title: "가로채기" }), context)).status, 404);
  assert.equal((await promptRoute.DELETE(promptRequest(`/${prompt.id}`, "DELETE"), { params: Promise.resolve({ promptId: prompt.id }) })).status, 404);

  signIn(owner);
  const edited = await promptRoute.PATCH(promptRequest(`/${prompt.id}`, "PATCH", { body: "고친 본문" }), {
    params: Promise.resolve({ promptId: prompt.id }),
  });
  assert.equal(edited.status, 200);
  assert.deepEqual((await listPrompts()).map((row) => [row.title, row.body]), [["회의록 정리", "고친 본문"]]);
  assert.equal((await promptRoute.DELETE(promptRequest(`/${prompt.id}`, "DELETE"), { params: Promise.resolve({ promptId: prompt.id }) })).status, 200);
  assert.deepEqual(await listPrompts(), []);
});

test("saved prompts are bounded: count per account, title and body length, and no guest", async () => {
  const owner = await user();
  assert.equal((await promptsRoute.POST(promptRequest("", "POST", { title: "t", body: "b" }))).status, 401);
  signIn(owner);
  assert.equal(
    (await promptsRoute.POST(promptRequest("", "POST", { title: "x".repeat(SAVED_PROMPT_LIMITS.titleMax + 1), body: "b" }))).status,
    400
  );
  assert.equal(
    (await promptsRoute.POST(promptRequest("", "POST", { title: "t", body: "y".repeat(SAVED_PROMPT_LIMITS.bodyMax + 1) }))).status,
    400
  );
  assert.equal((await promptsRoute.POST(promptRequest("", "POST", { title: "t", body: "   " }))).status, 400);
  // The database refuses what the route would, for any other writer.
  await assert.rejects(
    prisma.savedPrompt.create({ data: { userId: owner.id, title: "", body: "b" } }),
    /SavedPrompt_bounds_check/
  );

  await prisma.savedPrompt.createMany({
    data: Array.from({ length: SAVED_PROMPT_LIMITS.count }, (_, index) => ({
      userId: owner.id,
      title: `p${index}`,
      body: "b",
      sortOrder: index,
    })),
  });
  const full = await promptsRoute.POST(promptRequest("", "POST", { title: "one more", body: "b" }));
  assert.equal(full.status, 409);
  assert.equal(((await full.json()) as { code: string }).code, "SAVED_PROMPT_LIMIT");
  const listed = await listPrompts();
  assert.equal(listed.length, SAVED_PROMPT_LIMITS.count);
  assert.equal(listed[0]?.title, `p${SAVED_PROMPT_LIMITS.count - 1}`, "newest first");
});

test("deleting the account deletes its saved prompts", async () => {
  const doomed = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      accountStatus: "pending_deletion",
      accountDeletionScheduledFor: new Date(Date.now() - 1_000),
    },
  });
  const keeper = await user();
  await prisma.savedPrompt.createMany({
    data: [
      { userId: doomed.id, title: "doomed", body: "b" },
      { userId: keeper.id, title: "kept", body: "b" },
    ],
  });
  assert.equal(await deleteScheduledAccounts(new Date()), 1);
  assert.deepEqual(
    (await prisma.savedPrompt.findMany({ select: { title: true } })).map((row) => row.title),
    ["kept"]
  );
});
