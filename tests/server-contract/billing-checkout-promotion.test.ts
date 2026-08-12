import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Server-side contract for /api/billing/checkout: the promotion path, and the
 * three refusals that keep this endpoint from becoming a plan-change flow.
 *
 * The regression this exists for: a Max checkout with a valid promotion code
 * answered 500 for every customer, because the Session was created with both
 * `allow_promotion_codes` and `discounts`. Stripe rejects that combination on
 * the parameters being *present*, not on their values, so sending `false`
 * beside a discount failed exactly like sending `true`. The customer saw an
 * unexplained `CHECKOUT_CONFIGURATION_ERROR` and the log carried one line with
 * no promotion, plan or trace on it.
 *
 * What must hold:
 *   - a promotion checkout sends `discounts` and does *not* send
 *     `allow_promotion_codes`, and a checkout without one still opts out
 *     explicitly, so the Stripe-side code entry box is never reachable;
 *   - the same purchase attempt retried reuses one Session; a new attempt gets
 *     a new one;
 *   - promotion configuration failures answer 4xx with a trace id rather than a
 *     500, and never carry a Stripe object id or message;
 *   - the promotion lease is released on every failure, so a customer is not
 *     locked out for 31 minutes by an attempt that never got anywhere;
 *   - a second concurrent checkout is refused with 409, not 500;
 *   - buying the plan already held, downgrading, and upgrading while a
 *     subscription is live are each refused with 409 and reach no Stripe, so a
 *     plan change cannot be driven through new-subscription checkout.
 *
 * Only the session, rate limiter, Prisma, Stripe and the promotion security
 * layer are replaced. The route's own branching and its zod schema are real.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "checkout-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.PUBLIC_APP_URL ||= "http://127.0.0.1:3100";
process.env.STRIPE_SECRET_KEY ||= "sk_test_contract";

const ENDS_AT = "2026-12-31T00:00:00.000Z";

type SessionCreateCall = {
  params: Record<string, unknown>;
  options: { idempotencyKey?: string } | undefined;
};

type World = {
  session: { user: { id: string } } | null;
  user: Record<string, unknown>;
  promotionValid: boolean;
  promotionReserveError: Error | null;
  releases: string[];
  releaseShouldFail: boolean;
  discountResult: { discount: unknown; driftReasons: string[] } | null;
  discountError: Error | null;
  sessionCreateCalls: SessionCreateCall[];
  sessionCreateError: Error | null;
  /** idempotencyKey -> session id, mimicking Stripe's 24h replay. */
  sessionReplay: Map<string, string>;
  customerCreateKeys: string[];
  logs: { message: string; payload: unknown }[];
};

const freshWorld = (): World => ({
  session: { user: { id: "user_1" } },
  user: {
    id: "user_1",
    email: "buyer@example.com",
    name: "Buyer",
    stripeCustomerId: "cus_existing",
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    subscriptionCurrentPeriodEnd: null,
    plan: "Free",
    creditDebtCredits: 0,
    settings: { language: "en" },
  },
  promotionValid: true,
  promotionReserveError: null,
  releases: [],
  releaseShouldFail: false,
  discountResult: {
    discount: { promotion_code: "promo_live" },
    driftReasons: [],
  },
  discountError: null,
  sessionCreateCalls: [],
  sessionCreateError: null,
  sessionReplay: new Map(),
  customerCreateKeys: [],
  logs: [],
});

let world = freshWorld();
let mocksInstalled = false;
let sessionSequence = 0;

const PROMOTION = {
  id: "promo_db",
  code: "EDDIEFRIEND100",
  discountPercent: 100,
  discountAmountCents: null,
  maxRedemptions: 1000,
  redeemedCount: 0,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription" as const,
  accessDurationDays: null,
  appliesToPlanIds: ["max"],
  stripeCouponId: "cpn_live",
  stripePromotionCodeId: "promo_live",
  startsAt: null,
  endsAt: ENDS_AT,
  allowAnnualStacking: false,
  isActive: true,
};

