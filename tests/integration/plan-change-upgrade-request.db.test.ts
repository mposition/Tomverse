import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// What a confirmed plan-change upgrade actually sends to Stripe.
//
// Two of this repository's named invariants live in those request parameters
// and nowhere else:
//
//   * "결제 전에 권한을 올리지 않습니다" — the upgrade is invoiced now and
//     parked as a pending update until that invoice is paid. That is
//     `proration_behavior: always_invoice` plus
//     `payment_behavior: pending_if_incomplete`, together;
//   * "`cancel_at_period_end`를 자동으로 해제하지 않습니다" — a subscription
//     already set to cancel keeps cancelling unless the customer opted in
//     through a separate control.
//
// `tests/planChangeStateMachine.test.mjs` proves the *decision*:
// `cancellation_preserved` versus `cancellation_cleared_by_explicit_consent`.
// Nothing proved the *translation* of that decision into request parameters,
// and translation is exactly where this codebase has been bitten before: the
// promotion checkout regression was a Session created with the wrong
// combination of parameters, where every value was right and the presence of
// a key was the bug. `cancel_at_period_end: false` sent when the decision said
// preserve would revive a cancelled subscription silently, and it would look
// correct in every unit test of the decision.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces the Stripe client and
// the billing catalogue for every module that imports them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
    pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.STRIPE_SECRET_KEY = "sk_test_plan_change_fixture";

const PRO_PRICE = "price_pro_monthly";
const MAX_PRICE = "price_max_monthly";
const SUBSCRIPTION_ID = "sub_plan_change";
const SUBSCRIPTION_ITEM_ID = "si_plan_change";
const PERIOD_END = new Date("2027-01-01T00:00:00.000Z");

/** The subscription Stripe hands back, shaped by each test. */
let subscription: Record<string, unknown> = {};

type UpdateCall = {
    id: string;
    params: Record<string, unknown>;
    options: { idempotencyKey?: string } | undefined;
};
let updateCalls: UpdateCall[] = [];

mock.module(mod("lib/stripe.ts"), {
    namedExports: {
        isStripeConfigured: () => true,
        getStripe: () => ({
            subscriptions: {
                retrieve: async () => subscription,
                update: async (
                    id: string,
                    params: Record<string, unknown>,
                    options?: { idempotencyKey?: string }
                ) => {
                    updateCalls.push({ id, params, options });
                    return { ...subscription, ...params };
                },
            },
            prices: {
                list: async () => ({
                    data: [
                        {
                            id: MAX_PRICE,
                            currency: "usd",
                            recurring: { interval: "month", interval_count: 1 },
                            tax_behavior: "exclusive",
                            active: true,
                        },
                    ],
                }),
            },
        }),
    },
});

const PLANS = [
    {
        id: "pro",
        name: "Pro",
        tier: "Pro",
        monthlyPriceCents: 1500,
        annualPriceCents: 14400,
        currency: "USD",
        stripeProductId: "prod_pro",
        stripePriceId: PRO_PRICE,
        stripeAnnualPriceId: null,
        dailyMessageLimit: 0,
        monthlyMessageLimit: 4000,
        maxModels: 3,
        allowAttachments: true,
        allowSharing: true,
        allowDownloads: true,
        isActive: true,
        sortOrder: 2,
    },
    {
        id: "max",
        name: "Max",
        tier: "Max",
        monthlyPriceCents: 2500,
        annualPriceCents: 24000,
        currency: "USD",
        stripeProductId: "prod_max",
        stripePriceId: MAX_PRICE,
        stripeAnnualPriceId: null,
        dailyMessageLimit: 0,
        monthlyMessageLimit: 10000,
        maxModels: 6,
        allowAttachments: true,
        allowSharing: true,
        allowDownloads: true,
        isActive: true,
        sortOrder: 3,
    },
];

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let confirmPlanChange: (typeof import("@/lib/planChangeService"))["confirmPlanChange"];
let snapshotFromStripeSubscription: (typeof import("@/lib/planChangeService"))["snapshotFromStripeSubscription"];
let planChangeStateFingerprint: (typeof import("@/lib/planChangeStateMachine"))["planChangeStateFingerprint"];

before(async () => {
    const realBillingConfig = (await import(
        mod("lib/billingConfig.ts")
    )) as typeof import("@/lib/billingConfig");
    mock.module(mod("lib/billingConfig.ts"), {
        namedExports: {
            ...realBillingConfig,
            getBillingPlans: async () => PLANS,
        },
    });

    ({ prisma } = (await import(
        mod("lib/prisma.ts")
    )) as typeof import("@/lib/prisma"));
    ({ planChangeStateFingerprint } = (await import(
        mod("lib/planChangeStateMachine.ts")
    )) as typeof import("@/lib/planChangeStateMachine"));
    ({ confirmPlanChange, snapshotFromStripeSubscription } = (await import(
        mod("lib/planChangeService.ts")
    )) as typeof import("@/lib/planChangeService"));
});

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "PlanChangeRequest", "User" RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
    await resetData();
    updateCalls = [];
    subscription = proSubscription();
});

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const proSubscription = (
    overrides: { cancel_at_period_end?: boolean } = {}
): Record<string, unknown> => ({
    id: SUBSCRIPTION_ID,
    status: "active",
    currency: "usd",
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
    pending_update: null,
    schedule: null,
    items: {
        data: [
            {
                id: SUBSCRIPTION_ITEM_ID,
                current_period_end: Math.trunc(PERIOD_END.getTime() / 1000),
                price: {
                    id: PRO_PRICE,
                    currency: "usd",
                    recurring: { interval: "month", interval_count: 1 },
                    tax_behavior: "exclusive",
                    product: "prod_pro",
                },
            },
        ],
    },
});

