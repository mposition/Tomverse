import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { runAsScheduledTask } from "@/lib/scheduledTaskRunContext";

/**
 * The real Chat route, entered the way a scheduled run enters it.
 *
 * The request names a model the conversation has not selected, so the route
 * answers MODEL_NOT_SELECTED -- a refusal it can only reach after it has
 * resolved the session to the account and checked that the account owns the
 * conversation, and before any credit reservation or provider call. Outside
 * the run scope the identical request has no session and never gets there.
 */

const ids: { userId?: string } = {};
after(async () => {
  if (ids.userId) await prisma.user.deleteMany({ where: { id: ids.userId } });
  await prisma.$disconnect();
});

test("a scheduled run's request is the account inside its scope and nobody outside it", async () => {
  const userId = randomUUID();
  ids.userId = userId;
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, plan: "Pro" } });
  const conversation = await prisma.conversation.create({
    data: { userId, title: "Scheduled", productKey: "chat", kind: "chat", selectedModels: JSON.stringify(["gpt-6-luna"]) },
  });
  const questionId = randomUUID();
  const { scopedMessageId } = await import("@/lib/messageRequestIdentity");
  const sourceUserMessageId = scopedMessageId(conversation.id, questionId);
  await prisma.message.create({ data: { id: sourceUserMessageId, conversationId: conversation.id, role: "user", content: "Hello" } });

  const build = () => new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: questionId, role: "user", content: "Hello" }],
      // Not in the conversation's selectedModels.
      modelId: "gpt-5-4-mini",
      conversationId: conversation.id,
      assistantMessageId: randomUUID(),
      sourceUserMessageId,
      webSearchMode: "off",
    }),
  });
  const { POST } = await import("@/app/api/chat/route");

  const inside = build();
  const session = { user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 60_000).toISOString() };
  const response = await runAsScheduledTask(
    { runId: randomUUID(), userId, session, request: inside, creditCeiling: 1 },
    () => POST(inside)
  );
  const body = (await response.json()) as { code?: string };
  assert.equal(response.status, 403, JSON.stringify(body));
  assert.equal(body.code, "MODEL_NOT_SELECTED");

  const outside = build();
  const anonymous = await POST(outside);
  const anonymousBody = (await anonymous.json().catch(() => ({}))) as { code?: string };
  assert.notEqual(anonymousBody.code, "MODEL_NOT_SELECTED");
  assert.notEqual(anonymous.status, 200);
  assert.equal(await prisma.chatResponseAttempt.count({ where: { userId } }), 0);
  assert.equal(await prisma.chatCreditReservation.count({ where: { userId } }), 0);
});
