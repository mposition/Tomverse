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
  /** Full call shape, so the staleness guard can be asserted, not assumed. */
  releaseCalls: {
    promotionId: string;
    userId: string;
    takenAtOrBefore?: Date;
    checkoutSessionId?: string;
  }[];
  subscription: Stripe.Subscription;
  paymentMethodRetrieves: string[];
  /** The promotion's per-card limit; null = none. */
  cardLimit: number | null;
  /** Other accounts the card has already redeemed this promotion on. */
  otherAccountsOnCard: string[];
  /** riskFlags of recorded redemptions, by Checkout Session id. */
  recordedFlags: Map<string, string>;
  cancels: { id: string; params: unknown }[];
  cancelFailure: Error | null;
  burstAlerts: string[];
  promotionActive: boolean;
  /** Thrown from the per-card count, i.e. a database fault mid-decision. */
  recordFault: Error | null;
  paymentMethodFault: Error | null;
  lockCalls: unknown[][];
  countWheres: Record<string, unknown>[];
  /** The promotion's last redemption taken by a concurrent completion. */
  promotionExhausted: boolean;
  /**
   * A concurrent delivery of the same Session recorded first: invisible to
   * this transaction's read, so its insert hits the unique constraint.
   */
  concurrentRow: { riskFlags: string } | null;
  /** The account already redeemed the promotion through another Session. */
  accountAlreadyRedeemed: boolean;
  customerDefaultPaymentMethod: string | null;
  customerPaymentMethods: Record<string, unknown>[];
  /** The payment method on the Session's own SetupIntent / PaymentIntent. */
  setupIntentPaymentMethod: string | null;
  paymentIntentPaymentMethod: string | null;
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
  releaseCalls: [],
  subscription: subscriptionFixture(),
  paymentMethodRetrieves: [],
  // No per-card limit unless a test sets one: a limited zero-charge checkout
  // with no identifiable payer is refused, and most of these tests are about
  // other things.
  cardLimit: null,
  otherAccountsOnCard: [],
  recordedFlags: new Map(),
  cancels: [],
  cancelFailure: null,
  burstAlerts: [],
  promotionActive: true,
  recordFault: null,
  paymentMethodFault: null,
  lockCalls: [],
  countWheres: [],
  promotionExhausted: false,
  concurrentRow: null,
  accountAlreadyRedeemed: false,
  customerDefaultPaymentMethod: null,
  customerPaymentMethods: [],
  setupIntentPaymentMethod: null,
  paymentIntentPaymentMethod: null,
});

let world = freshWorld();
let mocksInstalled = false;