/**
 * The error classes the route will actually see, captured from the very
 * objects the mocks are built out of.
 *
 * Not re-imported in the test body. A second `await import()` of a mocked
 * module can hand back a different copy of the class than the one the route
 * holds, and then the route's `instanceof` check fails, the classified branch
 * is skipped, and the assertion reads as "the route answered 500" when what
 * actually happened is that the test built its error from the wrong realm.
 * That is load-order dependent, so it passes locally and fails in CI.
 */
let apiSecurityErrorClass: typeof import("../../lib/apiSecurity").ApiSecurityError;
let provisioningErrorClass: typeof import("../../lib/stripePromotionProvisioning").StripePromotionProvisioningError;

async function loadRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
}> {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: { getServerSession: async () => world.session },
    });

    const realApiSecurity = original("lib/apiSecurity.ts");
    apiSecurityErrorClass =
      realApiSecurity.ApiSecurityError as typeof apiSecurityErrorClass;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => undefined,
      },
    });

    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          user: {
            findUnique: async () => world.user,
            update: async () => world.user,
            updateMany: async () => ({ count: 1 }),
          },
          billingPromotion: { updateMany: async () => ({ count: 1 }) },
        },
      },
    });

    // The localized price catalogue lives in an app setting and is read on
    // every checkout. Served from its own built-in defaults here so this file
    // stays about the promotion branching rather than the price table.
    const realPriceCatalog = original("lib/billingPriceCatalog.ts") as {
      DEFAULT_BILLING_PRICE_CATALOG: unknown;
    };
    mock.module(mod("lib/billingPriceCatalog.ts"), {
      namedExports: {
        ...realPriceCatalog,
        getBillingPriceCatalog: async () =>
          realPriceCatalog.DEFAULT_BILLING_PRICE_CATALOG,
        getUsdRevenueSnapshot: async ({
          amountMinor,
        }: {
          amountMinor: number;
        }) => ({
          amountUsdMicroUsd: BigInt(amountMinor) * BigInt(10_000),
          usdConversionRate: "1",
          source: "contract_test",
        }),
      },
    });

    const realPromotionSecurity = original("lib/billingPromotionSecurity.ts");
    mock.module(mod("lib/billingPromotionSecurity.ts"), {
      namedExports: {
        ...realPromotionSecurity,
        validatePromotionForCheckout: async () =>
          world.promotionValid
            ? {
                valid: true,
                promotion: PROMOTION,
                clientIpHash: "a".repeat(64),
                riskFlags: [],
              }
            : { valid: false, reason: "expired" },
        reservePromotionCheckout: async () => {
          if (world.promotionReserveError) throw world.promotionReserveError;
          return { id: "lease", expiresAt: new Date() };
        },
        releasePromotionCheckout: async (promotionId: string) => {
          if (world.releaseShouldFail) throw new Error("lease store offline");
          world.releases.push(promotionId);
        },
      },
    });

    const realProvisioning = original("lib/stripePromotionProvisioning.ts");
    provisioningErrorClass =
      realProvisioning.StripePromotionProvisioningError as typeof provisioningErrorClass;
    mock.module(mod("lib/stripePromotionProvisioning.ts"), {
      namedExports: {
        ...realProvisioning,
        ensureStripePromotionDiscount: async () => {
          if (world.discountError) throw world.discountError;
          return world.discountResult;
        },
      },
    });

    mock.module(mod("lib/stripe.ts"), {
      namedExports: {
        isStripeConfigured: () => true,
        getStripe: () => ({
          customers: {
            create: async (
              _params: unknown,
              options?: { idempotencyKey?: string }
            ) => {
              world.customerCreateKeys.push(options?.idempotencyKey || "");
              return { id: "cus_created" };
            },
          },
          checkout: {
            sessions: {
              create: async (
                params: Record<string, unknown>,
                options?: { idempotencyKey?: string }
              ) => {
                world.sessionCreateCalls.push({ params, options });
                if (world.sessionCreateError) throw world.sessionCreateError;
                const key = options?.idempotencyKey || "";
                const replayed = world.sessionReplay.get(key);
                if (replayed) {
                  return {
                    id: replayed,
                    url: `https://stripe.test/${replayed}`,
                  };
                }
                sessionSequence += 1;
                const id = `cs_${sessionSequence}`;
                world.sessionReplay.set(key, id);
                return { id, url: `https://stripe.test/${id}` };
              },
            },
          },
        }),
      },
    });

    // Plans and pricing come from the database in production; pinned here so
    // the test is about the checkout branching rather than the catalogue.
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
            stripePriceId: null,
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
          // The lower tier exists so a downgrade has somewhere to point. The
          // promotion tests above never reach it.
          {
            id: "pro",
            name: "Pro",
            tier: "Pro",
            monthlyPriceCents: 1500,
            annualPriceCents: 14400,
            currency: "USD",
            stripeProductId: "prod_pro",
            stripePriceId: null,
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
        ],
      },
    });

    mock.module(mod("lib/productAnalyticsServer.ts"), {
      namedExports: {
        ...original("lib/productAnalyticsServer.ts"),
        recordProductAnalyticsEvent: async () => undefined,
      },
    });
  }

  return (await import(
    mod("app/api/billing/checkout/route.ts")
  )) as unknown as { POST: (request: Request) => Promise<Response> };
}

