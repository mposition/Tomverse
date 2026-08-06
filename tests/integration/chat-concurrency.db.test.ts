import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import {
    acquireChatAccess,
    ChatAccessError,
    heartbeatChatAccess,
    preflightChatComparisonAccess,
    reconcileExpiredChatRequestLeases,
    releaseChatAccess,
    rollbackChatAdmission,
    settleChatUsage,
    type ChatAccess,
    type ChatBudget,
} from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";

/**
 * Guest concurrency scope, multi-model admission and lease lifecycle.
 *
 * The two production reports these pin down:
 *
 *   * a guest's own concurrency was counted per IP, so a three-model
 *     comparison from one device exhausted the allowance of every other guest
 *     behind the same NAT;
 *   * a comparison could be admitted in part, because each panel raced for its
 *     own slot on arrival.
 */

const resetLeaseTestData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatLimitDecisionEvent",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);

const originalEnv = { ...process.env };

beforeEach(async () => {
    await resetLeaseTestData();
    process.env.CHAT_GUEST_CONCURRENT = "3";
    process.env.CHAT_IP_CONCURRENT = "24";
    process.env.CHAT_LEASE_TTL_SECONDS = "180";
    process.env.CHAT_ADMISSION_TTL_SECONDS = "60";
    process.env.CHAT_GUEST_PER_MINUTE = "100";
    process.env.CHAT_GUEST_PER_DAY = "200";
    process.env.CHAT_GUEST_PER_MONTH = "2000";
    process.env.CHAT_GUEST_TOKENS_PER_DAY = "100000000";
    process.env.CHAT_GUEST_TOKENS_PER_MONTH = "100000000";
});

