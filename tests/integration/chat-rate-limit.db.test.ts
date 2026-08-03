import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import {
    acquireChatAccess,
    ChatAccessError,
    preflightChatComparisonAccess,
    publicChatErrorDetails,
    releaseChatAccess,
    rollbackChatAdmission,
    type ChatAccess,
    type ChatBudget,
} from "@/lib/chatSecurity";
import { issueAdmissionToken } from "@/lib/chatAdmissionCore";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";

/**
 * Per-minute request capacity for a multi-model comparison.
 *
 * The production report (Trace c7216139-…): a guest sent a three-model
 * comparison having already spent three of their five per-minute requests. The
 * aggregate preflight allowed it -- for guests it did not look at the minute
 * bucket at all -- two panels answered, and the third came back
 *
 *     429 CHAT_RATE_LIMITED
 *     "Requests are being sent too quickly. Please try again in 6 seconds."
 *
 * from `acquireChatAccess`, phase `chat_reservation`. One user action, two
 * answers, one refusal, and the two that ran were charged.
 *
 * The first test below reproduces exactly that sequence against the old
 * behaviour's boundary; everything after it pins the fix: the whole
 * comparison's rate capacity is reserved atomically in the preflight
 * transaction, each model request consumes the unit its slot already holds,
 * and an unused reservation is handed back rather than held to the end of the
 * minute.
 */

const resetRateTestData = () =>
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

const RATE_ENV_KEYS = [
    "CHAT_GUEST_PER_MINUTE",
    "CHAT_USER_PER_MINUTE",
    "CHAT_IP_PER_MINUTE",
    "CHAT_GUEST_PER_DAY",
    "CHAT_GUEST_PER_MONTH",
    "CHAT_GUEST_CONCURRENT",
    "CHAT_USER_CONCURRENT",
    "CHAT_IP_CONCURRENT",
    "CHAT_ADMISSION_TTL_SECONDS",
    "CHAT_LEASE_TTL_SECONDS",
    "CHAT_GUEST_TOKENS_PER_DAY",
    "CHAT_GUEST_TOKENS_PER_MONTH",
] as const;

beforeEach(async () => {
    await resetRateTestData();
    // Deliberately the production defaults for the two limits under test: the
    // fix must work at the shipped numbers, not at raised ones.
    process.env.CHAT_GUEST_PER_MINUTE = "5";
    process.env.CHAT_USER_PER_MINUTE = "20";
    process.env.CHAT_IP_PER_MINUTE = "40";
    process.env.CHAT_GUEST_PER_DAY = "500";
    process.env.CHAT_GUEST_PER_MONTH = "5000";
    process.env.CHAT_GUEST_CONCURRENT = "12";
    process.env.CHAT_USER_CONCURRENT = "12";
    process.env.CHAT_IP_CONCURRENT = "48";
    process.env.CHAT_ADMISSION_TTL_SECONDS = "60";
    process.env.CHAT_LEASE_TTL_SECONDS = "180";
    process.env.CHAT_GUEST_TOKENS_PER_DAY = "100000000";
    process.env.CHAT_GUEST_TOKENS_PER_MONTH = "100000000";
    await waitForRoomInThisMinute();
});