async function loadProcessor() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;

    const otherAccountsOnCard = async ({
      take,
      where,
    }: {
      take?: number;
      where?: Record<string, unknown>;
    }) => {
      if (where) world.countWheres.push(where);
      if (world.recordFault) throw world.recordFault;
      return world.otherAccountsOnCard
        .slice(0, take ?? world.otherAccountsOnCard.length)
        .map((userId) => ({ userId }));
    };
    const tx = {
      $executeRaw: async (...args: unknown[]) => {
        world.lockCalls.push(args);
        return 0;
      },
      user: {
        findUniqueOrThrow: async () => ({ id: "user_1", plan: "Free", subscriptionSyncedAt: null }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          world.userUpdates.push(data);
          return { id: "user_1", ...data };
        },
      },
      billingPromotion: {
        findUnique: async () => ({
          id: "promo_db",
          isActive: world.promotionActive,
          maxRedemptions: 1000,
          startsAt: null,
          endsAt: new Date("2026-12-31T00:00:00.000Z"),
          appliesToPlanIds: JSON.stringify(["max"]),
          allowAnnualStacking: false,
          maxRedemptionsPerPaymentMethod: world.cardLimit,
        }),
        updateMany: async () => {
          if (world.promotionExhausted) return { count: 0 };
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
            ? {
                id: "existing",
                riskFlags:
                  world.recordedFlags.get(where.stripeCheckoutSessionId) ?? "[]",
              }
            : null,
        findFirst: async () => null,
        findMany: otherAccountsOnCard,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (world.concurrentRow || world.accountAlreadyRedeemed) {
            throw Object.assign(new Error("Unique constraint failed"), {
              code: "P2002",
            });
          }
          world.recordedSessionIds.add(data.stripeCheckoutSessionId as string);
          world.recordedFlags.set(
            data.stripeCheckoutSessionId as string,
            data.riskFlags as string
          );
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
          // Read by the sync-time per-card check, outside any transaction.
          billingPromotionRedemption: {
            findUnique: async () => world.concurrentRow,
            findFirst: async ({
              where,
            }: {
              where: { stripeSubscriptionId: string };
            }) => {
              const row = world.redemptionRows.find(
                (item) => item.stripeSubscriptionId === where.stripeSubscriptionId
              );
              return row ? { riskFlags: row.riskFlags } : null;
            },
            findMany: otherAccountsOnCard,
          },
          billingPromotion: {
            findUnique: async () => ({
              maxRedemptionsPerPaymentMethod: world.cardLimit,
            }),
          },
          user: {
            findFirst: async () => ({
              id: "user_1",
              email: "buyer@example.com",
              subscriptionSyncedAt: null,
              settings: { language: "en" },
              // What the last sync granted, as the account would now carry it.
              stripeSubscriptionId:
                (world.userUpdates.at(-1)?.stripeSubscriptionId as
                  | string
                  | undefined) ?? null,
            }),
            updateMany: async ({
              where,
              data,
            }: {
              where: { stripeSubscriptionId?: string };
              data: Record<string, unknown>;
            }) => {
              // Scoped to one subscription: only matches the account that
              // carries it, as the real query would.
              if (where.stripeSubscriptionId !== undefined) {
                const carried = world.userUpdates.at(-1)?.stripeSubscriptionId;
                if (carried !== where.stripeSubscriptionId) return { count: 0 };
              }
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
          subscriptions: {
            retrieve: async () => world.subscription,
            cancel: async (id: string, params: unknown) => {
              if (world.cancelFailure) throw world.cancelFailure;
              world.cancels.push({ id, params });
              world.subscription = {
                ...world.subscription,
                status: "canceled",
              } as Stripe.Subscription;
              return world.subscription;
            },
          },
          paymentMethods: {
            retrieve: async (id: string) => {
              if (world.paymentMethodFault) throw world.paymentMethodFault;
              world.paymentMethodRetrieves.push(id);
              return id === "pm_link"
                ? { id, type: "link", link: { email: "Payer@Example.com" } }
                : { id, type: "card", card: { fingerprint: "fp_1" } };
            },
            list: async () => ({ data: world.customerPaymentMethods }),
          },
          setupIntents: {
            retrieve: async (id: string) => ({
              id,
              payment_method: world.setupIntentPaymentMethod,
            }),
          },
          paymentIntents: {
            retrieve: async (id: string) => ({
              id,
              payment_method: world.paymentIntentPaymentMethod,
            }),
          },
          customers: {
            retrieve: async () => ({
              id: "cus_1",
              invoice_settings: {
                default_payment_method: world.customerDefaultPaymentMethod,
              },
            }),
          },
        }),
      },
    });

    const realPromotionSecurity = original("lib/billingPromotionSecurity.ts");
    mock.module(mod("lib/billingPromotionSecurity.ts"), {
      namedExports: {
        ...realPromotionSecurity,
        releasePromotionCheckout: async (
          promotionId: string,
          userId: string,
          options: { takenAtOrBefore?: Date; checkoutSessionId?: string } = {}
        ) => {
          world.releases.push(promotionId);
          world.releaseCalls.push({
            promotionId,
            userId,
            takenAtOrBefore: options.takenAtOrBefore,
            checkoutSessionId: options.checkoutSessionId,
          });
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

    // The subscription receipt is enqueued now rather than sent, so the lane is
    // what needs stubbing. lib/billingEmails.ts is left alone: the webhook
    // still calls resolveBillingPeriodEnd out of it, and mocking a module to
    // replace a function nobody calls is coverage-shaped noise.
    mock.module(mod("lib/standardEmailLane.ts"), {
      namedExports: {
        enqueueStandardEmail: async () => null,
      },
    });
    mock.module(mod("lib/promotionBurstAlert.ts"), {
      namedExports: {
        alertOnPromotionBurst: async (promotionId: string) => {
          world.burstAlerts.push(promotionId);
          return { alerted: false, inWindow: 1 };
        },
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

/** Stripe expires an unpaid Session 30 minutes after it is created. */
const SESSION_CREATED_SECONDS = 1_800_000_000;

const expiringSession = (overrides: Record<string, unknown> = {}) =>
  ({
    ...(zeroDueSession("cs_expired") as unknown as Record<string, unknown>),
    subscription: null,
    created: SESSION_CREATED_SECONDS,
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

const expiredEvent = (session: Stripe.Checkout.Session) =>
  ({
    id: `evt_expired_${session.id}`,
    type: "checkout.session.expired",
    data: { object: session },
  }) as unknown as Stripe.Event;

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

/* -------------------------------------------------------------------------- */
/* Abandoned checkouts                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The lease is keyed on `(promotionId, userId)`, not on the plan, so a customer
 * who opens a Pro checkout and walks away cannot start a Max one until it
 * clears. Before this event was handled the only thing that cleared it was the
 * 31-minute TTL, and the customer was told "A checkout using this promotion is
 * already in progress" about an attempt Stripe had already closed.
 */

test("an expired checkout releases the promotion lease", async () => {
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(expiredEvent(expiringSession()));

  assert.equal(world.releaseCalls.length, 1);
  assert.equal(world.releaseCalls[0].promotionId, "promo_db");
  assert.equal(world.releaseCalls[0].userId, "user_1");
});

test("the release is bounded by the Session's own creation time", async () => {
  // Stripe redelivers a failed webhook for days. An unbounded release would
  // free a lease belonging to a later attempt and allow two live Sessions for
  // one promotion -- the single thing the lease exists to prevent.
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(expiredEvent(expiringSession()));

  assert.deepEqual(
    world.releaseCalls[0].takenAtOrBefore,
    new Date(SESSION_CREATED_SECONDS * 1000)
  );
  assert.equal(world.releaseCalls[0].checkoutSessionId, "cs_expired");
});

test("an expired checkout consumes no redemption and touches no subscription", async () => {
  // Nothing was paid for. Counting it would spend a redemption on a capped
  // promotion for a customer who received nothing.
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(expiredEvent(expiringSession()));

  assert.equal(world.redeemedCount, 0);
  assert.deepEqual(world.redemptionRows, []);
  assert.deepEqual(world.userUpdates, []);
});

test("an expired checkout that carried no promotion releases nothing", async () => {
  // A credit-pack or plain subscription checkout never took a promotion lease.
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(
    expiredEvent(expiringSession({ metadata: {}, client_reference_id: null }))
  );

  assert.deepEqual(world.releaseCalls, []);
});

test("an expired checkout with no creation time releases nothing", async () => {
  // Fail closed: without the Session's own timestamp this attempt cannot be
  // told from a later one, and waiting out the TTL is the behaviour this
  // handler improves on rather than a failure of it.
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(expiredEvent(expiringSession({ created: null })));

  assert.deepEqual(world.releaseCalls, []);
});

/* -------------------------------------------------------------------------- */
/* Per-card limit (OZBFREE, 2026-11-20: 41 accounts on four cards)             */
/* -------------------------------------------------------------------------- */

const withCard = () => {
  world.cardLimit = 3;
  world.subscription = {
    ...world.subscription,
    default_payment_method: "pm_card",
  } as Stripe.Subscription;
};

const flagsOf = (row: Record<string, unknown>) =>
  JSON.parse(String(row.riskFlags)) as string[];

test("a card under its limit still gets the plan, flagged as shared", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.otherAccountsOnCard = ["user_a", "user_b"];
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.deepEqual(world.cancels, []);
  assert.equal(world.userUpdates[0].plan, "Max");
  assert.equal(world.redeemedCount, 1);
  assert.deepEqual(flagsOf(world.redemptionRows[0]), ["shared_payment_method"]);
});

test("a card over its limit is cancelled instead of granted", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.equal(world.cancels.length, 1);
  assert.equal(world.cancels[0].id, "sub_zero_due");
  assert.deepEqual(
    (world.cancels[0].params as { invoice_now: boolean; prorate: boolean })
      .invoice_now,
    false
  );
  // Never granted, never counted, but recorded so the account cannot retry and
  // the Admin risk count sees it.
  assert.deepEqual(world.userUpdates, []);
  assert.equal(world.redeemedCount, 0);
  assert.equal(world.redemptionRows.length, 1);
  assert.deepEqual(flagsOf(world.redemptionRows[0]).sort(), [
    "payment_method_limit",
    "shared_payment_method",
  ]);
});

test("a promotion with no per-card limit does not refuse a reused card", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.cardLimit = null;
  world.otherAccountsOnCard = Array.from({ length: 40 }, (_, i) => `user_${i}`);
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.deepEqual(world.cancels, []);
  assert.equal(world.userUpdates[0].plan, "Max");
});

test("a failed cancellation fails the webhook, and the redelivery cancels without granting", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  world.cancelFailure = new Error("stripe unavailable");
  const session = zeroDueSession();
  await assert.rejects(processStripeEvent(completedEvent(session)));
  assert.deepEqual(world.userUpdates, []);

  // Stripe delivers it again. The refusal is already recorded, so the retry
  // cancels from that record rather than re-deciding -- and still grants nothing.
  world.cancelFailure = null;
  await processStripeEvent(completedEvent(session));
  assert.equal(world.cancels.length, 1);
  assert.deepEqual(world.userUpdates, []);
  assert.equal(world.redemptionRows.length, 1);
  assert.equal(world.redeemedCount, 0);
});

test("a redelivery after a successful cancellation does not cancel twice", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  const session = zeroDueSession();
  await processStripeEvent(completedEvent(session));
  await processStripeEvent(completedEvent(session));
  assert.equal(world.cancels.length, 1);
  assert.deepEqual(world.userUpdates, []);
});

test("every recorded redemption is checked for a burst, refused ones included", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  await processStripeEvent(completedEvent(zeroDueSession("cs_ok")));
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(completedEvent(zeroDueSession("cs_refused")));
  assert.deepEqual(world.burstAlerts, ["promo_db", "promo_db"]);
});

/* -------------------------------------------------------------------------- */
/* Independent review, round 1                                                 */
/* -------------------------------------------------------------------------- */

/** A subscription as Checkout creates it for a zero-due promotion. */
const withPromotionSubscription = () => {
  world.cardLimit = 3;
  world.subscription = {
    ...world.subscription,
    default_payment_method: "pm_card",
    metadata: {
      ...world.subscription.metadata,
      userId: "user_1",
      promotionId: "promo_db",
      billingExpectedAmountMinor: "0",
    },
  } as Stripe.Subscription;
};

const subscriptionEvent = (type: string) =>
  ({
    id: `evt_${type}`,
    type,
    data: { object: world.subscription },
  }) as unknown as Stripe.Event;

test("the per-card count is taken under a lock on that promotion and card", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  await processStripeEvent(completedEvent(zeroDueSession()));
  // Other statements in the same flow use $executeRaw too; pick the card lock.
  const cardLocks = world.lockCalls.filter(
    ([, key]) => typeof key === "string" && key.startsWith("promotion-card:")
  );
  assert.equal(cardLocks.length, 1);
  const [strings, key] = cardLocks[0] as [TemplateStringsArray, string];
  assert.match(strings.join("?"), /pg_advisory_xact_lock/);
  assert.match(key, /^promotion-card:promo_db:[a-f0-9]{64}$/);
});

test("a paid checkout over the card limit is flagged, not cancelled", async () => {
  // Cancelling would keep the customer's money and deny the plan.
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  const paid = {
    ...(zeroDueSession("cs_paid") as unknown as Record<string, unknown>),
    amount_total: 750,
  } as unknown as Stripe.Checkout.Session;
  await processStripeEvent(completedEvent(paid));

  assert.deepEqual(world.cancels, []);
  assert.equal(world.userUpdates[0].plan, "Max");
  assert.deepEqual(flagsOf(world.redemptionRows[0]), ["shared_payment_method"]);
});

test("a database fault while deciding the card limit fails the webhook and grants nothing", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.recordFault = new Error("connection reset");
  await assert.rejects(processStripeEvent(completedEvent(zeroDueSession())));
  assert.deepEqual(world.userUpdates, []);
  assert.deepEqual(world.redemptionRows, []);
});

test("an unreadable card on a promotion checkout fails the webhook instead of passing the limit", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.paymentMethodFault = new Error("stripe unavailable");
  await assert.rejects(processStripeEvent(completedEvent(zeroDueSession())));
  assert.deepEqual(world.userUpdates, []);
});

