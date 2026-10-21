import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prisma, prismaPoolUsage } from "@/lib/prisma";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { buildAccountDataExport } from "@/lib/accountDataExport";
import { writeChatComposerDraft } from "@/lib/chatComposerDraftPersistence";
import {
  ChatAttemptCasError,
  checkpointChatResponseAttempt,
  claimChatResponseAttempt,
} from "@/lib/chatResponseAttemptPersistence";

// Identity and deployment switches are fixtures; a real-query extension controls
// race timing. Share writes, exports, cascades and worker fences use the test DB.
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let signedInUserId: string | null = null;
let duringPreparation: (() => Promise<void>) | null = null;
let afterMessagesRead: (() => Promise<void>) | null = null;
mock.module("next-auth/next", {
  namedExports: {
    getServerSession: async () => signedInUserId ? { user: { id: signedInUserId } } : null,
  },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });

let shares: typeof import("@/app/api/conversations/[conversationId]/share/route");
let publicShares: typeof import("@/app/api/public/shares/[shareToken]/route");
let singleExport: typeof import("@/app/api/conversations/[conversationId]/export/route");
let allExports: typeof import("@/app/api/conversations/export-all/route");
const userIds: string[] = [];

before(async () => {
  const routeDatabase = prisma.$extends({
    query: {
      message: {
        async findMany({ args, query }) {
          const rows = await query(args);
          if (afterMessagesRead) await afterMessagesRead();
          return rows;
        },
      },
    },
  });
  mock.module(mod("lib/prisma.ts"), {
    namedExports: { prisma: routeDatabase, prismaPoolUsage },
  });
  const settings = await import(mod("lib/appSettings.ts"));
  mock.module(mod("lib/appSettings.ts"), {
    namedExports: {
      ...settings,
      getOperationalFeatureFlags: async () => ({
        ...await settings.getOperationalFeatureFlags(),
        publicSharingEnabled: true,
      }),
      isMemoryInjectionEnabled: async () => {
        const mutate = duringPreparation;
        duringPreparation = null;
        if (mutate) await mutate();
        return false;
      },
    },
  });
  shares = await import(mod("app/api/conversations/[conversationId]/share/route.ts"));
  publicShares = await import(mod("app/api/public/shares/[shareToken]/route.ts"));
  singleExport = await import(mod("app/api/conversations/[conversationId]/export/route.ts"));
  allExports = await import(mod("app/api/conversations/export-all/route.ts"));
});

beforeEach(() => {
  signedInUserId = null;
  duringPreparation = null;
  afterMessagesRead = null;
});
after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function seed(productKey = "chat") {
  const user = await prisma.user.create({
    data: { email: `c16-${randomUUID()}@example.invalid`, plan: "Pro" },
  });
  userIds.push(user.id);
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id, title: "C16 conversation", kind: "chat", productKey,
      selectedModels: '["gpt-6-luna"]',
    },
  });
  const source = await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: "The authored question" },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id, role: "assistant", modelId: "gpt-6-luna",
      content: "The original answer", createdAt: new Date(source.createdAt.getTime() + 1),
    },
  });
  signedInUserId = user.id;
  return { user, conversation, source };
}

const request = (conversationId: string, method = "POST") =>
  new Request(`https://tomverse.test/api/conversations/${conversationId}/share`, { method });
const context = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });
async function publish(conversationId: string) {
  return shares.POST(request(conversationId), context(conversationId));
}
async function readShare(token: string) {
  return publicShares.GET(
    new Request(`https://tomverse.test/api/public/shares/${token}`),
    { params: Promise.resolve({ shareToken: token }) },
  );
}
async function publishedToken(conversationId: string) {
  const response = await publish(conversationId);
  assert.equal(response.status, 200, await response.clone().text());
  return new URL((await response.json()).url).pathname.split("/").at(-1)!;
}

test("sharing refuses an unauthenticated caller, a foreign owner and a locked Chat", async () => {
  const { conversation } = await seed();
  signedInUserId = null;
  assert.equal((await publish(conversation.id)).status, 401);
  await seed();
  assert.equal((await publish(conversation.id)).status, 403);
  signedInUserId = conversation.userId;
  await prisma.conversation.update({ where: { id: conversation.id }, data: { password: "locked" } });
  assert.equal((await publish(conversation.id)).status, 423);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).shareToken, null);
});