const post = async (body: Record<string, unknown>) => {
  const { POST } = await loadRoute();
  return POST(
    new Request("http://127.0.0.1:3100/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: "max",
        billingInterval: "monthly",
        currency: "USD",
        country: "US",
        ...body,
      }),
    })
  );
};

test.beforeEach(() => {
  const replay = world.sessionReplay;
  world = freshWorld();
  world.sessionReplay = replay;
});

const lastSessionParams = () =>
  world.sessionCreateCalls.at(-1)?.params as Record<string, unknown>;

test("a promotion checkout sends discounts and never sends allow_promotion_codes beside it", async () => {
  // The exact production failure. Stripe rejects a Session carrying both, so a
  // discount and the opt-out flag are mutually exclusive on the wire.
  const response = await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /^https:\/\/stripe\.test\//);

  const params = lastSessionParams();
  assert.deepEqual(params.discounts, [{ promotion_code: "promo_live" }]);
  assert.equal(
    Object.hasOwn(params, "allow_promotion_codes"),
    false,
    "sending the flag beside a discount is the 400 that broke promotion checkout"
  );
});

test("a checkout without a promotion still opts out of the Stripe code box explicitly", async () => {
  // The security guarantee the flag exists for: a customer must never be able
  // to type a code into Stripe and bypass server-side validation.
  const response = await post({
    purchaseAttemptId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(response.status, 200);
  const params = lastSessionParams();
  assert.equal(params.allow_promotion_codes, false);
  assert.equal(params.discounts, undefined);
});

test("the promotion id, never the customer's typed code, reaches Stripe metadata", async () => {
  await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "33333333-3333-4333-8333-333333333333",
  });
  const metadata = lastSessionParams().metadata as Record<string, string>;
  assert.equal(metadata.promotionId, "promo_db");
  assert.equal(
    Object.values(metadata).includes("EDDIEFRIEND100"),
    false,
    "a client-supplied code string must not become the discount Stripe applies"
  );
});

test("retrying one purchase attempt reuses a Session; a new attempt gets a new one", async () => {
  const attempt = "44444444-4444-4444-8444-444444444444";
  const first = await (await post({ purchaseAttemptId: attempt })).json();
  const retry = await (await post({ purchaseAttemptId: attempt })).json();
  assert.equal(
    first.url,
    retry.url,
    "a network retry of the same submission must not mint a second Session"
  );

  const second = await (
    await post({ purchaseAttemptId: "55555555-5555-4555-8555-555555555555" })
  ).json();
  assert.notEqual(
    first.url,
    second.url,
    "a deliberate second attempt must not replay a Session that may have expired"
  );
});

test("the idempotency key carries no account identifier", async () => {
  await post({ purchaseAttemptId: "66666666-6666-4666-8666-666666666666" });
  const key = world.sessionCreateCalls.at(-1)?.options?.idempotencyKey || "";
  assert.ok(key.length > 0);
  assert.equal(key.includes("user_1"), false);
  assert.ok(key.includes("66666666-6666-4666-8666-666666666666"));
});

