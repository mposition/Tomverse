import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;

let rows = [];
let transactions = [];
let deletes = [];
let failOnBatch = null;
let rateScopes = [];

mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session: null }) } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async (_request, userId, scope) => {
    assert.equal(userId, "owner");
    rateScopes.push(scope);
  },
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  getRuntimeModels: async () => [], clampSelectedModelsAgainstRuntime: (models) => models,
} });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
  hasConversationUnlockGrant: () => false,
} });
mock.module(mod("lib/conversationCreateHandler.ts"), { namedExports: { createConversationForProduct: () => { throw Error("Unexpected write"); } } });
mock.module(mod("lib/conversationDeletion.ts"), { namedExports: {
  deleteOwnedConversations: async (tx, input) => {
    assert.equal(input.userId, "owner");
    deletes.push([...input.conversationIds]);
    if (failOnBatch === deletes.length) throw new Error("deadlock detected");
    return { count: input.conversationIds.length, conversationIds: input.conversationIds };
  },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  userSettings: { findUnique: async () => null },
  conversation: { findMany: async ({ where }) => {
    // Everything the account owns: the button's scope is not narrowed by this change.
    assert.deepEqual(where, { userId: "owner" });
    return rows;
  } },
  $transaction: async (run, options) => {
    transactions.push(options);
    return run({});
  },
} } });

const { DELETE } = await import("../../app/api/conversations/route.ts");
const call = () => DELETE(new Request("https://tomverse.app/api/conversations", { method: "DELETE" }));
const setRows = (count) => {
  rows = Array.from({ length: count }, (_, index) => ({ id: `c${index}`, password: null, passwordVersion: 0 }));
  transactions = [];
  deletes = [];
  failOnBatch = null;
  rateScopes = [];
};

test("a large account is deleted in batches of fifty, each in its own transaction, and the count is exact", async () => {
  setRows(120);
  const response = await call();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, deleted: 120 });
  assert.deepEqual(deletes.map((batch) => batch.length), [50, 50, 20]);
  assert.equal(transactions.length, 3);
  // A batch's window is explicit; the five-second default is what the one big transaction outgrew.
  for (const options of transactions) assert.ok(options.timeout >= 10_000, JSON.stringify(options));
  assert.deepEqual(rateScopes, ["conversation-delete-all"]);
});

test("nothing to delete answers zero without a transaction", async () => {
  setRows(0);
  const response = await call();
  assert.deepEqual(await response.json(), { success: true, deleted: 0 });
  assert.equal(transactions.length, 0);
});

test("a failure after some batches committed reports exactly what was deleted and what is left", async () => {
  setRows(120);
  failOnBatch = 2;
  const response = await call();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Some conversations could not be deleted.",
    code: "CONVERSATION_DELETE_PARTIAL",
    deleted: 50,
    remaining: 70,
  });
  // It stopped at the failure instead of carrying on past it.
  assert.equal(deletes.length, 2);
});

test("a failure of the first batch keeps the plain error: nothing was deleted", async () => {
  setRows(120);
  failOnBatch = 1;
  const response = await call();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Failed to delete conversations." });
});