test("a promotion switched off mid-checkout still cannot carry an over-limit card past the limit", async () => {
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.promotionActive = false;
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.equal(world.cancels.length, 1);
  assert.deepEqual(world.userUpdates, []);
  assert.equal(world.redemptionRows.length, 1);
  assert.ok(flagsOf(world.redemptionRows[0]).includes("payment_method_limit"));
  assert.equal(world.redeemedCount, 0);
});

test("a subscription event that arrives before the completion does not grant an over-limit card", async () => {
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(subscriptionEvent("customer.subscription.created"));
  assert.deepEqual(world.userUpdates, []);
});

test("a subscription event after a recorded refusal does not grant either", async () => {
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  world.cancelFailure = new Error("stripe unavailable");
  await assert.rejects(processStripeEvent(completedEvent(zeroDueSession())));
  // The cancellation is being retried; meanwhile Stripe sends an update.
  await processStripeEvent(subscriptionEvent("customer.subscription.updated"));
  assert.deepEqual(world.userUpdates, []);
});

test("a subscription event before the completion waits even with places left", async () => {
  // Review round 2: a read-only count cannot see a concurrent completion on
  // the same card, so two events could each take the last place. Only the
  // completion -- under the card lock -- decides; until then nothing is granted.
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.otherAccountsOnCard = ["user_a", "user_b"];
  await processStripeEvent(subscriptionEvent("customer.subscription.created"));
  assert.equal(world.userUpdates.length, 0);

  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(world.userUpdates.length, 1);
  assert.equal(world.userUpdates[0].plan, "Max");

  // Once the completion has granted it, later events sync as usual.
  await processStripeEvent(subscriptionEvent("customer.subscription.updated"));
  assert.equal(world.userUpdates.length, 2);
});