afterEach(() => {
    for (const key of RATE_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

after(async () => {
    await resetRateTestData();
    await prisma.$disconnect();
});

/**
 * Keeps a test inside one minute bucket.
 *
 * Every assertion here is about a counter that resets on the minute, so a test
 * that starts at :59 would seed one window and assert on the next. Waiting out
 * the last few seconds is cheaper and far more honest than freezing the clock:
 * the code under test reads the real one, and so does Postgres.
 */
const waitForRoomInThisMinute = async (requiredSeconds = 8) => {
    const now = new Date();
    const remaining =
        60 - (now.getUTCSeconds() + now.getUTCMilliseconds() / 1000);
    if (remaining >= requiredSeconds) return;
    await new Promise((resolve) =>
        setTimeout(resolve, Math.ceil(remaining * 1000) + 50)
    );
};

/** Two distinct signed guest cookies reaching the app from one public IP. */
const guestAccess = (guest: string, ip = "shared-nat"): ChatAccess => ({
    kind: "guest",
    subjectKey: `guest:rate-${guest}`,
    ipKey: `ip:rate-${ip}`,
});

const budgetFor = (modelId: string, credits = 1): ChatBudget => ({
    modelId,
    minimumPlan: "Guest",
    modelUsageClass: "standard",
    usageCredits: credits,
    inputTokens: 100,
    maxOutputTokens: 900,
    reservedOutputTokens: 900,
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    cachedInputPriceMultiplier: 1,
    provider: "openai",
    pricingVersion: "test-fixture-pricing",
    costSource: "registry",
    longContextThresholdTokens: null,
});

const THREE_MODELS = ["model-a", "model-b", "model-c"];
const comparisonBudgets = () => THREE_MODELS.map((modelId) => budgetFor(modelId));

/**
 * How many requests this key has spent this minute.
 *
 * Summed across rows rather than read from one: a run that straddles a minute
 * boundary despite the guard above leaves two, and silently reading the first
 * would turn that into a wrong number rather than a visible one.
 */
const minuteUsage = async (key: string) => {
    const buckets = await prisma.chatUsageBucket.findMany({
        where: { key, period: "minute" },
        select: { count: true },
    });
    return buckets.reduce(
        (sum, bucket) => sum + usageBucketCount(bucket.count),
        0
    );
};

const expectChatAccessError = async (run: () => Promise<unknown>) => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof ChatAccessError, String(error));
        return error as ChatAccessError;
    }
    throw new Error("Expected the request to be refused.");
};

/** Spends `count` single-model requests the way an ordinary send does. */
const spendRequests = async (access: ChatAccess, count: number) => {
    for (let index = 0; index < count; index += 1) {
        const grant = await acquireChatAccess(
            access,
            budgetFor(`warmup-${index}`),
            { traceId: randomUUID() }
        );
        await releaseChatAccess(grant.leaseId);
    }
};

const runComparison = async (
    access: ChatAccess,
    budgets = comparisonBudgets()
) => {
    const preflight = await preflightChatComparisonAccess(access, budgets, {
        traceId: randomUUID(),
        comparisonId: "1754000000000",
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
    return { preflight, grants };
};

const releaseAll = async (grants: Array<{ leaseId: string }>) => {
    for (const grant of grants) await releaseChatAccess(grant.leaseId);
};

const createUser = (plan: "Free" | "Pro" | "Max" = "Pro") =>
    prisma.user.create({
        data: { email: `rate-limit-${randomUUID()}@example.test`, plan },
    });

const userAccess = (user: { id: string; plan: string }): ChatAccess => ({
    kind: "user",
    userId: user.id,
    plan: user.plan === "Max" ? "Max" : user.plan === "Pro" ? "Pro" : "Free",
    subjectKey: `user:rate-${user.id}`,
    ipKey: "ip:rate-shared-nat",
    planLimits: { dailyMessageLimit: 10_000, monthlyMessageLimit: 100_000 },
});

/* ------------------------------------------------------------------ */
/* 1. The reported failure                                             */
/* ------------------------------------------------------------------ */

test("a guest three requests into their minute is refused for the whole comparison, not for its last panel", async () => {
    const alice = guestAccess("alice");
    await spendRequests(alice, 3);
    assert.equal(await minuteUsage(alice.subjectKey), 3);

    // The reported sequence: 3 of 5 spent, three more models requested. The
    // old preflight admitted this -- guests were not rate-checked here at all
    // -- and the third POST /api/chat was the one that failed.
    const error = await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000001",
        })
    );

    assert.equal(error.status, 429);
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(error.details?.scope, "guest_rate_minute");
    assert.equal(error.details?.limitLayer, "rate_limit");
    assert.equal(error.details?.requestedRequests, 3);
    assert.equal(error.details?.availableRequests, 2);

    // The refusal is total: no slot was taken, nothing was charged beyond the
    // three requests that genuinely ran, and no credit reservation exists that
    // a provider call could have been made against.
    assert.equal(await minuteUsage(alice.subjectKey), 3);
    assert.equal(
        await prisma.chatRequestLease.count({
            where: { subjectKey: alice.subjectKey },
        }),
        0
    );
    assert.equal(
        await prisma.chatCreditReservation.count({
            where: { subjectKey: alice.subjectKey, modelId: { in: THREE_MODELS } },
        }),
        0
    );
});