test("a Chat share is a fixed snapshot and revocation immediately closes its link", async () => {
  const { conversation } = await seed();
  const token = await publishedToken(conversation.id);
  await prisma.message.updateMany({
    where: { conversationId: conversation.id, role: "assistant" }, data: { content: "Later private answer" },
  });
  const response = await readShare(token);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.productKey, "chat");
  assert.equal(body.snapshot.messages.at(-1).content, "The original answer");
  assert.equal(JSON.stringify(body).includes("Later private answer"), false);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  assert.equal((await shares.DELETE(request(conversation.id, "DELETE"), context(conversation.id))).status, 200);
  assert.equal((await readShare(token)).status, 404);
});

for (const change of ["lock", "revoke", "replace", "history_reset", "delete"] as const) {
  test(`a concurrent ${change} wins over an in-flight share preparation`, async () => {
    const { conversation } = await seed();
    const oldToken = await publishedToken(conversation.id);
    const replacement = "replacement-token-01234567890123456789";
    duringPreparation = async () => {
      if (change === "delete") {
        await prisma.conversation.delete({ where: { id: conversation.id } });
      } else {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: change === "lock" ? { password: "new-lock" }
            : change === "history_reset" ? { chatRecoveryEpoch: { increment: 1 } }
            : change === "replace" ? { shareToken: replacement }
              : { shareEnabled: false, shareToken: null, shareRevokedAt: new Date() },
        });
      }
    };
    const response = await publish(conversation.id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "SHARE_SOURCE_CHANGED");
    const row = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(row?.shareToken ?? null,
      change === "replace" ? replacement : change === "lock" || change === "history_reset" ? oldToken : null);
    if (change === "revoke" || change === "delete") {
      assert.equal((await readShare(oldToken)).status, 404);
    }
  });
}

test("single and combined exports identify Chat and keep every model's answer", async () => {
  const { conversation } = await seed();
  await prisma.message.create({
    data: { conversationId: conversation.id, role: "assistant", modelId: "gpt-4o", content: "A different model's answer" },
  });
  for (const response of [
    await singleExport.GET(new Request(`https://tomverse.test/api/conversations/${conversation.id}/export`), context(conversation.id)),
    await allExports.GET(new Request("https://tomverse.test/api/conversations/export-all")),
  ]) {
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /^Tomverse Chat Export/);
    assert.match(text, /The original answer/);
    assert.match(text, /A different model's answer/);
    assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  }
});

test("Chat export refuses a foreign owner and a locked conversation", async () => {
  const { conversation } = await seed();
  await seed();
  const url = `https://tomverse.test/api/conversations/${conversation.id}/export`;
  assert.equal((await singleExport.GET(new Request(url), context(conversation.id))).status, 404);
  signedInUserId = conversation.userId;
  await prisma.conversation.update({ where: { id: conversation.id }, data: { password: "locked" } });
  assert.equal((await singleExport.GET(new Request(url), context(conversation.id))).status, 423);
});

async function attachSource(userId: string, conversationId: string) {
  const imported = await prisma.externalImport.create({
    data: { userId, provider: "chatgpt", status: "completed", digestVersion: 1, parserVersion: "test" },
  });
  const source = await prisma.externalConversation.create({
    data: {
      userId, importId: imported.id, provider: "chatgpt", externalStableId: randomUUID(),
      title: "Imported original", conversationDigest: "c16-source", digestVersion: 1,
      messageCount: 1, contentBytes: BigInt(32), finalized: true,
    },
  });
  await prisma.externalMessage.create({
    data: {
      userId, externalConversationId: source.id, externalStableId: randomUUID(),
      role: "user", content: "A privately imported original", contentDigest: "c16-message",
      digestVersion: 1, ordinal: 0,
    },
  });
  await prisma.conversationContinuationBridge.create({
    data: {
      userId, conversationId, externalConversationId: source.id,
      provider: "chatgpt", sourceImportedAt: imported.createdAt, sourceConversationDigest: "c16-source",
      sourceDigestVersion: 1, sourceMessageCount: 1, seedFromOrdinal: 0, seedToOrdinal: 0,
      seedMessageCount: 1, seedTruncatedMessageCount: 0, seedOmittedMessageCount: 0,
      contextSeedVersion: "ext-seed-v1", idempotencyKey: randomUUID(),
    },
  });
}

