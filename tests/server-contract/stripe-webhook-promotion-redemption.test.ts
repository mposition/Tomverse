import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type Stripe from "stripe";

/**
 * Webhook contract for a promotion that discounts a subscription to zero.
 *
 * A 100%-off first invoice is the case the completion path is least exercised
 * on: there is no charge, so `payment_intent` is null and no payment method is
 * necessarily created. If any of that were treated as required, the customer
 * would pay nothing, get nothing, and the promotion would still be marked used.
 *
 * What must hold:
 *   - a zero-due completion still syncs the subscription and grants the plan;
 *   - the redemption is counted at completion, never at Session creation, so an
 *     abandoned checkout does not consume a redemption;
 *   - a redelivered or out-of-order `checkout.session.completed` increments the
 *     count exactly once;
 *   - the promotion lease is released once the checkout resolves.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "webhook-contract-secret";
process.env.STRIPE_SECRET_KEY ||= "sk_test_contract";

type World = {
  /** Session ids already recorded, i.e. the unique constraint in miniature. */
  recordedSessionIds: Set<string>;
  redeemedCount: number;
  redemptionRows: Record<string, unknown>[];
  userUpdates: Record<string, unknown>[];
  releases: string[];
  subscription: Stripe.Subscription;
  paymentMethodRetrieves: string[];
};

const subscriptionFixture = (): Stripe.Subscription =>
  ({
    id: "sub_zero_due",
    object: "subscription",
    status: "active",
    customer: "cus_1",
    cancel_at_period_end: false,
    current_period_end: 1_800_000_000,
    // Zero-due promotions frequently produce no default payment method at all.
    default_payment_method: null,
    metadata: { planId: "max", billingInterval: "monthly" },
    items: {
      data: [
        {
          price: {
            id: "price_max_monthly",
            product: "prod_max",
            recurring: { interval: "month" },
          },
        },
      ],
    },
  }) as unknown as Stripe.Subscription;

const freshWorld = (): World => ({
  recordedSessionIds: new Set(),
  redeemedCount: 0,
  redemptionRows: [],
  userUpdates: [],
  releases: [],
  subscription: subscriptionFixture(),
  paymentMethodRetrieves: [],
});

let world = freshWorld();
let mocksInstalled = false;

async function loadProcessor() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;

    const tx = {
      billingPromotion: {
        findUnique: async () => ({
          id: "promo_db",
          isActive: true,
          maxRedemptions: 1000,
          startsAt: null,
          endsAt: new Date("2026-12-31T00:00:00.000Z"),
          appliesToPlanIds: JSON.stringify(["max"]),
          allowAnnualStacking: false,
        }),
        updateMany: async () => {
          world.redeemedCount += 1;
          return { count: 1 };
        },
      },
      billingPromotionRedemption: {
        findUnique: async ({
          where,
        }: {
          where: { stripeCheckoutSessionId: string };
        }) =>
          world.recordedSessionIds.has(where.stripeCheckoutSessionId)
            ? { id: "existing" }
            : null,
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          world.recordedSessionIds.add(data.stripeCheckoutSessionId as string);
          world.redemptionRows.push(data);
          return data;
        },
      },
    };

    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          $transaction: async (fn: (client: unknown) => Promise<unknown>) =>
            fn(tx),
          user: {
            findFirst: async () => ({
              id: "user_1",
              email: "buyer@example.com",
              subscriptionSyncedAt: null,
              settings: { language: "en" },
            }),
            updateMany: async ({ data }: { data: Record<string, unknown> }) => {
              world.userUpdates.push(data);
              return { count: 1 };
            },
          },
        },
      },
    });

    mock.module(mod("lib/stripe.ts"), {
      namedExports: {
        isStripeConfigured: () => true,
        getStripe: () => ({
          subscriptions: { retrieve: async () => world.subscription },
          paymentMethods: {
            retrieve: async (id: string) => {
              world.paymentMethodRetrieves.push(id);
              return { id, type: "card", card: { fingerprint: "fp_1" } };
            },
          },
        }),
      },
    });

    const realPromotionSecurity = original("lib/billingPromotionSecurity.ts");
    mock.module(mod("lib/billingPromotionSecurity.ts"), {
      namedExports: {
        ...realPromotionSecurity,
        releasePromotionCheckout: async (promotionId: string) => {
          world.releases.push(promotionId);
        },
      },
    });

    const realBillingConfig = original("lib/billingConfig.ts");
    mock.module(mod("lib/billingConfig.ts"), {
      namedExports: {
        ...realBillingConfig,
        getBillingPlans: async () => [
          {
            id: "max",
            name: "Max",
            tier: "Max",
            monthlyPriceCents: 2500,
            annualPriceCents: 24000,
            currency: "USD",
            stripeProductId: "prod_max",
            stripePriceId: "price_max_monthly",
            stripeAnnualPriceId: "price_max_annual",
            dailyMessageLimit: 0,
            monthlyMessageLimit: 10000,
            maxModels: 6,
            allowAttachments: true,
            allowSharing: true,
            allowDownloads: true,
            isActive: true,
            sortOrder: 3,
          },
        ],
      },
    });

    mock.module(mod("lib/billingEmails.ts"), {
      namedExports: {
        ...original("lib/billingEmails.ts"),
        sendBillingWelcomeEmail: async () => undefined,
      },
    });
    mock.module(mod("lib/billingTransactions.ts"), {
      namedExports: {
        ...original("lib/billingTransactions.ts"),
        recordBillingTransactionFromCheckout: async () => undefined,
      },
    });
    mock.module(mod("lib/planChangeService.ts"), {
      namedExports: {
        ...original("lib/planChangeService.ts"),
        settlePlanChangesForSubscription: async () => undefined,
      },
    });
    mock.module(mod("lib/productAnalyticsServer.ts"), {
      namedExports: {
        ...original("lib/productAnalyticsServer.ts"),
        recordProductAnalyticsEvent: async () => undefined,
        analyticsAttributionFromMetadata: () => null,
      },
    });
  }

  return (await import(
    mod("lib/stripeWebhookProcessing.ts")
  )) as typeof import("../../lib/stripeWebhookProcessing");
}