test("a completion after the promotion closed is granted, recorded against the card, and not counted", async () => {
  // Review round 3: completions on a closed promotion used to leave no row,
  // so they were invisible to every later card count. Several Sessions opened
  // on one card before the promotion closed could all be granted.
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.promotionActive = false;
  world.otherAccountsOnCard = ["user_a"];
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.equal(world.userUpdates.length, 1);
  assert.equal(world.redemptionRows.length, 1);
  assert.notEqual(world.redemptionRows[0].paymentMethodFingerprintHash, null);
  assert.equal(world.redeemedCount, 0);
  // The card count for that completion ran under the card lock too.
  assert.ok(
    world.lockCalls.some(
      ([, key]) => typeof key === "string" && key.startsWith("promotion-card:")
    )
  );

  await processStripeEvent(subscriptionEvent("customer.subscription.updated"));
  assert.equal(world.userUpdates.length, 2);
});

test("a completion that loses the last redemption to a concurrent one is recorded, not counted", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.promotionExhausted = true;
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(world.userUpdates[0].plan, "Max");
  assert.equal(world.redemptionRows.length, 1);
  assert.equal(world.redeemedCount, 0);
});

test("a concurrent delivery of the same completion answers with the stored decision", async () => {
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.concurrentRow = {
    riskFlags: JSON.stringify(["payment_method_limit", "shared_payment_method"]),
  };
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(world.cancels.length, 1);
  assert.deepEqual(world.userUpdates, []);
});