test("the refusal is recorded as a rate limit, not as a credit entitlement", async () => {
    const alice = guestAccess("alice");
    await spendRequests(alice, 3);
    const traceId = randomUUID();

    await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId,
            comparisonId: "1754000000002",
        })
    );

    const decision = await prisma.chatLimitDecisionEvent.findFirst({
        where: { traceId },
    });
    assert.ok(decision);
    assert.equal(decision.phase, "comparison_preflight");
    assert.equal(decision.errorCode, "CHAT_RATE_LIMITED");
    // Recording this as `entitlement` is what made a ten-second wait
    // indistinguishable from an exhausted balance in the decision log.
    assert.equal(decision.limitLayer, "rate_limit");
    assert.equal(decision.limitScope, "guest_rate_minute");
    assert.deepEqual(decision.modelIds, THREE_MODELS);
    assert.equal(decision.subjectKey, alice.subjectKey);
});

/* ------------------------------------------------------------------ */
/* 2. The boundary either side                                         */
/* ------------------------------------------------------------------ */

test("a guest two requests into their minute runs all three panels, ending at exactly the limit", async () => {
    const alice = guestAccess("alice");
    await spendRequests(alice, 2);

    const { grants } = await runComparison(alice);

    assert.equal(grants.length, 3);
    // 2 + 3 = 5, the limit, counted once each -- not twice, which is what
    // charging both the preflight and the model requests would produce.
    assert.equal(await minuteUsage(alice.subjectKey), 5);
    assert.equal(await minuteUsage(alice.ipKey), 5);

    // And the fifth unit really is the last one: the next single request is
    // refused, so the reservation did not quietly raise the limit.
    const error = await expectChatAccessError(() =>
        acquireChatAccess(alice, budgetFor("model-d"), { traceId: randomUUID() })
    );
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(error.details?.scope, "guest_rate_minute");

    await releaseAll(grants);
});

test("a signed-in account has the same boundary in its own scope", async () => {
    process.env.CHAT_USER_PER_MINUTE = "5";
    const user = await createUser("Pro");
    const access = userAccess(user);
    await spendRequests(access, 3);

    const refused = await expectChatAccessError(() =>
        preflightChatComparisonAccess(access, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000003",
        })
    );
    assert.equal(refused.status, 429);
    assert.equal(refused.code, "CHAT_RATE_LIMITED");
    assert.equal(refused.details?.scope, "user_rate_minute");
    assert.equal(refused.details?.limitLayer, "rate_limit");
    assert.equal(await minuteUsage(access.subjectKey), 3);

    // One unit given back is the whole difference between refused and allowed.
    await prisma.$executeRaw`
        UPDATE "ChatUsageBucket" SET "count" = 2
        WHERE "key" = ${access.subjectKey} AND "period" = 'minute'
    `;
    const { grants } = await runComparison(access);
    assert.equal(grants.length, 3);
    assert.equal(await minuteUsage(access.subjectKey), 5);

    await releaseAll(grants);
});

/* ------------------------------------------------------------------ */
/* 3. The aggregate IP ceiling                                         */
/* ------------------------------------------------------------------ */