test("a first-time customer is created under a per-account idempotency key", async () => {
  world.user = { ...world.user, stripeCustomerId: null };
  const response = await post({
    purchaseAttemptId: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(response.status, 200);
  assert.equal(world.customerCreateKeys.length, 1);
  assert.ok(
    world.customerCreateKeys[0].startsWith("tomverse:billing-customer:")
  );
  assert.equal(world.customerCreateKeys[0].includes("user_1"), false);
});

test("a promotion configuration failure answers 4xx with a trace id, not a 500", async () => {
  await loadRoute();
  world.discountError = new provisioningErrorClass(
    "PROMOTION_CODE_CONFLICT",
    "promotion_code",
    { stripePromotionCodeId: "promo_someone_else" }
  );
  const response = await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "88888888-8888-4888-8888-888888888888",
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "PROMOTION_UNAVAILABLE");
  assert.match(body.traceId, /^[0-9a-f-]{36}$/);
  // Nothing internal escapes: no Stripe object id, no Stripe error text.
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("promo_someone_else"), false);
  assert.doesNotMatch(serialised, /stripe|coupon|cpn_/i);
  // The Session was never attempted, and the lease was handed back.
  assert.equal(world.sessionCreateCalls.length, 0);
  assert.deepEqual(world.releases, ["promo_db"]);
});

