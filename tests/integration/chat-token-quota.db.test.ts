import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import {
    acquireChatAccess,
    ChatAccessError,
    preflightChatComparisonAccess,
    publicChatErrorDetails,
    releaseChatAccess,
    type ChatAccess,
    type ChatBudget,
} from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";

/**
 * Cumulative token quotas: counted for everyone, enforced only for guests.
 *
 * The production report (Trace b0076648-…): a Pro account with 2,744 credits
 * left was refused `CHAT_TOKEN_QUOTA_EXCEEDED` at 993,616 of the 1,000,000
 * `tokens-day` cap after about ten long-context turns. An account's allowance
 * is credits (docs/policy/credit-and-cost-limits.md), so the cap is gone from
 * both the comparison preflight and the per-model reservation, and the
 * buckets keep counting with no ceiling. A guest has no credit ledger and
 * keeps its quota, now refused with a reset and the shortfall attached.
 */

const resetTokenQuotaTestData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatLimitDecisionEvent",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditLot",
      "User"
    RESTART IDENTITY CASCADE
  `);

const originalEnv = { ...process.env };

const ENV_KEYS = [
    "CHAT_GUEST_TOKENS_PER_DAY",
    "CHAT_GUEST_TOKENS_PER_MONTH",
    "CHAT_USER_TOKENS_PER_DAY",
    "CHAT_USER_TOKENS_PER_MONTH",
    "CHAT_GUEST_PER_MINUTE",
    "CHAT_USER_PER_MINUTE",
    "CHAT_IP_PER_MINUTE",
] as const;

beforeEach(async () => {
    await resetTokenQuotaTestData();
    process.env.CHAT_GUEST_PER_MINUTE = "100";
    process.env.CHAT_USER_PER_MINUTE = "100";
    process.env.CHAT_IP_PER_MINUTE = "500";
    process.env.CHAT_GUEST_TOKENS_PER_DAY = "100000000";
    process.env.CHAT_GUEST_TOKENS_PER_MONTH = "100000000";
    delete process.env.CHAT_USER_TOKENS_PER_DAY;
    delete process.env.CHAT_USER_TOKENS_PER_MONTH;
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

after(async () => {
    await resetTokenQuotaTestData();
    await prisma.$disconnect();
});

/** inputTokens + reservedOutputTokens, the amount one request reserves. */
const RESERVED_TOKENS = 1_000;

const budgetFor = (modelId: string): ChatBudget => ({
    modelId,
    minimumPlan: "Guest",
    modelUsageClass: "standard",
    usageCredits: 1,
    inputTokens: 100,
    maxOutputTokens: 900,
    providerMaxOutputTokens: null,
    reservedOutputTokens: 900,
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    cachedInputPriceMultiplier: 1,
    cacheWriteUsdPerMillionTokens: null,
    promptCacheWriteReservedPremiumMicroUsd: 0,
    nativeSearchReservedCostMicroUsd: 0,
    nativeSearchCostPerQueryMicroUsd: 0,
    nativeSearchMaxQueries: 0,
    searchBackend: null,
    provider: "openai",
    pricingVersion: "test-fixture-pricing",
    costSource: "registry",
    longContextThresholdTokens: null,
});

const guestAccess = (guest: string, ip = "token-nat"): ChatAccess => ({
    kind: "guest",
    subjectKey: `guest:token-${guest}`,
    ipKey: `ip:token-${ip}`,
});

const createUserAccess = async (plan: "Pro" | "Max"): Promise<ChatAccess> => {
    const user = await prisma.user.create({
        data: { email: `token-quota-${randomUUID()}@example.test`, plan },
    });
    return {
        kind: "user",
        userId: user.id,
        plan,
        subjectKey: `user:token-${user.id}`,
        ipKey: "ip:token-account-nat",
        planLimits: { dailyMessageLimit: 10_000, monthlyMessageLimit: 100_000 },
    };
};

const tokenUsage = async (key: string, period: string) => {
    const buckets = await prisma.chatUsageBucket.findMany({
        where: { key, period },
        select: { count: true },
    });
    return buckets.reduce(
        (sum, bucket) => sum + usageBucketCount(bucket.count),
        0
    );
};

const setTokenUsage = (key: string, period: string, count: number) =>
    prisma.$executeRaw`
        UPDATE "ChatUsageBucket" SET "count" = ${count}
        WHERE "key" = ${key} AND "period" = ${period}
    `;

const expectChatAccessError = async (run: () => Promise<unknown>) => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof ChatAccessError, String(error));
        return error as ChatAccessError;
    }
    throw new Error("Expected the request to be refused.");
};

const send = (access: ChatAccess, modelId = "model-a") =>
    acquireChatAccess(access, budgetFor(modelId), { traceId: randomUUID() });

/* ------------------------------------------------------------------ */
/* 1. Accounts: counted, never capped                                  */
/* ------------------------------------------------------------------ */

test("an account past the old daily and monthly caps is still admitted, and still counted", async () => {
    const access = await createUserAccess("Pro");
    const warmup = await send(access, "warmup");
    await releaseChatAccess(warmup.leaseId);

    // The reported state, and past it: both retired ceilings already exceeded.
    await setTokenUsage(access.subjectKey, "tokens-day", 1_000_000);
    await setTokenUsage(access.subjectKey, "tokens-month", 20_000_000);

    const grant = await send(access);
    assert.equal(
        await tokenUsage(access.subjectKey, "tokens-day"),
        1_000_000 + RESERVED_TOKENS
    );
    assert.equal(
        await tokenUsage(access.subjectKey, "tokens-month"),
        20_000_000 + RESERVED_TOKENS
    );
    await releaseChatAccess(grant.leaseId);
});

test("a comparison preflight and its per-model reservations agree for an account", async () => {
    const access = await createUserAccess("Max");
    const warmup = await send(access, "warmup");
    await releaseChatAccess(warmup.leaseId);
    await setTokenUsage(access.subjectKey, "tokens-day", 5_000_000);

    const budgets = ["model-a", "model-b", "model-c"].map(budgetFor);
    const preflight = await preflightChatComparisonAccess(access, budgets, {
        traceId: randomUUID(),
        comparisonId: "1754000009001",
    });
    const grants = [];
    for (const budget of budgets) {
        grants.push(
            await acquireChatAccess(access, budget, {
                traceId: randomUUID(),
                admissionToken: preflight.admission.token,
            })
        );
    }
    assert.equal(grants.length, 3);
    assert.equal(
        await tokenUsage(access.subjectKey, "tokens-day"),
        5_000_000 + 3 * RESERVED_TOKENS
    );
    for (const grant of grants) await releaseChatAccess(grant.leaseId);
});

test("a leftover CHAT_USER_TOKENS_PER_* setting has no effect", async () => {
    process.env.CHAT_USER_TOKENS_PER_DAY = "1";
    process.env.CHAT_USER_TOKENS_PER_MONTH = "1";
    const access = await createUserAccess("Pro");

    const first = await send(access);
    const second = await send(access, "model-b");
    assert.equal(
        await tokenUsage(access.subjectKey, "tokens-day"),
        2 * RESERVED_TOKENS
    );
    await releaseChatAccess(first.leaseId);
    await releaseChatAccess(second.leaseId);
});

/* ------------------------------------------------------------------ */
/* 2. Guests: still enforced, and the refusal says what to expect      */
/* ------------------------------------------------------------------ */

test("a guest over its daily token quota is refused with the shortfall and a future reset", async () => {
    process.env.CHAT_GUEST_TOKENS_PER_DAY = "1500";
    const alice = guestAccess("alice");
    const first = await send(alice);
    await releaseChatAccess(first.leaseId);

    const before = new Date();
    const error = await expectChatAccessError(() => send(alice, "model-b"));
    assert.equal(error.status, 429);
    assert.equal(error.code, "CHAT_TOKEN_QUOTA_EXCEEDED");
    assert.equal(error.details?.scope, "day");
    assert.equal(error.details?.requiredTokens, RESERVED_TOKENS);
    assert.equal(error.details?.availableTokens, 500);
    assert.equal(error.details?.timeZone, "UTC");
    const resetAt = new Date(String(error.details?.resetAt));
    assert.ok(resetAt.getTime() > before.getTime());
    assert.ok((error.retryAfter ?? 0) >= 1);

    const publicDetails = publicChatErrorDetails(error.details) ?? {};
    assert.equal(publicDetails.availableTokens, 500);
    assert.equal(publicDetails.requiredTokens, RESERVED_TOKENS);
    assert.ok(typeof publicDetails.resetAt === "string");

    // The refused reservation rolled back: nothing was counted for it.
    assert.equal(await tokenUsage(alice.subjectKey, "tokens-day"), RESERVED_TOKENS);
});

test("a guest over its monthly token quota is refused in the month scope", async () => {
    process.env.CHAT_GUEST_TOKENS_PER_MONTH = "1200";
    const bob = guestAccess("bob");
    const first = await send(bob);
    await releaseChatAccess(first.leaseId);

    const error = await expectChatAccessError(() => send(bob, "model-b"));
    assert.equal(error.code, "CHAT_TOKEN_QUOTA_EXCEEDED");
    assert.equal(error.details?.scope, "month");
    assert.equal(error.details?.availableTokens, 200);
    assert.equal(error.details?.timeZone, "UTC");
});

test("the guest IP aggregate refuses with the same details, in the IP's own numbers", async () => {
    process.env.CHAT_GUEST_TOKENS_PER_DAY = "1500";
    const carol = guestAccess("carol");
    const first = await send(carol);
    await releaseChatAccess(first.leaseId);
    // Three guests' worth is 4,500; leave room for less than one request.
    await setTokenUsage(carol.ipKey, "ip-tokens-day", 4_000);

    const dave = guestAccess("dave");
    const error = await expectChatAccessError(() => send(dave));
    assert.equal(error.code, "CHAT_IP_TOKEN_QUOTA_EXCEEDED");
    assert.equal(error.details?.scope, "day");
    assert.equal(error.details?.requiredTokens, RESERVED_TOKENS);
    assert.equal(error.details?.availableTokens, 500);
    assert.ok(typeof error.details?.resetAt === "string");
    // Dave's own quota was untouched by the refusal.
    assert.equal(await tokenUsage(dave.subjectKey, "tokens-day"), 0);
});
