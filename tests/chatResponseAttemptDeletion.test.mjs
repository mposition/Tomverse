import assert from "node:assert/strict";
import test from "node:test";

import { deleteChatResponseAttemptsForModelHistory } from "../lib/chatResponseAttemptDeletion.ts";

test("per-model history deletion blocks conversation-wide active work then scopes terminal cleanup", async () => {
  const calls = [];
  const tx = {
    $executeRaw: async () => { calls.push(["sql"]); return 1; },
    message: {
      findMany: async (input) => {
        calls.push(["find", input]);
        return [{ id: "assistant_target_1" }, { id: "assistant_target_2" }];
      },
    },
    chatResponseAttempt: {
      findFirst: async (input) => { calls.push(["active", input]); return null; },
      deleteMany: async (input) => {
        calls.push(["delete", input]);
        return { count: 2 };
      },
    },
    conversation: {
      updateMany: async (input) => { calls.push(["fence", input]); return { count: 1 }; },
    },
  };

  const count = await deleteChatResponseAttemptsForModelHistory(tx, {
    userId: "user_1",
    conversationId: "conversation_1",
    modelId: "provider/model-a",
  });

  assert.equal(count, 2);
  assert.equal(calls[0][0], "sql");
  assert.equal(calls[1][0], "sql");
  assert.equal(calls[2][0], "active");
  assert.deepEqual(calls[2][1], {
    where: {
      userId: "user_1",
      conversationId: "conversation_1",
      status: { in: ["claimed", "streaming"] },
    },
    select: { assistantMessageId: true },
  });
  assert.equal(calls[3][0], "fence");
  assert.deepEqual(calls[4][1], {
    where: {
      conversationId: "conversation_1",
      modelId: "provider/model-a",
      role: "assistant",
    },
    select: { id: true },
  });
  assert.deepEqual(calls[5][1].where, {
    userId: "user_1",
    conversationId: "conversation_1",
    OR: [
      { assistantMessageId: { in: ["assistant_target_1", "assistant_target_2"] } },
      { actualModelId: "provider/model-a" },
      { actualModelId: null, requestedModelId: "provider/model-a" },
    ],
  });
  assert.deepEqual(
    calls[5][1].where.OR[0].assistantMessageId.in.includes("assistant_unrelated"),
    false
  );
});

test("a terminal no-message attempt is removed after the active precheck", async () => {
  let deletionWhere;
  const count = await deleteChatResponseAttemptsForModelHistory(
    {
      $executeRaw: async () => 1,
      message: { findMany: async () => [] },
      chatResponseAttempt: {
        findFirst: async () => null,
        deleteMany: async (input) => {
          deletionWhere = input.where;
          return { count: 1 };
        },
      },
      conversation: { updateMany: async () => ({ count: 1 }) },
    },
    { userId: "user_1", conversationId: "conversation_1", modelId: "provider/model-a" }
  );
  assert.equal(count, 1);
  assert.deepEqual(deletionWhere.OR, [
    { actualModelId: "provider/model-a" },
    { actualModelId: null, requestedModelId: "provider/model-a" },
  ]);
  assert.equal(Object.hasOwn(deletionWhere, "status"), false);
});

test("an active attempt from any model refuses clear before fencing or deletion", async () => {
  const calls = [];
  await assert.rejects(
    deleteChatResponseAttemptsForModelHistory(
      {
        $executeRaw: async () => { calls.push("sql"); return 1; },
        message: { findMany: async () => { calls.push("messages"); return []; } },
        chatResponseAttempt: {
          findFirst: async (input) => {
            calls.push("active");
            assert.deepEqual(input.where, {
              userId: "user_1",
              conversationId: "conversation_1",
              status: { in: ["claimed", "streaming"] },
            });
            return { assistantMessageId: "assistant_active_orphan" };
          },
          deleteMany: async () => { calls.push("delete"); return { count: 1 }; },
        },
        conversation: {
          updateMany: async () => { calls.push("fence"); return { count: 1 }; },
        },
      },
      {
        userId: "user_1",
        conversationId: "conversation_1",
        modelId: "provider/model-a",
      }
    ),
    (error) => error?.code === "CHAT_RESPONSE_IN_PROGRESS"
  );
  assert.deepEqual(calls, ["sql", "sql", "active"]);
});

test("expired active rows are reconciled before the deletion precheck", async () => {
  const calls = [];
  await deleteChatResponseAttemptsForModelHistory(
    {
      $executeRaw: async () => { calls.push("sql"); return 1; },
      message: { findMany: async () => [] },
      chatResponseAttempt: {
        findFirst: async () => { calls.push("active"); return null; },
        deleteMany: async () => ({ count: 1 }),
      },
      conversation: { updateMany: async () => ({ count: 1 }) },
    },
    { userId: "user_1", conversationId: "conversation_1", modelId: "provider/model-a" }
  );
  assert.deepEqual(calls.slice(0, 3), ["sql", "sql", "active"]);
});

test("the message route invokes attempt cleanup inside its existing transaction", () => {
  const route = new URL(
    "../app/api/conversations/[conversationId]/messages/route.ts",
    import.meta.url
  );
  return import("node:fs/promises").then(async ({ readFile }) => {
    const source = await readFile(route, "utf8");
    const cleanup = source.indexOf("deleteChatResponseAttemptsForModelHistory(tx");
    const transactionStart = source.lastIndexOf("await prisma.$transaction(async (tx) => {", cleanup);
    const messageDelete = source.indexOf("const deletedSources = await tx.message.deleteMany", cleanup);
    const transactionEnd = source.indexOf("\n        });", messageDelete);
    assert.ok(transactionStart >= 0 && transactionStart < cleanup);
    assert.ok(cleanup < messageDelete && messageDelete < transactionEnd);
  });
});