afterEach(() => {
    for (const key of [
        "CHAT_GUEST_CONCURRENT",
        "CHAT_IP_CONCURRENT",
        "CHAT_LEASE_TTL_SECONDS",
        "CHAT_ADMISSION_TTL_SECONDS",
        "CHAT_GUEST_PER_MINUTE",
        "CHAT_GUEST_PER_DAY",
        "CHAT_GUEST_PER_MONTH",
        "CHAT_GUEST_TOKENS_PER_DAY",
        "CHAT_GUEST_TOKENS_PER_MONTH",
    ]) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

after(async () => {
    await resetLeaseTestData();
    await prisma.$disconnect();
});

/** Two distinct signed guest cookies reaching the app from one public IP. */
const guestAccess = (guest: string, ip = "shared-nat"): ChatAccess => ({
    kind: "guest",
    subjectKey: `guest:concurrency-${guest}`,
    ipKey: `ip:concurrency-${ip}`,
});

const guestBudget = (modelId: string, credits = 1): ChatBudget => ({
    modelId,
    minimumPlan: "Guest",
    modelUsageClass: "standard",
    usageCredits: credits,
    inputTokens: 100,
    maxOutputTokens: 900,
    providerMaxOutputTokens: null,
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

const comparisonBudgets = () => THREE_MODELS.map((modelId) => guestBudget(modelId));

const leaseCountFor = async (key: string, column: "subjectKey" | "ipKey") =>
    column === "ipKey"
        ? prisma.chatRequestLease.count({ where: { ipKey: key } })
        : prisma.chatRequestLease.count({ where: { subjectKey: key } });

const expectChatAccessError = async (run: () => Promise<unknown>) => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof ChatAccessError, String(error));
        return error as ChatAccessError;
    }
    throw new Error("Expected the request to be refused.");
};

/** Runs a whole comparison the way the routes do: preflight, then each model. */
const runComparison = async (access: ChatAccess, comparisonId = "1754000000000") => {
    const preflight = await preflightChatComparisonAccess(
        access,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId }
    );
    const grants = [];
    for (const modelId of THREE_MODELS) {
        grants.push(
            await acquireChatAccess(access, guestBudget(modelId), {
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

/* ------------------------------------------------------------------ */
/* 1. Guest concurrency is scoped to the guest, not to the IP          */
/* ------------------------------------------------------------------ */

test("two guest sessions behind one IP each run a full three-model comparison", async () => {
    const alice = guestAccess("alice");
    const bob = guestAccess("bob");

    const first = await runComparison(alice);
    // Alice is now at her full allowance of three. Under the old IP-scoped
    // lease this is exactly the state that refused Bob's very first request.
    const second = await runComparison(bob);

    assert.equal(first.grants.length, 3);
    assert.equal(second.grants.length, 3);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 3);
    assert.equal(await leaseCountFor(bob.subjectKey, "subjectKey"), 3);
    // Both are counted together only in the far higher aggregate scope.
    assert.equal(await leaseCountFor(alice.ipKey, "ipKey"), 6);

    await releaseAll([...first.grants, ...second.grants]);
});

test("one guest exceeding their own limit is refused, and told so as their own", async () => {
    const alice = guestAccess("alice");
    const { grants } = await runComparison(alice);

    const error = await expectChatAccessError(() =>
        acquireChatAccess(alice, guestBudget("model-d"), { traceId: randomUUID() })
    );
    assert.equal(error.status, 429);
    assert.equal(error.code, "CHAT_CONCURRENCY_EXCEEDED");
    assert.equal(error.details?.limitLayer, "concurrency");
    assert.equal(error.details?.scope, "guest_concurrency");
    assert.ok((error.retryAfter ?? 0) > 0);
    // Not an entitlement problem: the copy must not talk about credits.
    assert.doesNotMatch(error.message, /credit|plan|budget/i);

    await releaseAll(grants);
});

test("a rejection is recorded as a concurrency layer, never as an entitlement", async () => {
    const alice = guestAccess("alice");
    const { grants } = await runComparison(alice);
    const traceId = randomUUID();

    await expectChatAccessError(() =>
        acquireChatAccess(alice, guestBudget("model-d"), { traceId })
    );

    const decision = await prisma.chatLimitDecisionEvent.findFirst({
        where: { traceId },
    });
    assert.ok(decision);
    assert.equal(decision.errorCode, "CHAT_CONCURRENCY_EXCEEDED");
    assert.equal(decision.limitLayer, "concurrency");
    assert.equal(decision.limitScope, "guest_concurrency");
    // The subject is the hashed usage key the caller passed in; no raw IP.
    assert.equal(decision.subjectKey, alice.subjectKey);

    await releaseAll(grants);
});

test("the aggregate IP ceiling is a separate limit with a separate code", async () => {
    process.env.CHAT_IP_CONCURRENT = "4";
    const alice = guestAccess("alice");
    const bob = guestAccess("bob");

    const first = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
    });
    const second = await acquireChatAccess(alice, guestBudget("model-b"), {
        traceId: randomUUID(),
    });
    const third = await acquireChatAccess(bob, guestBudget("model-a"), {
        traceId: randomUUID(),
    });
    const fourth = await acquireChatAccess(bob, guestBudget("model-b"), {
        traceId: randomUUID(),
    });

    // Bob still has one of his own three slots free, so this can only be the
    // aggregate ceiling -- and it says so in its own words.
    const error = await expectChatAccessError(() =>
        acquireChatAccess(bob, guestBudget("model-c"), { traceId: randomUUID() })
    );
    assert.equal(error.code, "CHAT_IP_CONCURRENCY_EXCEEDED");
    assert.equal(error.details?.limitLayer, "operational_admission");
    assert.equal(error.details?.scope, "ip_concurrency");
    assert.match(error.message, /network/i);

    await releaseAll([first, second, third, fourth]);
});

test("an IP ceiling misconfigured below the guest limit cannot refuse a lone guest", async () => {
    process.env.CHAT_IP_CONCURRENT = "1";
    const alice = guestAccess("alice");

    const grants = [];
    for (const modelId of THREE_MODELS) {
        grants.push(
            await acquireChatAccess(alice, guestBudget(modelId), {
                traceId: randomUUID(),
            })
        );
    }
    assert.equal(grants.length, 3);
    await releaseAll(grants);
});

/* ------------------------------------------------------------------ */
/* 3. IP abuse protection is unchanged                                 */
/* ------------------------------------------------------------------ */

test("per-IP credit, token and rate abuse protection still applies to guests", async () => {
    // The per-IP guest quota is a multiple of the per-guest one and is keyed on
    // the IP, so guests behind one NAT do share it -- deliberately, and
    // separately from concurrency. Splitting the *concurrency* scope must not
    // have weakened this leg.
    process.env.CHAT_GUEST_PER_DAY = "1";
    const spenders = ["alice", "bob", "carol"].map((name) => guestAccess(name));

    for (const spender of spenders) {
        const grant = await acquireChatAccess(spender, guestBudget("model-a"), {
            traceId: randomUUID(),
        });
        await releaseChatAccess(grant.leaseId);
    }

    // A guest who has spent nothing of their own daily allowance, refused
    // purely because their network has.
    const newcomer = guestAccess("dave");
    const error = await expectChatAccessError(() =>
        acquireChatAccess(newcomer, guestBudget("model-a"), {
            traceId: randomUUID(),
        })
    );
    assert.equal(error.code, "CHAT_IP_QUOTA_EXCEEDED");

    const ipBuckets = await prisma.chatUsageBucket.findMany({
        where: { key: spenders[0].ipKey },
        select: { period: true },
    });
    assert.ok(ipBuckets.some((bucket) => bucket.period.startsWith("guest-ip-")));
    assert.ok(ipBuckets.some((bucket) => bucket.period === "ip-tokens-day"));
    assert.ok(ipBuckets.some((bucket) => bucket.period === "minute"));
});

/* ------------------------------------------------------------------ */
/* 4-5. All-or-nothing admission, and rollback                         */
/* ------------------------------------------------------------------ */

test("a comparison that cannot fit entirely is refused entirely", async () => {
    const alice = guestAccess("alice");
    // One slot already occupied leaves two of three -- enough for a partial
    // admission, which is the outcome this rejects.
    const holding = await acquireChatAccess(alice, guestBudget("model-z"), {
        traceId: randomUUID(),
    });

    const error = await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000001",
        })
    );
    assert.equal(error.code, "CHAT_CONCURRENCY_EXCEEDED");
    assert.equal(error.details?.requestedSlots, 3);

    // Nothing was reserved: the refused comparison left no slot behind, and no
    // model of it reserved credits.
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 1);
    assert.equal(await prisma.chatCreditReservation.count(), 1);

    await releaseChatAccess(holding.leaseId);
});