test("a Stripe outage is a retryable 503 while a rejected request stays a 500", async () => {
  world.sessionCreateError = Object.assign(new Error("connection reset"), {
    type: "StripeConnectionError",
  });
  const outage = await post({
    purchaseAttemptId: "99999999-9999-4999-8999-999999999999",
  });
  assert.equal(outage.status, 503);
  assert.equal((await outage.json()).code, "CHECKOUT_TEMPORARILY_UNAVAILABLE");

  world.sessionCreateError = Object.assign(new Error("bad parameter"), {
    type: "StripeInvalidRequestError",
    statusCode: 400,
    requestId: "req_bad",
  });
  const rejected = await post({
    purchaseAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(rejected.status, 500);
  const body = await rejected.json();
  assert.equal(body.code, "CHECKOUT_CONFIGURATION_ERROR");
  assert.match(body.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(body).includes("req_bad"), false);
});

test("a failed Session create hands the promotion lease back", async () => {
  world.sessionCreateError = Object.assign(new Error("nope"), {
    type: "StripeInvalidRequestError",
    statusCode: 400,
  });
  const response = await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(response.status, 500);
  assert.deepEqual(
    world.releases,
    ["promo_db"],
    "a lease that outlives its attempt locks the customer out for its full TTL"
  );
});

test("a lease release that itself fails still answers the customer", async () => {
  world.sessionCreateError = Object.assign(new Error("nope"), {
    type: "StripeInvalidRequestError",
    statusCode: 400,
  });
  world.releaseShouldFail = true;
  const response = await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  // The lock is real now and only time will clear it, but the customer gets a
  // classified answer rather than a hung request.
  assert.equal(response.status, 500);
  assert.match((await response.json()).traceId, /^[0-9a-f-]{36}$/);
});

test("a second concurrent checkout on the same promotion is a 409, not a 500", async () => {
  await loadRoute();
  world.promotionReserveError = new apiSecurityErrorClass(
    409,
    "PROMOTION_CHECKOUT_IN_PROGRESS",
    "A checkout using this promotion is already in progress."
  );
  const response = await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PROMOTION_CHECKOUT_IN_PROGRESS");
  assert.equal(world.sessionCreateCalls.length, 0);
});

test("an ineligible promotion is refused before Stripe is touched at all", async () => {
  world.promotionValid = false;
  const response = await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PROMOTION_EXPIRED");
  assert.equal(world.sessionCreateCalls.length, 0);
  assert.deepEqual(world.releases, []);
});

test("a promotion checkout expires inside the window Stripe accepts", async () => {
  // Stripe requires 30 minutes to 24 hours from now; the promotion lease TTL
  // has to stay inside that or every promotion checkout is refused again.
  await post({
    promoCode: "EDDIEFRIEND100",
    purchaseAttemptId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  const expiresAt = lastSessionParams().expires_at as number;
  const seconds = expiresAt - Math.floor(Date.now() / 1000);
  assert.ok(
    seconds >= 30 * 60,
    `expires_at must be >= 30 minutes out, got ${seconds}s`
  );
  assert.ok(seconds <= 24 * 60 * 60, "expires_at must be <= 24 hours out");
});

/* --------------------------------------- the three plan-transition refusals */

/**
 * `/api/billing/checkout` creates *new* subscriptions and nothing else.
 * docs/policy/plan-change.md and AGENTS.md both say the three 409s below stay
 * exactly as they are, and give the reason: relax any of them and a plan
 * change can be driven through new-subscription checkout, leaving one account
 * paying for two plans at once.
 *
 * Until now the refusals were covered on either side of the route but not
 * through it: tests/planChangeStateMachine.test.mjs exercises the dedicated
 * plan-change module, and tests/purchaseIntent.test.mjs asserts how the client
 * classifies a 409 it is handed. Neither makes the route emit one.
 *
 * The fourth case is the one a careless fix breaks in the opposite direction.
 * The guard reads `effectivePlanForAccess`, not `user.plan`, because an
 * expired Founding Tester Pass leaves the column at "Pro" while the account
 * has nothing — and refusing that customer's purchase is as wrong as allowing
 * a duplicate one.
 */

const FOUNDING_TESTER_PASS_STATUS = "founding_tester_pass";
const DAY_MS = 24 * 60 * 60 * 1000;

test("buying the plan the account already holds is refused, and reaches no Stripe", async () => {
  world.user = { ...world.user, plan: "Max" };

  const response = await post({ planId: "max" });
  assert.equal(response.status, 409);
  assert.deepEqual(
    { code: (await response.json()).code },
    { code: "PLAN_CHANGE_NOT_SUPPORTED" }
  );
  assert.deepEqual(world.sessionCreateCalls, []);
});

test("a downgrade is refused rather than sold as a second subscription", async () => {
  // Max buying Pro. Creating this Session would leave the customer paying for
  // both, because nothing cancels the first one.
  world.user = { ...world.user, plan: "Max" };

  const response = await post({ planId: "pro" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PLAN_CHANGE_NOT_SUPPORTED");
  assert.deepEqual(world.sessionCreateCalls, []);
});

test("an upgrade while a subscription is live is refused as a change, not sold", async () => {
  world.user = {
    ...world.user,
    plan: "Pro",
    stripeSubscriptionId: "sub_live",
    subscriptionStatus: "active",
  };

  const response = await post({ planId: "max" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ACTIVE_SUBSCRIPTION_EXISTS");
  assert.deepEqual(world.sessionCreateCalls, []);
});

test("past_due counts as live: the upgrade is still a change", async () => {
  // A lapsed card is a payment problem, not an absent subscription. Selling a
  // second one here would bill the customer twice for one product.
  world.user = {
    ...world.user,
    plan: "Pro",
    stripeSubscriptionId: "sub_live",
    subscriptionStatus: "past_due",
  };

  const response = await post({ planId: "max" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ACTIVE_SUBSCRIPTION_EXISTS");
});

test("an expired Founding Tester Pass does not block the purchase it looks like", async () => {
  // `plan` still reads "Pro" and the account has nothing. Reading the column
  // instead of the effective plan would refuse a customer trying to pay.
  world.user = {
    ...world.user,
    plan: "Pro",
    subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
    subscriptionCurrentPeriodEnd: new Date(Date.now() - DAY_MS),
  };

  const response = await post({ planId: "pro" });
  assert.equal(response.status, 200);
  assert.equal(world.sessionCreateCalls.length, 1);
});

test("a pass that has not expired still blocks buying the tier it grants", async () => {
  // The complement of the case above: the guard is reading the effective plan,
  // not ignoring the column.
  world.user = {
    ...world.user,
    plan: "Pro",
    subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
    subscriptionCurrentPeriodEnd: new Date(Date.now() + DAY_MS),
  };

  const response = await post({ planId: "pro" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PLAN_CHANGE_NOT_SUPPORTED");
});