const zeroDueSession = (id = "cs_zero") =>
  ({
    id,
    object: "checkout.session",
    subscription: "sub_zero_due",
    client_reference_id: "user_1",
    // A fully discounted first invoice: nothing is charged, so Stripe creates
    // no PaymentIntent.
    payment_intent: null,
    amount_total: 0,
    currency: "usd",
    metadata: {
      userId: "user_1",
      planId: "max",
      billingInterval: "monthly",
      promotionId: "promo_db",
      promotionIpHash: "a".repeat(64),
      promotionRiskFlags: "[]",
    },
  }) as unknown as Stripe.Checkout.Session;

const completedEvent = (session: Stripe.Checkout.Session) =>
  ({
    id: `evt_${session.id}`,
    type: "checkout.session.completed",
    data: { object: session },
  }) as unknown as Stripe.Event;

test.beforeEach(() => {
  world = freshWorld();
});

test("a zero-due completion with no payment intent still grants the plan", async () => {
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.equal(world.userUpdates.length, 1);
  assert.equal(world.userUpdates[0].plan, "Max");
  assert.equal(world.userUpdates[0].stripeSubscriptionId, "sub_zero_due");
  assert.equal(world.userUpdates[0].subscriptionStatus, "active");
  // No payment method existed to fingerprint, and that is not an error.
  assert.deepEqual(world.paymentMethodRetrieves, []);
  assert.equal(world.redemptionRows[0].paymentMethodFingerprintHash, null);
});

test("the redemption is counted once, at completion", async () => {
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(world.redeemedCount, 1);
  assert.equal(world.redemptionRows.length, 1);
  assert.equal(world.redemptionRows[0].promotionId, "promo_db");
  assert.equal(world.redemptionRows[0].planId, "max");
});

test("a redelivered completion does not count a second redemption", async () => {
  // Stripe retries deliveries and does not guarantee ordering, so the same
  // event arriving twice must be indistinguishable from arriving once.
  const { processStripeEvent } = await loadProcessor();
  const session = zeroDueSession();
  await processStripeEvent(completedEvent(session));
  await processStripeEvent(completedEvent(session));
  assert.equal(world.redeemedCount, 1);
  assert.equal(world.redemptionRows.length, 1);
});

test("the promotion lease is released when the checkout resolves", async () => {
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.deepEqual(world.releases, ["promo_db"]);
});

test("a completion carrying no subscription records nothing", async () => {
  // An abandoned checkout never reaches completion at all; this is the closest
  // observable case, and it must not consume a redemption either.
  const { processStripeEvent } = await loadProcessor();
  const abandoned = {
    ...zeroDueSession("cs_no_sub"),
    subscription: null,
  } as unknown as Stripe.Checkout.Session;
  await processStripeEvent(completedEvent(abandoned));
  assert.equal(world.redeemedCount, 0);
  assert.deepEqual(world.redemptionRows, []);
  assert.deepEqual(world.userUpdates, []);
});

test("redemption counting lives in the webhook, never in the checkout route", async () => {
  // Structural, because the alternative -- counting at Session creation -- is
  // invisible until a promotion runs out of redemptions nobody used.
  const { readFileSync } = await import("node:fs");
  const checkoutRoute = readFileSync(
    resolve(ROOT, "app/api/billing/checkout/route.ts"),
    "utf8"
  );
  // The one exception is the internal access pass, which is granted inline and
  // has no Stripe checkout to complete later.
  const incrementBlocks = checkoutRoute.split("redeemedCount");
  assert.equal(
    incrementBlocks.length - 1,
    2,
    "only activateInternalPass may touch redeemedCount in the checkout route"
  );
  assert.match(checkoutRoute, /activateInternalPass/);
});
