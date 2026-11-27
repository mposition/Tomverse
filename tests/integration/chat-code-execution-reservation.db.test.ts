import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  CODE_EXECUTION_RESERVED_PASSES,
  codeExecutionReservedPasses,
  resolveCodeExecution,
} from "@/lib/chatCodeExecutionCore";
import {
  acquireChatAccess,
  createChatBudget,
  getChatBudgetReservedCostMicroUsd,
  settleChatUsage,
  type ChatAccess,
} from "@/lib/chatSecurity";
import { getModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";

/**
 * Code execution's reservation, against a real database.
 *
 * Review r-20261127-073816-5a1bf4: Gemini bills the prompt again for every run
 * ("the original prompt, the generated code, and the result of the executed
 * code are labeled intermediate tokens and are billed as input tokens"), so
 * the turn reserves one provider pass per run that can be billed before the
 * request is sent (docs/policy/chat-attachment-formats.md 2.3.1). The budget is
 * built from the same two calls the route makes -- the decision, then its
 * passes on both pass counts -- and what is checked is what the reservation
 * transaction actually held: the credits, the provider bucket and the pass
 * count frozen on the row that settlement reads back.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProviderDailyUsage",
      "TokenEstimateShadowSample",
      "ChatAttemptUsageAdjustment",
      "ChatAttemptUsage",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditLedgerEntry",
      "CreditLot",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const model = getModel("gemini-3-6-flash")!;

const access = async (): Promise<ChatAccess> => {
  const user = await prisma.user.create({
    data: { email: `code-execution-${randomUUID()}@example.test`, plan: "Pro" },
  });
  return {
    kind: "user",
    userId: user.id,
    plan: "Pro",
    subjectKey: `integration:user:${user.id}`,
    ipKey: `integration:ip:${user.id}`,
    planLimits: { dailyMessageLimit: 10_000, monthlyMessageLimit: 10_000 },
  };
};

/** The route's two calls: the decision, then its passes on both counts. */
const routeBudget = (estimatedInputTokens: number, codeExecutionOn: boolean) => {
  const decision = resolveCodeExecution({
    env: { CHAT_CODE_EXECUTION_ENABLED: codeExecutionOn ? "true" : undefined },
    model,
    accessKind: "user",
    researchTurn: false,
    applicationToolLoop: false,
  });
  const passes = codeExecutionReservedPasses(decision);
  return {
    decision,
    budget: createChatBudget("user", model, estimatedInputTokens, {
      toolInputPasses: passes,
      longContextToolInputPasses: passes,
    }),
  };
};

const microdollars = (tokens: number, usdPerMillion: number) =>
  Math.ceil(tokens * usdPerMillion);

const providerBucket = (period: string) =>
  prisma.chatUsageBucket
    .findFirst({ where: { key: "provider:google", period } })
    .then((row) => usageBucketCount(row?.count));

test("an ordinary code-execution turn holds every billable run against the provider budget", async () => {
  const { decision, budget } = routeBudget(2_000, true);
  assert.equal(decision.enabled, true);
  const { budget: plain } = routeBudget(2_000, false);

  // Four passes of the prompt and three of the output cap re-read, on input;
  // the output reservation is the model's own, untouched.
  const context = budget.contextInputTokens!;
  assert.equal(budget.providerCallPasses, CODE_EXECUTION_RESERVED_PASSES);
  assert.equal(
    budget.inputTokens,
    context * CODE_EXECUTION_RESERVED_PASSES +
      budget.maxOutputTokens * (CODE_EXECUTION_RESERVED_PASSES - 1)
  );
  assert.equal(budget.reservedOutputTokens, plain.reservedOutputTokens);
  // Credits are the flat weight, exactly as without the tool.
  assert.equal(budget.usageCredits, plain.usageCredits);

  const acquired = await acquireChatAccess(await access(), budget, {
    traceId: `trace-${randomUUID()}`,
  });
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  const expectedCost =
    microdollars(budget.inputTokens, budget.inputUsdPerMillionTokens) +
    microdollars(budget.reservedOutputTokens, budget.outputUsdPerMillionTokens);
  assert.equal(getChatBudgetReservedCostMicroUsd(budget), expectedCost);
  assert.equal(Number(row.reservedCostMicroUsd), expectedCost);
  assert.equal(row.reservedCredits, plain.usageCredits);
  assert.equal(
    (row.reservationPayload as { providerCallPasses?: number }).providerCallPasses,
    CODE_EXECUTION_RESERVED_PASSES
  );
  assert.equal(await providerBucket("provider-cost-day"), expectedCost);
  assert.ok(expectedCost > getChatBudgetReservedCostMicroUsd(plain) * 3);
});

test("a turn without the tool reserves exactly what it did before", async () => {
  const { decision, budget } = routeBudget(2_000, false);
  assert.deepEqual(decision, { enabled: false, reason: "switch_off" });
  assert.equal(budget.providerCallPasses, undefined);
  const acquired = await acquireChatAccess(await access(), budget, {
    traceId: `trace-${randomUUID()}`,
  });
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(
    (row.reservationPayload as { providerCallPasses?: number }).providerCallPasses,
    undefined
  );
  assert.equal(Number(row.reservedCostMicroUsd), getChatBudgetReservedCostMicroUsd(budget));
});

test("a long-context code-execution turn reserves the runs in credits, and settling the worst case stays inside them", async () => {
  const { budget } = routeBudget(200_000, true);
  const { budget: plain } = routeBudget(200_000, false);
  assert.ok(budget.longContextSettlement, "the turn is priced at its own cost");
  assert.equal(budget.providerCallPasses, CODE_EXECUTION_RESERVED_PASSES);
  assert.ok(budget.usageCredits > plain.usageCredits);

  const acquired = await acquireChatAccess(await access(), budget, {
    traceId: `trace-${randomUUID()}`,
  });
  const row = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: acquired.usageReservation.reservationId },
  });
  assert.equal(row.reservedCredits, budget.usageCredits);

  // The worst case the runs can bill: every reserved pass's input and the whole
  // output cap. It settles at the reservation, not above it.
  await settleChatUsage(acquired.usageReservation, {
    inputTokens: budget.inputTokens,
    outputTokens: budget.maxOutputTokens,
    outcome: "completed",
  });
  const settled = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: row.id },
  });
  assert.equal(settled.status, "settled");
  assert.ok(settled.settledCredits <= row.reservedCredits);
  assert.ok(settled.settledCredits > plain.usageCredits);
});