test("a stored grant from a concurrent delivery is kept, not re-decided", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.concurrentRow = { riskFlags: "[]" };
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.deepEqual(world.cancels, []);
  assert.equal(world.userUpdates[0].plan, "Max");
});

test("refused attempts do not use up places on the card", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  await processStripeEvent(completedEvent(zeroDueSession()));
  const cardCount = world.countWheres.find(
    (where) => "paymentMethodFingerprintHash" in where
  );
  assert.deepEqual(cardCount?.NOT, {
    riskFlags: { contains: "payment_method_limit" },
  });
});

/* -------------------------------------------------------------------------- */
/* Independent review, round 4                                                 */
/* -------------------------------------------------------------------------- */

test("a zero-charge promotion subscription waits for the completion even while its limit is off", async () => {
  // The limit can be switched off and on while a checkout is in flight; the
  // wait does not depend on the setting the sync happens to read.
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.cardLimit = null;
  await processStripeEvent(subscriptionEvent("customer.subscription.created"));
  assert.equal(world.userUpdates.length, 0);
});

test("a refusal takes back a plan the account already holds through that subscription", async () => {
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  // However it got there, the account already carries this subscription.
  world.userUpdates.push({ plan: "Max", stripeSubscriptionId: "sub_zero_due" });
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(completedEvent(zeroDueSession()));

  assert.equal(world.cancels.length, 1);
  const last = world.userUpdates.at(-1);
  assert.equal(last?.plan, "Free");
  assert.equal(last?.stripeSubscriptionId, null);
});