test("an admitted comparison's slots are pre-reserved and each is claimed once", async () => {
    const alice = guestAccess("alice");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000002" }
    );

    // All three slots exist before any model request arrives, so no panel can
    // find the allowance already spent by its siblings.
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 3);
    assert.equal(
        await prisma.chatRequestLease.count({ where: { claimedAt: null } }),
        3
    );

    const grants = [];
    for (const modelId of THREE_MODELS) {
        grants.push(
            await acquireChatAccess(alice, guestBudget(modelId), {
                traceId: randomUUID(),
                admissionToken: preflight.admission.token,
            })
        );
    }
    // Claiming consumed the reserved rows rather than adding new ones.
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 3);
    assert.equal(
        await prisma.chatRequestLease.count({ where: { claimedAt: null } }),
        0
    );
    assert.equal(new Set(grants.map((grant) => grant.leaseId)).size, 3);

    await releaseAll(grants);
});

test("a replayed admission token claims nothing a second time", async () => {
    const alice = guestAccess("alice");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000003" }
    );
    const first = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
        admissionToken: preflight.admission.token,
    });

    // Same token, same model, second time: the slot it names is already
    // claimed, so the request falls through to the ordinary check -- which
    // finds this guest's three slots fully spoken for and refuses. A valid
    // signature buys no extra concurrency.
    const error = await expectChatAccessError(() =>
        acquireChatAccess(alice, guestBudget("model-a"), {
            traceId: randomUUID(),
            admissionToken: preflight.admission.token,
        })
    );
    assert.equal(error.code, "CHAT_CONCURRENCY_EXCEEDED");
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 3);

    await releaseChatAccess(first.leaseId);
    await rollbackChatAdmission(preflight.admission.admissionId);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 0);
});

test("another guest's admission token grants nothing", async () => {
    const alice = guestAccess("alice");
    const mallory = guestAccess("mallory");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000004" }
    );

    const stolen = await acquireChatAccess(mallory, guestBudget("model-a"), {
        traceId: randomUUID(),
        admissionToken: preflight.admission.token,
    });
    // Mallory got an ordinary slot of her own, not one of Alice's.
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 3);
    assert.equal(await leaseCountFor(mallory.subjectKey, "subjectKey"), 1);

    await releaseChatAccess(stolen.leaseId);
    await rollbackChatAdmission(preflight.admission.admissionId);
});

test("a comparison abandoned after admission gives its unused slots back", async () => {
    const alice = guestAccess("alice");
    const preflight = await preflightChatComparisonAccess(
        alice,
        comparisonBudgets(),
        { traceId: randomUUID(), comparisonId: "1754000000005" }
    );
    const started = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
        admissionToken: preflight.admission.token,
    });

    await rollbackChatAdmission(preflight.admission.admissionId);

    // The started model keeps its slot; the two that never ran are released.
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 1);
    await releaseChatAccess(started.leaseId);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 0);
});

test("a refused comparison leaves no credit reservation and no lease behind", async () => {
    const alice = guestAccess("alice");
    const holding = await acquireChatAccess(alice, guestBudget("model-z"), {
        traceId: randomUUID(),
    });
    const reservationsBefore = await prisma.chatCreditReservation.count();

    await expectChatAccessError(() =>
        preflightChatComparisonAccess(alice, comparisonBudgets(), {
            traceId: randomUUID(),
            comparisonId: "1754000000006",
        })
    );

    assert.equal(await prisma.chatCreditReservation.count(), reservationsBefore);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 1);
    await releaseChatAccess(holding.leaseId);
});

/* ------------------------------------------------------------------ */
/* 6-9. Lease lifecycle                                                */
/* ------------------------------------------------------------------ */