/**
 * An account on Pro with a quote for Max already stored, matching whatever
 * `subscription` currently says. The fingerprint is computed from the same
 * snapshot the service will build, because a mismatch is a legitimate refusal
 * and would make every assertion below vacuous.
 */
const seedPreviewedUpgrade = async () => {
    const user = await prisma.user.create({
        data: {
            email: `plan-change-${randomUUID()}@example.test`,
            plan: "Pro",
            stripeSubscriptionId: SUBSCRIPTION_ID,
            subscriptionStatus: "active",
        },
    });
    const snapshot = await snapshotFromStripeSubscription(
        // The fixture carries the fields the snapshot reads and nothing else;
        // Stripe's own type has forty more the service never touches.
        subscription as unknown as Parameters<
            typeof snapshotFromStripeSubscription
        >[0]
    );
    const request = await prisma.planChangeRequest.create({
        data: {
            userId: user.id,
            direction: "upgrade",
            execution: "immediate_upgrade",
            fromTier: "Pro",
            toTier: "Max",
            billingInterval: "monthly",
            currency: "usd",
            stripeSubscriptionId: SUBSCRIPTION_ID,
            stripeSubscriptionItemId: SUBSCRIPTION_ITEM_ID,
            targetStripePriceId: MAX_PRICE,
            fingerprint: planChangeStateFingerprint(snapshot),
            renewalDecision: "unaffected",
            status: "previewed",
        },
    });
    return { user, request };
};

const onlyUpdate = () => {
    assert.equal(updateCalls.length, 1, "exactly one subscription update");
    return updateCalls[0];
};

test("an upgrade is invoiced now and parked until the invoice is paid", async () => {
    const { user, request } = await seedPreviewedUpgrade();

    const result = await confirmPlanChange({ userId: user.id, requestId: request.id });
    assert.equal("ok" in result && result.ok, true);

    const call = onlyUpdate();
    assert.equal(call.id, SUBSCRIPTION_ID);
    // The pair is the whole "no Max before payment" guarantee. Either one alone
    // grants the tier and bills later.
    assert.equal(call.params.proration_behavior, "always_invoice");
    assert.equal(call.params.payment_behavior, "pending_if_incomplete");
    assert.deepEqual(call.params.items, [
        { id: SUBSCRIPTION_ITEM_ID, price: MAX_PRICE },
    ]);
    // Scoped to the quote, so a retried confirm is answered from Stripe's
    // record of the first call rather than changing the subscription twice.
    assert.ok(call.options?.idempotencyKey);

    // The row claims the account's one in-flight slot.
    const stored = await prisma.planChangeRequest.findUniqueOrThrow({
        where: { id: request.id },
    });
    assert.equal(stored.status, "pending");
    assert.equal(stored.pendingForUserId, user.id);
});

test("a cancelling subscription keeps cancelling: the key is not sent at all", async () => {
    // Not `cancel_at_period_end: true` — the parameter is absent. Sending it
    // with any value here would make the upgrade an opinion about renewal,
    // which is the customer's decision and was made elsewhere.
    subscription = proSubscription({ cancel_at_period_end: true });
    const { user, request } = await seedPreviewedUpgrade();

    const result = await confirmPlanChange({ userId: user.id, requestId: request.id });
    assert.equal("ok" in result && result.ok, true);

    const call = onlyUpdate();
    assert.equal(
        "cancel_at_period_end" in call.params,
        false,
        `the upgrade must not touch the cancellation: ${JSON.stringify(call.params)}`
    );
});

test("only an explicit opt-in clears the cancellation", async () => {
    subscription = proSubscription({ cancel_at_period_end: true });
    const { user, request } = await seedPreviewedUpgrade();

    const result = await confirmPlanChange({
        userId: user.id,
        requestId: request.id,
        resumeRenewal: true,
    });
    assert.equal("ok" in result && result.ok, true);

    assert.equal(onlyUpdate().params.cancel_at_period_end, false);
});

test("the opt-in sends nothing when there is no cancellation to clear", async () => {
    // `resumeRenewal` on a renewing subscription is meaningless, and sending
    // `cancel_at_period_end: false` anyway would be a write nobody asked for.
    const { user, request } = await seedPreviewedUpgrade();

    const result = await confirmPlanChange({
        userId: user.id,
        requestId: request.id,
        resumeRenewal: true,
    });
    assert.equal("ok" in result && result.ok, true);

    assert.equal("cancel_at_period_end" in onlyUpdate().params, false);
});

test("confirming twice changes the subscription once", async () => {
    const { user, request } = await seedPreviewedUpgrade();

    await confirmPlanChange({ userId: user.id, requestId: request.id });
    const replay = await confirmPlanChange({ userId: user.id, requestId: request.id });

    assert.equal("ok" in replay && replay.ok, true);
    assert.equal(
        updateCalls.length,
        1,
        "the second confirm reports the reservation instead of running it again"
    );
});