test("a comparison that does not fit under the IP ceiling is refused whole, in the IP's own scope", async () => {
    process.env.CHAT_IP_PER_MINUTE = "4";
    const alice = guestAccess("alice");
    const neighbour = guestAccess("bob");
    // Alice's own allowance is untouched; the network's is nearly spent.
    await spendRequests(neighbour, 2);

    const error = await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000004",
        })
    );

    assert.equal(error.status, 429);
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    // A different scope and a different layer from the subject rejection: the
    // aggregate anonymous ceiling is not this guest's own allowance, and an
    // operator reading the decision must be able to tell which one refused.
    assert.equal(error.details?.scope, "ip_rate_minute");
    assert.equal(error.details?.limitLayer, "operational_admission");
    assert.notEqual(error.details?.scope, "guest_rate_minute");

    // The subject scope was charged first and then unwound with the
    // transaction: a rejection in the second scope must not leave the first
    // one debited.
    assert.equal(await minuteUsage(alice.subjectKey), 0);
    assert.equal(await minuteUsage(alice.ipKey), 2);
    assert.equal(await prisma.chatRequestLease.count(), 0);
});

test("the IP ceiling still applies to signed-in accounts", async () => {
    process.env.CHAT_IP_PER_MINUTE = "2";
    const user = await createUser("Pro");
    const access = userAccess(user);

    const error = await expectChatAccessError(() =>
        preflightChatComparisonAccess(access, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000005",
        })
    );
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(error.details?.scope, "ip_rate_minute");
    assert.equal(await minuteUsage(access.subjectKey), 0);
});

/* ------------------------------------------------------------------ */
/* 4. Nothing left behind, nothing counted twice                       */
/* ------------------------------------------------------------------ */

test("a preflight refused after charging one scope leaves no lease and no rate reservation", async () => {
    process.env.CHAT_IP_PER_MINUTE = "2";
    const alice = guestAccess("alice");

    await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000006",
        })
    );

    assert.equal(await minuteUsage(alice.subjectKey), 0);
    assert.equal(await minuteUsage(alice.ipKey), 0);
    assert.equal(await prisma.chatRequestLease.count(), 0);
    assert.equal(await prisma.chatCreditReservation.count(), 0);
    // The very next attempt, once the ceiling allows it, still gets its full
    // allowance -- proof the failed one consumed nothing.
    process.env.CHAT_IP_PER_MINUTE = "40";
    const { grants } = await runComparison(alice);
    assert.equal(grants.length, 3);
    assert.equal(await minuteUsage(alice.subjectKey), 3);
    await releaseAll(grants);
});

test("an abandoned comparison hands back the rate capacity of the panels that never ran", async () => {
    const alice = guestAccess("alice");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000007" }
    );
    assert.equal(await minuteUsage(alice.subjectKey), 3);

    const started = await acquireChatAccess(alice, budgetFor("model-a"), {
        traceId: randomUUID(),
        admissionToken: preflight.admission.token,
    });
    await rollbackChatAdmission(preflight.admission.admissionId);

    // One panel ran and keeps its unit; the two that never left the browser
    // give theirs straight back instead of holding them to the end of the
    // minute.
    assert.equal(await minuteUsage(alice.subjectKey), 1);
    assert.equal(await minuteUsage(alice.ipKey), 1);
    // Idempotent: a second rollback finds nothing to release and refunds
    // nothing, so the started panel is not credited by accident.
    await rollbackChatAdmission(preflight.admission.admissionId);
    assert.equal(await minuteUsage(alice.subjectKey), 1);

    await releaseChatAccess(started.leaseId);
});

test("an admitted panel is charged once, not once per layer", async () => {
    const alice = guestAccess("alice");
    const { grants, preflight } = await runComparison(alice);

    assert.equal(await minuteUsage(alice.subjectKey), 3);
    assert.equal(await minuteUsage(alice.ipKey), 3);
    // Every panel really did claim its pre-reserved slot rather than opening a
    // new one, which is what makes the single charge correct.
    assert.equal(
        await prisma.chatRequestLease.count({
            where: { admissionId: preflight.admission.admissionId },
        }),
        3
    );
    assert.equal(
        await prisma.chatRequestLease.count({ where: { claimedAt: null } }),
        0
    );

    await releaseAll(grants);
});

/* ------------------------------------------------------------------ */
/* 5. Admission tokens buy slots, never rate                           */
/* ------------------------------------------------------------------ */