test("a continued Chat exports its original privately with the Chat header and still refuses public sharing", async () => {
  const { user, conversation } = await seed();
  await attachSource(user.id, conversation.id);
  const response = await singleExport.GET(
    new Request(`https://tomverse.test/api/conversations/${conversation.id}/export?include=source`),
    context(conversation.id),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text();
  assert.match(text, /^Tomverse Chat Export/);
  assert.match(text, /A privately imported original/);
  assert.match(text, /The original answer/);
  assert.ok(response.headers.get("X-Export-SHA256"));
  const sharing = await publish(conversation.id);
  assert.equal(sharing.status, 409);
  assert.equal((await sharing.json()).code, "CONTINUATION_SHARE_NOT_SUPPORTED");
});

for (const mutation of ["edit", "delete", "insert"] as const) {
  test(`a message ${mutation} after snapshot reading prevents publication`, async () => {
    const { conversation, source } = await seed();
    afterMessagesRead = async () => {
      afterMessagesRead = null;
      if (mutation === "insert") {
        await prisma.message.create({
          data: { conversationId: conversation.id, role: "assistant", content: "A new private answer" },
        });
      } else if (mutation === "edit") {
        await prisma.message.update({ where: { id: source.id }, data: { content: "New private words" } });
      } else {
        await prisma.message.delete({ where: { id: source.id } });
      }
    };
    const response = await publish(conversation.id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "SHARE_SOURCE_CHANGED");
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).shareToken, null);
  });
}

test("a continuation bridge attached after snapshot reading prevents publication", async () => {
  const { user, conversation } = await seed();
  afterMessagesRead = async () => {
    afterMessagesRead = null;
    await attachSource(user.id, conversation.id);
  };
  const response = await publish(conversation.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "SHARE_SOURCE_CHANGED");
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).shareToken, null);
});

test("concurrent share preparations issue one usable link and one explicit conflict", async () => {
  const { conversation } = await seed();
  let readers = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  afterMessagesRead = async () => {
    readers++;
    if (readers === 2) {
      afterMessagesRead = null;
      release();
    }
    await ready;
  };
  const responses = await Promise.all([publish(conversation.id), publish(conversation.id)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const refused = responses.find((response) => response.status === 409)!;
  assert.equal((await refused.json()).code, "SHARE_SOURCE_CHANGED");
  const accepted = responses.find((response) => response.status === 200)!;
  const token = new URL((await accepted.json()).url).pathname.split("/").at(-1)!;
  const shared = await readShare(token);
  assert.equal(shared.status, 200);
  assert.deepEqual(
    (await shared.json()).snapshot.messages.map((message: { content: string }) => message.content),
    ["The authored question", "The original answer"],
  );
});

test("account deletion removes live Chat recovery, Auto content and shares without reviving a late worker", async () => {
  const { user, conversation, source } = await seed();
  const token = await publishedToken(conversation.id);
  const other = await seed();
  await writeChatComposerDraft({
    userId: user.id, userEmail: user.email!, scopeKey: conversation.id,
    draft: { expectedRevision: 0, text: "Unsent private draft", attachmentReferences: [] },
  });
  const assistantMessageId = randomUUID();
  const worker = "c16-private-worker";
  await claimChatResponseAttempt({
    userId: user.id, conversationId: conversation.id, sourceUserMessageId: source.id,
    assistantMessageId, requestedModelId: "gpt-6-luna", requestPayloadDigest: "a".repeat(64),
    expectedRecoveryEpoch: 0, ownerId: worker, leaseExpiresAt: new Date(Date.now() + 120_000),
  });
  await checkpointChatResponseAttempt({
    userId: user.id, assistantMessageId, ownerId: worker, expectedRevision: 0,
    partialContent: "A private partial answer",
  });
  await prisma.autoRouterDecision.create({
    data: {
      userId: user.id, conversationId: conversation.id, version: "test", traceId: "private-trace",
      routerInput: "Private input", routerContext: "Private context", rewrite: "Private rewrite",
      sessionTopic: "Private topic", candidates: [], taskKind: "general",
      ruleModelId: "gpt-6-luna", routerModelId: "gpt-6-luna", outcome: "picked", latencyMs: 1,
    },
  });
  assert.equal((await buildAccountDataExport(other.user.id)).data.auto_model_choices.length, 0);
  assert.equal((await deleteTomverseAccount(user.id, { cancelSubscription: false })).deleted, true);
  assert.equal(await prisma.chatComposerDraft.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.chatResponseAttempt.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.autoRouterDecision.count({ where: { userId: user.id } }), 0);
  assert.equal((await readShare(token)).status, 404);
  await assert.rejects(checkpointChatResponseAttempt({
    userId: user.id, assistantMessageId, ownerId: worker, expectedRevision: 1, partialContent: "Late private answer",
  }), ChatAttemptCasError);
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 0);
  assert.equal(await prisma.conversation.count({ where: { id: other.conversation.id } }), 1);
});
