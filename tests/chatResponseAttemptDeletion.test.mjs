import assert from "node:assert/strict";
import test from "node:test";

import { deleteChatResponseAttemptsForModelHistory } from "../lib/chatResponseAttemptDeletion.ts";

test("per-model history deletion scopes message and active-attribution matches", async () => {
  const calls = [];
  const tx = {
    message: {
      findMany: async (input) => {
        calls.push(["find", input]);
        return [{ id: "assistant_target_1" }, { id: "assistant_target_2" }];
      },
    },
    chatResponseAttempt: {
      deleteMany: async (input) => {
        calls.push(["delete", input]);
        return { count: 2 };
      },
    },
  };

  const count = await deleteChatResponseAttemptsForModelHistory(tx, {
    userId: "user_1",
    conversationId: "conversation_1",
    modelId: "provider/model-a",
  });

  assert.equal(count, 2);
  assert.deepEqual(calls[0][1], {
    where: {
      conversationId: "conversation_1",
      modelId: "provider/model-a",
      role: "assistant",
    },
    select: { id: true },
  });
  assert.deepEqual(calls[1][1].where, {
    userId: "user_1",
    conversationId: "conversation_1",
    OR: [
      { assistantMessageId: { in: ["assistant_target_1", "assistant_target_2"] } },
      { actualModelId: "provider/model-a" },
      { actualModelId: null, requestedModelId: "provider/model-a" },
    ],
  });
  assert.deepEqual(
    calls[1][1].where.OR[0].assistantMessageId.in.includes("assistant_unrelated"),
    false
  );
});

test("a no-message attempt is removed without restricting its status", async () => {
  let deletionWhere;
  const count = await deleteChatResponseAttemptsForModelHistory(
    {
      message: { findMany: async () => [] },
      chatResponseAttempt: {
        deleteMany: async (input) => {
          deletionWhere = input.where;
          return { count: 1 };
        },
      },
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