test("a replayed admission token cannot spend rate capacity a second time", async () => {
    process.env.CHAT_GUEST_PER_MINUTE = "3";
    // High enough that concurrency cannot be what refuses the replay: the
    // assertion below has to be about the rate limit and nothing else.
    process.env.CHAT_GUEST_CONCURRENT = "12";
    const alice = guestAccess("alice");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000008" }
    );
    const first = await acquireChatAccess(alice, budgetFor("model-a"), {
        traceId: randomUUID(),
        admissionToken: preflight.admission.token,
    });

    // Same token, same model, second time. Its slot is already claimed, so the
    // request pays for itself -- and the minute is spent.
    const error = await expectChatAccessError(() =>
        acquireChatAccess(alice, budgetFor("model-a"), {
            traceId: randomUUID(),
            admissionToken: preflight.admission.token,
        })
    );
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(error.details?.scope, "guest_rate_minute");
    assert.equal(await minuteUsage(alice.subjectKey), 3);

    await releaseChatAccess(first.leaseId);
    await rollbackChatAdmission(preflight.admission.admissionId);
});

test("a forged admission token cannot skip the rate charge", async () => {
    process.env.CHAT_GUEST_PER_MINUTE = "3";
    process.env.CHAT_GUEST_CONCURRENT = "12";
    const alice = guestAccess("alice");
    await spendRequests(alice, 3);

    const forged = issueAdmissionToken(
        {
            version: 1,
            admissionId: randomUUID(),
            subjectKey: alice.subjectKey,
            comparisonId: "1754000000009",
            slots: THREE_MODELS.map((modelId) => ({
                leaseId: randomUUID(),
                modelId,
            })),
            expiresAtMs: Date.now() + 60_000,
        },
        "not-the-application-secret"
    );

    const error = await expectChatAccessError(() =>
        acquireChatAccess(alice, budgetFor("model-a"), {
            traceId: randomUUID(),
            admissionToken: forged,
        })
    );
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(await minuteUsage(alice.subjectKey), 3);
});

test("another guest's admission token cannot spend this guest's reservation", async () => {
    process.env.CHAT_GUEST_PER_MINUTE = "3";
    process.env.CHAT_GUEST_CONCURRENT = "12";
    const alice = guestAccess("alice");
    const mallory = guestAccess("mallory");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000010" }
    );
    await spendRequests(mallory, 3);

    const error = await expectChatAccessError(() =>
        acquireChatAccess(mallory, budgetFor("model-a"), {
            traceId: randomUUID(),
            admissionToken: preflight.admission.token,
        })
    );
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    // Alice's reservation is untouched by Mallory's attempt.
    assert.equal(await minuteUsage(alice.subjectKey), 3);
    assert.equal(await minuteUsage(mallory.subjectKey), 3);

    await rollbackChatAdmission(preflight.admission.admissionId);
});

/* ------------------------------------------------------------------ */
/* 6. Races                                                            */
/* ------------------------------------------------------------------ */

test("a request from another tab racing the preflight cannot produce a partial comparison", async () => {
    const alice = guestAccess("alice");
    // Two units spent leaves three: exactly one of the two racers can win.
    await spendRequests(alice, 2);

    const [comparison, otherTab] = await Promise.allSettled([
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000011",
        }),
        acquireChatAccess(alice, budgetFor("other-tab"), {
            traceId: randomUUID(),
        }),
    ]);

    if (comparison.status === "fulfilled") {
        // Admitted: every panel must now be able to run, because its unit is
        // already held. This is the assertion the old read-only check failed.
        const grants = [];
        for (const budget of comparisonBudgets()) {
            grants.push(
                await acquireChatAccess(alice, budget, {
                    traceId: randomUUID(),
                    admissionToken: comparison.value.admission.token,
                })
            );
        }
        assert.equal(grants.length, 3);
        assert.equal(otherTab.status, "rejected");
        await releaseAll(grants);
    } else {
        // Refused: the other tab won the last units, and this comparison ran
        // nothing at all rather than two thirds of itself. It must be refused
        // by the limit, not by a deadlock -- the two paths take the lease
        // scope locks and then the usage rows in one fixed order precisely so
        // that a contended run produces a verdict rather than a 40P01 neither
        // caller can act on.
        assert.ok(
            comparison.reason instanceof ChatAccessError,
            `expected a limit verdict, got ${String(comparison.reason)}`
        );
        assert.equal(
            (comparison.reason as ChatAccessError).code,
            "CHAT_RATE_LIMITED"
        );
        assert.equal(otherTab.status, "fulfilled");
        assert.equal(await prisma.chatRequestLease.count({
            where: { claimedAt: null },
        }), 0);
        if (otherTab.status === "fulfilled") {
            await releaseChatAccess(otherTab.value.leaseId);
        }
    }
    // Either way the counter tells the truth: five spent, never six.
    assert.equal(await minuteUsage(alice.subjectKey), 5);
});

