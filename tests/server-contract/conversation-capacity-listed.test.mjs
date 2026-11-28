import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { LISTED_CONVERSATION_WHERE, STUDIO_RUN_CONVERSATION } from "../../lib/conversationProduct.ts";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
const { ApiSecurityError, assertConversationCapacity, STORAGE_LIMITS } = await import("../../lib/apiSecurity.ts");

const fakeTx = (count) => {
  const calls = { locked: 0, where: null };
  return {
    calls,
    $executeRaw: async () => { calls.locked += 1; },
    conversation: { count: async ({ where }) => { calls.where = where; return count; } },
  };
};

test("the conversation quota counts what the list shows, not every row the account owns", async () => {
  const tx = fakeTx(0);
  await assertConversationCapacity(tx, "owner");
  assert.equal(tx.calls.locked, 1);
  // The same filter the list route uses: Studio tool runs and temporary Chats are hidden, so they are not counted.
  assert.deepEqual(tx.calls.where, { userId: "owner", ...LISTED_CONVERSATION_WHERE });
  assert.deepEqual(LISTED_CONVERSATION_WHERE, { NOT: STUDIO_RUN_CONVERSATION, temporaryExpiresAt: null });
});

test("the quota is exceeded exactly at the limit, with the existing code", async () => {
  const limit = STORAGE_LIMITS.conversationsPerUser();
  await assertConversationCapacity(fakeTx(limit - 1), "owner");
  await assert.rejects(assertConversationCapacity(fakeTx(limit), "owner"), (error) =>
    error instanceof ApiSecurityError && error.status === 409 && error.code === "CONVERSATION_STORAGE_QUOTA_EXCEEDED");
});

test("the list route and the quota read one definition of 'listed'", () => {
  const list = readFileSync("app/api/conversations/route.ts", "utf8");
  assert.match(list, /where: \{ userId, \.\.\.LISTED_CONVERSATION_WHERE \}/);
  assert.match(readFileSync("lib/apiSecurity.ts", "utf8"), /where: \{ userId, \.\.\.LISTED_CONVERSATION_WHERE \}/);
});

test("every path that makes a listed conversation takes the same quota before it writes", () => {
  for (const [path, createMarker] of [
    ["lib/conversationCreateHandler.ts", "createConversation(tx"],
    ["app/api/conversations/import-guest/route.ts", "createConversation(tx"],
    ["lib/researchEngineService.ts", "createConversation(tx"],
    ["lib/externalContinuationService.ts", "createConversation(\n"],
    ["lib/reviewContinuationHandoffService.ts", "createConversation(\n"],
    ["lib/scheduledTaskRunner.ts", "createConversation(tx"],
  ]) {
    const source = readFileSync(path, "utf8");
    const capacity = source.indexOf("assertConversationCapacity(tx");
    const create = source.indexOf(createMarker, capacity);
    assert.ok(capacity > 0, `${path} checks the conversation quota`);
    assert.ok(create > capacity, `${path} checks the quota before it creates`);
  }
  // A Studio image run is a hidden one-off row, not a conversation the person made: it is outside the quota.
  assert.doesNotMatch(readFileSync("lib/imageGenerationService.ts", "utf8"), /assertConversationCapacity/);
});

test("a research run and a scheduled turn take the message quota before their first message", () => {
  const research = readFileSync("lib/researchEngineService.ts", "utf8");
  const capacity = research.indexOf("assertMessageCapacity(tx, input.userId, conversationId");
  assert.ok(capacity > 0);
  assert.ok(research.indexOf("tx.message.create", capacity) > capacity);
  assert.match(readFileSync("lib/scheduledTaskRunner.ts", "utf8"), /assertMessageCapacity\(tx, run\.userId, conversationId/);
});