test("every ending -- completed, failed, cancelled -- leaves zero leases", async () => {
    const alice = guestAccess("alice");

    for (const outcome of ["completed", "failed", "cancelled"] as const) {
        const grant = await acquireChatAccess(alice, guestBudget("model-a"), {
            traceId: randomUUID(),
        });
        await settleChatUsage(grant.usageReservation, {
            inputTokens: 100,
            outputTokens: outcome === "completed" ? 400 : 0,
            outcome,
        });
        await releaseChatAccess(grant.leaseId, { reason: outcome });
        assert.equal(
            await leaseCountFor(alice.subjectKey, "subjectKey"),
            0,
            `outcome ${outcome} left a lease behind`
        );
    }
});

test("an error before the stream starts releases the slot", async () => {
    const alice = guestAccess("alice");
    const grant = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
    });
    // Mirrors the route's catch: settle as failed, then release.
    await settleChatUsage(grant.usageReservation, {
        inputTokens: 0,
        outputTokens: 0,
        outcome: "failed",
    });
    await releaseChatAccess(grant.leaseId, {
        reason: "request_failed_before_stream",
    });
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 0);
});

test("releasing twice, and releasing an unknown lease, are both no-ops", async () => {
    const alice = guestAccess("alice");
    const grant = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
    });

    assert.equal(await releaseChatAccess(grant.leaseId), true);
    assert.equal(await releaseChatAccess(grant.leaseId), true);
    assert.equal(await releaseChatAccess(randomUUID()), true);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 0);
});

test("a stream running past the old 120s ceiling keeps its slot by renewing", async () => {
    const alice = guestAccess("alice");
    const grant = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
    });
    const before = await prisma.chatRequestLease.findUniqueOrThrow({
        where: { id: grant.leaseId },
    });

    // The reported failure: a healthy response still writing at 125s under a
    // flat 120s lease. Move the clock past that point by ageing the row, then
    // heartbeat the way the stream does.
    const agedExpiry = new Date(Date.now() + 5_000);
    await prisma.chatRequestLease.update({
        where: { id: grant.leaseId },
        data: { expiresAt: agedExpiry },
    });

    assert.equal(await heartbeatChatAccess(grant.leaseId), true);
    const renewed = await prisma.chatRequestLease.findUniqueOrThrow({
        where: { id: grant.leaseId },
    });
    assert.ok(renewed.expiresAt.getTime() > agedExpiry.getTime());
    assert.ok(renewed.expiresAt.getTime() >= before.expiresAt.getTime() - 1_000);
    assert.ok(renewed.heartbeatAt.getTime() >= before.heartbeatAt.getTime());
    // Still exactly one slot -- renewing never mints another.
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 1);

    await releaseChatAccess(grant.leaseId);
});

test("a heartbeat for a lease that is already gone reports so instead of resurrecting it", async () => {
    const alice = guestAccess("alice");
    const grant = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
    });
    await releaseChatAccess(grant.leaseId);

    assert.equal(await heartbeatChatAccess(grant.leaseId), false);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 0);
});

test("orphaned leases are swept by reconciliation, and the sweep is idempotent", async () => {
    const alice = guestAccess("alice");
    const grant = await acquireChatAccess(alice, guestBudget("model-a"), {
        traceId: randomUUID(),
    });
    // A worker that died mid-stream: nothing released the row, and no
    // heartbeat is renewing it, so it expires where it stands.
    await prisma.chatRequestLease.update({
        where: { id: grant.leaseId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const first = await reconcileExpiredChatRequestLeases();
    assert.equal(first.removed, 1);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 0);

    const second = await reconcileExpiredChatRequestLeases();
    assert.equal(second.removed, 0);
});

test("an expired lease no longer occupies the guest's allowance", async () => {
    const alice = guestAccess("alice");
    const grants = [];
    for (const modelId of THREE_MODELS) {
        grants.push(
            await acquireChatAccess(alice, guestBudget(modelId), {
                traceId: randomUUID(),
            })
        );
    }
    await expectChatAccessError(() =>
        acquireChatAccess(alice, guestBudget("model-d"), { traceId: randomUUID() })
    );

    await prisma.chatRequestLease.updateMany({
        where: { subjectKey: alice.subjectKey },
        data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const recovered = await acquireChatAccess(alice, guestBudget("model-d"), {
        traceId: randomUUID(),
    });
    assert.ok(recovered.leaseId);
    assert.equal(await leaseCountFor(alice.subjectKey, "subjectKey"), 1);
    await releaseChatAccess(recovered.leaseId);
    void grants;
});

test("finishing a comparison lets the next one start immediately", async () => {
    const alice = guestAccess("alice");
    const first = await runComparison(alice, "1754000000007");
    for (const grant of first.grants) {
        await settleChatUsage(grant.usageReservation, {
            inputTokens: 100,
            outputTokens: 400,
            outcome: "completed",
        });
        await releaseChatAccess(grant.leaseId);
    }

    const second = await runComparison(alice, "1754000000008");
    assert.equal(second.grants.length, 3);
    await releaseAll(second.grants);
});