test("concurrent comparisons from one subject cannot both be admitted past the limit", async () => {
    const alice = guestAccess("alice");
    // Room for one three-model comparison and not two.
    await spendRequests(alice, 1);

    const outcomes = await Promise.allSettled(
        [0, 1, 2].map((index) =>
            preflightChatComparisonAccess(alice, comparisonBudgets(), {
                traceId: randomUUID(),
                comparisonId: `17540000000${20 + index}`,
            })
        )
    );

    const admitted = outcomes.filter(
        (outcome) => outcome.status === "fulfilled"
    );
    assert.equal(admitted.length, 1);
    for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
            assert.ok(outcome.reason instanceof ChatAccessError);
            assert.equal(
                (outcome.reason as ChatAccessError).code,
                "CHAT_RATE_LIMITED"
            );
        }
    }
    assert.equal(await minuteUsage(alice.subjectKey), 4);
    // Only the admitted comparison's slots exist; the refused ones unwound.
    assert.equal(await prisma.chatRequestLease.count(), 3);

    for (const outcome of admitted) {
        if (outcome.status === "fulfilled") {
            await rollbackChatAdmission(outcome.value.admission.admissionId);
        }
    }
});

test("contended preflights and single requests settle on a verdict, never a deadlock", async () => {
    process.env.CHAT_GUEST_PER_MINUTE = "6";
    process.env.CHAT_IP_PER_MINUTE = "9";
    const alice = guestAccess("alice");
    // A second guest on the same public address, so the aggregate IP scope is
    // contended too and not just the subject's own.
    const bob = guestAccess("bob");

    // Comparisons and single sends, from two subjects, all at once. Both paths
    // write the same lease and usage rows; if they took the lease-scope locks
    // and those rows in different orders, Postgres would break the tie by
    // killing one transaction with a deadlock error -- which is not a verdict
    // and which no caller can do anything about.
    const outcomes = await Promise.allSettled([
        ...[alice, bob, alice, bob].map((access) =>
            preflightChatComparisonAccess(access, comparisonBudgets(), {
                traceId: randomUUID(),
                comparisonId: "1754000000040",
            })
        ),
        ...[alice, bob, alice, bob].map((access, index) =>
            acquireChatAccess(access, budgetFor(`single-${index}`), {
                traceId: randomUUID(),
            })
        ),
    ]);

    for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
            assert.ok(
                outcome.reason instanceof ChatAccessError,
                `every refusal must be a limit verdict, got ${String(outcome.reason)}`
            );
        }
    }

    const admittedComparisons = outcomes
        .slice(0, 4)
        .filter((outcome) => outcome.status === "fulfilled");
    const admittedSingles = outcomes
        .slice(4)
        .filter((outcome) => outcome.status === "fulfilled");

    // Every admitted unit is counted exactly once, and no scope went over.
    const spentByIp =
        admittedComparisons.length * 3 + admittedSingles.length;
    assert.equal(await minuteUsage(alice.ipKey), spentByIp);
    assert.ok(spentByIp <= 9, `IP scope overspent: ${spentByIp}`);
    for (const subject of [alice, bob]) {
        assert.ok(
            (await minuteUsage(subject.subjectKey)) <= 6,
            "a subject scope was allowed past its own limit"
        );
    }

    // The first four preflights are comparisons and the rest singles, but the
    // shared return type is a union -- narrow on the discriminating field so
    // the compiler agrees with what the slices already guarantee.
    for (const outcome of admittedComparisons) {
        if (outcome.status === "fulfilled" && "admission" in outcome.value) {
            await rollbackChatAdmission(outcome.value.admission.admissionId);
        }
    }
    for (const outcome of admittedSingles) {
        if (outcome.status === "fulfilled" && "leaseId" in outcome.value) {
            await releaseChatAccess(outcome.value.leaseId);
        }
    }
});

