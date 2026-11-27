import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { SCHEDULED_TASK_LIMITS } from "@/lib/scheduledTaskCore";
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

const ids: { userId?: string; quoteUserIds: string[] } = { quoteUserIds: [] };
after(async () => {
  const userIds = [...(ids.userId ? [ids.userId] : []), ...ids.quoteUserIds];
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

// The quote test lets the route reserve and then dispatch. Nothing may reach a
// provider: every outbound request fails, so the turn ends as a provider
// error after its reservation committed.
process.env.OPENAI_API_KEY ||= "db-integration-test-key";
process.env.ANTHROPIC_API_KEY ||= "db-integration-test-key";
const offHostCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  offHostCalls.push(url);
  return new Response(JSON.stringify({ error: { message: "blocked in test" } }), { status: 500, headers: { "content-type": "application/json" } });
}) as typeof fetch;

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

/**
 * The quote a person approves is the ceiling the route holds the run to, so it
 * must not be lower than what the route reserves for the very turn the runner
 * sends. The run is given exactly the quote as its ceiling: a reservation
 * above it is refused by the guard and leaves reservedCredits at 0.
 */
// A cheap model and a priced one, a short question and the longest allowed:
// on a cheap model the capability blocks round into the same credit.
const LONG_PROMPT = "Summarise the following points for a weekly briefing. ".repeat(40).slice(0, SCHEDULED_TASK_LIMITS.promptCharacters);
const CASES = ["gpt-6-luna", "claude-sonnet-5"].flatMap((modelId) =>
  [false, true].flatMap((webSearch) => ["Summarise today's AI news in five bullets.", LONG_PROMPT].map((prompt) => ({ modelId, webSearch, prompt }))));
for (const { modelId, webSearch, prompt } of CASES) {
  test(`the route reserves no more than the quote for a scheduled turn (${modelId}, web search ${webSearch ? "on" : "off"}, ${prompt.length} chars)`, async (t) => {
    const { quoteScheduledRunCredits, ScheduledTaskError } = await import("@/lib/scheduledTaskService");
    const { scheduledRunAssistantMessageId } = await import("@/lib/scheduledTaskRunner");
    const { scopedMessageId } = await import("@/lib/messageRequestIdentity");
    const userId = randomUUID();
    ids.quoteUserIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId, email: `${userId}@example.invalid`, plan: "Pro",
        subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    let quote: number;
    try {
      quote = await quoteScheduledRunCredits({ userId, modelId, prompt, webSearch });
    } catch (error) {
      if (webSearch && error instanceof ScheduledTaskError && error.code === "WEB_SEARCH_UNAVAILABLE") {
        t.skip("no web search backend in this environment");
        return;
      }
      throw error;
    }
    assert.ok(quote > 0);
    const conversation = await prisma.conversation.create({
      data: {
        userId, title: "Scheduled", productKey: "chat", kind: "chat", selectedModels: JSON.stringify([modelId]),
        webSearchMode: webSearch ? "always" : "off",
      },
    });
    const task = await prisma.scheduledTask.create({
      data: {
        userId, title: "Morning news", prompt, modelId, webSearch, frequency: "daily", timeOfDay: "08:00",
        timeZone: "UTC", status: "active", creditsPerRun: quote, nextRunAt: new Date(), conversationId: conversation.id,
      },
    });
    const runId = randomUUID();
    const assistantMessageId = scheduledRunAssistantMessageId(runId);
    await prisma.scheduledTaskRun.create({
      data: {
        id: runId, taskId: task.id, userId, runningUserId: userId, taskRevision: task.revision, scheduledFor: new Date(),
        conversationId: conversation.id, assistantMessageId, leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    const questionId = randomUUID();
    const sourceUserMessageId = scopedMessageId(conversation.id, questionId);
    await prisma.message.create({ data: { id: sourceUserMessageId, conversationId: conversation.id, role: "user", content: prompt } });

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en" },
      body: JSON.stringify({
        messages: [{ id: questionId, role: "user", content: prompt }],
        modelId,
        conversationId: conversation.id,
        assistantMessageId,
        sourceUserMessageId,
        webSearchMode: webSearch ? "always" : "off",
      }),
    });
    const { POST } = await import("@/app/api/chat/route");
    const session = { user: { id: userId, email: `${userId}@example.invalid` }, expires: new Date(Date.now() + 60_000).toISOString() };
    const response = await runAsScheduledTask(
      { runId, userId, session, request, creditCeiling: quote },
      async () => {
        const answer = await POST(request);
        // Read to the end, as the runner does: that is what lets the turn settle.
        await answer.clone().text().catch(() => "");
        return answer;
      }
    );
    const code = response.ok ? null : ((await response.json().catch(() => ({}))) as { code?: string }).code;
    assert.notEqual(code, "SCHEDULED_TASK_CREDIT_CAP_EXCEEDED", `quote ${quote} was below the route's reservation`);
    const run = await prisma.scheduledTaskRun.findUniqueOrThrow({ where: { id: runId }, select: { reservedCredits: true } });
    assert.ok(run.reservedCredits > 0, `the route never reached its reservation (status ${response.status}, code ${code})`);
    t.diagnostic(`quote ${quote}, reserved ${run.reservedCredits}`);
    assert.ok(run.reservedCredits <= quote, `reserved ${run.reservedCredits} > quote ${quote}`);
  });
}
