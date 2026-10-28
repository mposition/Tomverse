import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createApiTransport } from "../../apps/mobile/src/apiTransport.ts";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const date = new Date("2026-10-27T00:00:00.000Z");
const row = (id, productKey, continued = false) => ({
  id, productKey, title: id, updatedAt: date, pinnedAt: null, pinSeq: 0,
  kind: productKey === "studio" ? "image" : "chat", projectId: null,
  selectedModels: ["fixture-model"], disabledPanels: [], webSearchMode: "off",
  shareEnabled: false, shareExpiresAt: null, password: null, _count: { messages: 0 },
  continuationBridge: continued ? {
    id: `bridge-${id}`, provider: "chatgpt", createdAt: date,
    externalConversationId: `source-${id}`,
    externalConversation: { title: `Original ${id}`, password: null },
  } : null,
});
const rows = [row("ordinary-chat", "chat"), row("imported-chat", "chat", true),
  row("imported-review", "review", true), row("legacy-review", null), row("studio", "studio")];
let listQueries = 0;
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: {
  resolveChatRouteSession: async () => ({ session: { user: { id: "fixture-owner" } } }),
} });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  userSettings: { findUnique: async () => null },
  conversation: { findMany: async ({ where, select }) => {
    assert.deepEqual(where, { userId: "fixture-owner" });
    assert.equal(select.productKey, true);
    listQueries++;
    return rows;
  } },
} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async (_req, userId) => assert.equal(userId, "fixture-owner"),
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  getRuntimeModels: async () => [], clampSelectedModelsAgainstRuntime: models => models,
} });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  conversationLockedResponse: () => Response.json({}, { status: 423 }),
  hasConversationUnlockGrant: () => false,
} });
for (const [path, name] of [
  ["imageAssetLifecycle", "enqueueImageAssetCleanupForConversations"],
  ["generatedArtifactStorage", "enqueueArtifactCleanupForConversations"],
  ["messageAttachmentStorage", "enqueueMessageAttachmentCleanupForConversations"],
  ["deepResearchJobs", "deleteDeepResearchJobsForConversations"],
  ["conversationCreateHandler", "createConversationForProduct"],
]) mock.module(mod(`lib/${path}.ts`), { namedExports: { [name]: () => { throw Error("Unexpected write"); } } });

const { GET } = await import("../../app/api/conversations/route.ts");
const request = () => new Request("https://tomverse.app/api/conversations");

test("the real list response preserves product identity for imported and legacy conversations", async () => {
  const response = await GET(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.map(({ id, productKey, surface }) => ({ id, productKey, surface })), [
    { id: "ordinary-chat", productKey: "chat", surface: "chat" },
    { id: "imported-chat", productKey: "chat", surface: "continuation" },
    { id: "imported-review", productKey: "review", surface: "continuation" },
    { id: "legacy-review", productKey: null, surface: "workspace" },
    { id: "studio", productKey: "studio", surface: "workspace" },
  ]);
  assert.ok(result.every(value => !("password" in value) && !("continuationBridge" in value)));
});

test("native history lists the server's continued Chat with Chat and continued Review with Review", async () => {
  const transport = createApiTransport(async (path, init) => {
    assert.equal(path, "/api/conversations");
    assert.equal(new Headers(init?.headers).get("X-Tomverse-Time-Zone"), Intl.DateTimeFormat().resolvedOptions().timeZone);
    return GET(request());
  }, { signOut: async () => {} });
  assert.deepEqual((await transport.list()).map(value => value.id), ["ordinary-chat", "imported-chat"]);
  assert.deepEqual((await transport.listReview()).map(value => value.id), ["imported-review", "legacy-review", "studio"]);
  assert.equal(listQueries, 3);
});