/* ------------------------------------------------------------------ */
/* 7. What the client is told                                          */
/* ------------------------------------------------------------------ */

test("a rate rejection carries a usable wait, a future reset, and nothing internal", async () => {
    const alice = guestAccess("alice");
    await spendRequests(alice, 4);

    const before = new Date();
    const error = await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000030",
        })
    );

    assert.equal(error.status, 429);
    // The header a proxy reads and the field the UI counts down from are the
    // same number, so the two never disagree on screen.
    assert.ok((error.retryAfter ?? 0) >= 1);
    assert.equal(error.details?.retryAfterSeconds, error.retryAfter);
    const resetAt = new Date(String(error.details?.resetAt));
    assert.ok(resetAt.getTime() > before.getTime());
    // The wait must actually reach the reset, not stop short of it.
    assert.ok(
        resetAt.getTime() - before.getTime() <= (error.retryAfter ?? 0) * 1000
    );

    const publicDetails = publicChatErrorDetails(error.details) ?? {};
    assert.equal(publicDetails.retryAfterSeconds, error.retryAfter);
    assert.equal(publicDetails.scope, "guest_rate_minute");
    assert.equal(publicDetails.limitLayer, "rate_limit");
    for (const key of Object.keys(publicDetails)) {
        assert.doesNotMatch(key, /^internal/);
    }
    // Not a credit message: a guest with a full balance must not be told to buy
    // anything for a wait of a few seconds.
    assert.doesNotMatch(error.message, /credit|plan|upgrade|budget/i);
});

/* ------------------------------------------------------------------ */
/* 8. The single-model path is unchanged                               */
/* ------------------------------------------------------------------ */

test("a single-model request still charges and still refuses on its own", async () => {
    const alice = guestAccess("alice");
    await spendRequests(alice, 5);
    assert.equal(await minuteUsage(alice.subjectKey), 5);

    const error = await expectChatAccessError(() =>
        acquireChatAccess(alice, budgetFor("model-a"), { traceId: randomUUID() })
    );
    assert.equal(error.status, 429);
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(error.details?.scope, "guest_rate_minute");
    assert.equal(error.details?.limitLayer, "rate_limit");
    assert.ok((error.retryAfter ?? 0) >= 1);
    assert.equal(error.details?.retryAfterSeconds, error.retryAfter);
    // Still refused before any provider spend is reserved.
    assert.equal(
        await prisma.chatCreditReservation.count({
            where: { subjectKey: alice.subjectKey, modelId: "model-a" },
        }),
        0
    );
});

test("the single-model IP ceiling still refuses a guest whose own allowance is untouched", async () => {
    process.env.CHAT_IP_PER_MINUTE = "3";
    const busy = guestAccess("busy");
    const newcomer = guestAccess("newcomer");
    await spendRequests(busy, 3);

    const error = await expectChatAccessError(() =>
        acquireChatAccess(newcomer, budgetFor("model-a"), {
            traceId: randomUUID(),
        })
    );
    assert.equal(error.code, "CHAT_RATE_LIMITED");
    assert.equal(error.details?.scope, "ip_rate_minute");
    assert.equal(error.details?.limitLayer, "operational_admission");
    assert.equal(await minuteUsage(newcomer.subjectKey), 0);
});