test("a zero-charge duplicate from an account that already redeemed through another Session is refused", async () => {
  const { processStripeEvent } = await loadProcessor();
  withPromotionSubscription();
  world.accountAlreadyRedeemed = true;
  await processStripeEvent(completedEvent(zeroDueSession("cs_second")));
  assert.equal(world.cancels.length, 1);
  assert.equal(world.userUpdates.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Independent review, round 5                                                 */
/* -------------------------------------------------------------------------- */

const cardLockKeys = () =>
  world.lockCalls
    .map(([, key]) => key)
    .filter((key): key is string => typeof key === "string" && key.startsWith("promotion-card:"));

const sessionWith = (fields: Record<string, unknown>) =>
  ({
    ...(zeroDueSession() as unknown as Record<string, unknown>),
    ...fields,
  }) as unknown as Stripe.Checkout.Session;

test("a Session SetupIntent identifies the card when the subscription has none", async () => {
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = 3;
  world.setupIntentPaymentMethod = "pm_from_setup";
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(completedEvent(sessionWith({ setup_intent: "seti_1" })));
  assert.equal(cardLockKeys().length, 1);
  assert.equal(world.cancels.length, 1);
});

test("a paid Session's PaymentIntent identifies the card too", async () => {
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = 3;
  world.paymentIntentPaymentMethod = "pm_from_payment";
  await processStripeEvent(
    completedEvent(sessionWith({ payment_intent: "pi_1", amount_total: 500 }))
  );
  assert.equal(cardLockKeys().length, 1);
});

test("a card merely attached to the customer is never taken for the one this checkout used", async () => {
  // Review round 6: it may be a different card -- counting it would let the
  // shared card through or refuse for an unrelated one.
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = 3;
  world.customerDefaultPaymentMethod = "pm_other_card";
  world.customerPaymentMethods = [
    { id: "pm_other", type: "card", card: { fingerprint: "fp_other" } },
  ];
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(cardLockKeys().length, 0);
  assert.ok(flagsOf(world.redemptionRows[0]).includes("payment_method_unverified"));
});

test("the completion releases only the lease bound to its own Session", async () => {
  // Review rounds 7-10: by Session id, so no redelivery can free a later
  // checkout's lease whatever the clocks say; an unbound (legacy) lease falls
  // back to the creation time.
  const { processStripeEvent } = await loadProcessor();
  await processStripeEvent(
    completedEvent(sessionWith({ created: SESSION_CREATED_SECONDS }))
  );
  assert.equal(world.releaseCalls.length, 1);
  assert.equal(world.releaseCalls[0].checkoutSessionId, "cs_zero");
  assert.deepEqual(
    world.releaseCalls[0].takenAtOrBefore,
    new Date(SESSION_CREATED_SECONDS * 1000)
  );
});

test("the per-card count looks back only as far as the card hash is kept", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  await processStripeEvent(completedEvent(zeroDueSession()));
  const cardCount = world.countWheres.find(
    (where) => "paymentMethodFingerprintHash" in where
  ) as { redeemedAt?: { gte?: Date } } | undefined;
  const cutoff = cardCount?.redeemedAt?.gte;
  assert.ok(cutoff instanceof Date);
  const days = (Date.now() - cutoff.getTime()) / 86_400_000;
  assert.ok(Math.abs(days - 90) < 0.01, String(days));
});

test("a zero-charge subscription's pending SetupIntent identifies the card", async () => {
  // How Stripe collects the method on a subscription that owes nothing yet.
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = 3;
  world.setupIntentPaymentMethod = "pm_from_pending_setup";
  world.subscription = {
    ...world.subscription,
    pending_setup_intent: "seti_pending",
  } as Stripe.Subscription;
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(cardLockKeys().length, 1);
  assert.equal(world.cancels.length, 1);
});

test("a checkout without a promotion does not look the card up at all", async () => {
  const { processStripeEvent } = await loadProcessor();
  withCard();
  const plain = sessionWith({
    metadata: { userId: "user_1", planId: "max", billingInterval: "monthly" },
  });
  await processStripeEvent(completedEvent(plain));
  assert.deepEqual(world.paymentMethodRetrieves, []);
  assert.equal(world.userUpdates[0].plan, "Max");
});

test("a Stripe Link payer is identified by the Link email", async () => {
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = 3;
  world.subscription = {
    ...world.subscription,
    default_payment_method: "pm_link",
  } as Stripe.Subscription;
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(cardLockKeys().length, 1);
  assert.equal(world.userUpdates[0].plan, "Max");
});

test("a limited zero-charge checkout whose payer cannot be identified is refused", async () => {
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = 3;
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.equal(world.cancels.length, 1);
  assert.deepEqual(world.userUpdates, []);
  assert.deepEqual(flagsOf(world.redemptionRows[0]).sort(), [
    "payment_method_limit",
    "payment_method_unverified",
  ]);
});

test("an unidentifiable payer is not refused when the promotion has no per-card limit", async () => {
  const { processStripeEvent } = await loadProcessor();
  world.cardLimit = null;
  await processStripeEvent(completedEvent(zeroDueSession()));
  assert.deepEqual(world.cancels, []);
  assert.equal(world.userUpdates[0].plan, "Max");
});

/* -------------------------------------------------------------------------- */
/* Independent review, round 9                                                 */
/* -------------------------------------------------------------------------- */

test("a checkout with no amount total but a zero expected amount is treated as free", async () => {
  // A missing total must not turn a free checkout into a "paid" one that the
  // per-card limit only flags.
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.otherAccountsOnCard = ["user_a", "user_b", "user_c"];
  const session = sessionWith({
    amount_total: null,
    metadata: {
      ...(zeroDueSession().metadata as Record<string, string>),
      billingExpectedAmountMinor: "0",
    },
  });
  await processStripeEvent(completedEvent(session));
  assert.equal(world.cancels.length, 1);
  assert.deepEqual(world.userUpdates, []);
});


test("the card the checkout used wins over a default changed afterwards", async () => {
  // Review round 10: the subscription default can change before a delayed
  // webhook is processed; the Session's own intent records what was used.
  const { processStripeEvent } = await loadProcessor();
  withCard();
  world.setupIntentPaymentMethod = "pm_link";
  await processStripeEvent(completedEvent(sessionWith({ setup_intent: "seti_1" })));
  const key = cardLockKeys()[0];
  assert.ok(key);
  // pm_link resolves to a Link identity, distinct from the default card's.
  world.lockCalls = [];
  world.setupIntentPaymentMethod = null;
  await processStripeEvent(completedEvent(zeroDueSession("cs_default_only")));
  assert.notEqual(cardLockKeys()[0], key);
});
