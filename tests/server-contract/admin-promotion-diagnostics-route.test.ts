import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * `POST /api/admin/billing/promotions/diagnose`.
 *
 * The route exists so an operator can investigate a promotion without creating
 * an account and pressing "Continue to payment", which on a capped promotion
 * spends a redemption and on the internal-pass path changes somebody's plan.
 * So the contract is mostly about restraint, and the assertions below are
 * mostly about what did *not* happen: no provisioning call, no checkout lease,
 * no Stripe write, no row changed, and a response that carries no secret.
 *
 * The Prisma stand-in refuses every write method rather than recording it. A
 * test that counted writes would still let one through; this one cannot.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const PROMOTION_ROW = {
  id: "promo_eddie",
  code: "EDDIEFRIEND100",
  discountPercent: 100,
  discountAmountCents: null,
  maxRedemptions: 1000,
  redeemedCount: 4,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription",
  accessDurationDays: null,
  appliesToPlanIds: JSON.stringify(["pro", "max"]),
  stripeCouponId: "cpn_live_secret",
  stripePromotionCodeId: "promo_live_secret",
  startsAt: new Date("2026-07-01T00:00:00.000Z"),
  endsAt: new Date("2026-12-01T00:00:00.000Z"),
  allowAnnualStacking: false,
  isActive: true,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const HEALTHY_LINKAGE: import("../../lib/stripePromotionProvisioning").PromotionLinkageReport = {
  promotionId: PROMOTION_ROW.id,
  code: PROMOTION_ROW.code,
  policyViolation: null,
  expectLiveMode: true,
  storedCouponId: PROMOTION_ROW.stripeCouponId,
  storedCouponExists: true,
  storedCouponMismatches: [] as string[],
  storedPromotionCodeId: PROMOTION_ROW.stripePromotionCodeId,
  storedPromotionCodeExists: true,
  storedPromotionCodeMismatches: [] as string[],
  exactCodeCandidates: [],
  recommendation: "healthy",
};

type World = {
  session: unknown;
  isAdmin: boolean;
  permissions: string[];
  rateLimitError: unknown;
  rateLimitCalls: number;
  audits: Array<{ action: string; metadata: unknown; summary: string }>;
  promotionRow: typeof PROMOTION_ROW | null;
  userRow: Record<string, unknown> | null;
  redemptionRow: { id: string } | null;
  riskGroups: Array<{ riskFlags: string; _count: { _all: number } }>;
  stripeConfigured: boolean;
  linkage: typeof HEALTHY_LINKAGE;
  linkageError: unknown;
  provisioningCalls: number;
  leaseCalls: number;
  writeAttempts: string[];
};

const freshWorld = (): World => ({
  session: { user: { id: "admin-1", email: "billing@tomverse.app" } },
  isAdmin: true,
  permissions: ["billing:write"],
  rateLimitError: null,
  rateLimitCalls: 0,
  audits: [],
  promotionRow: PROMOTION_ROW,
  userRow: null,
  redemptionRow: null,
  riskGroups: [],
  stripeConfigured: true,
  linkage: HEALTHY_LINKAGE,
  linkageError: null,
  provisioningCalls: 0,
  leaseCalls: 0,
  writeAttempts: [],
});

let world = freshWorld();
let installed = false;

/**
 * The `ApiSecurityError` class the route will actually see, captured from the
 * very object the mock is built out of.
 *
 * Not re-imported in the test body. A second `await import()` of a mocked
 * module can hand back a different copy of the class than the one
 * `apiSecurityResponse` closes over, and then its `instanceof` check fails, the
 * 429 branch is skipped, and the assertion reads as "the route answered 500"
 * when what actually happened is that the test built its error from the wrong
 * realm. That is load-order dependent, so it passed locally and failed in CI.
 */
let apiSecurityErrorClass: typeof import("../../lib/apiSecurity").ApiSecurityError;

/**
 * Any Prisma method that is not a read. Reached only if the feature grows a
 * write, which is the thing this route promises never to do.
 */
const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "$executeRaw",
  "$transaction",
];

const model = (reads: Record<string, unknown>) =>
  new Proxy(reads, {
    get(target, property: string) {
      if (WRITE_METHODS.includes(property)) {
        return async () => {
          world.writeAttempts.push(property);
          throw new Error(`Diagnostics attempted a write: ${property}`);
        };
      }
      return target[property];
    },
  });

async function loadRoute(): Promise<{
  POST: (request: Request) => Promise<Response>;
}> {
  if (!installed) {
    installed = true;
    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.isAdmin,
        hasAdminPermission: (_session: unknown, permission: string) =>
          world.permissions.includes(permission),
      },
    });
    mock.module(mod("lib/adminAudit.ts"), {
      namedExports: {
        writeAdminAuditLog: async (entry: {
          action: string;
          metadata: unknown;
          summary: string;
        }) => {
          world.audits.push({
            action: entry.action,
            metadata: entry.metadata,
            summary: entry.summary,
          });
        },
      },
    });
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
      string,
      unknown
    >;
    apiSecurityErrorClass =
      realApiSecurity.ApiSecurityError as typeof apiSecurityErrorClass;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => {
          world.rateLimitCalls += 1;
          if (world.rateLimitError) throw world.rateLimitError;
        },
      },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          billingPromotion: model({
            findUnique: async () => world.promotionRow,
            findMany: async () => (world.promotionRow ? [world.promotionRow] : []),
          }),
          billingPromotionRedemption: model({
            findUnique: async () => world.redemptionRow,
            groupBy: async () => world.riskGroups,
          }),
          user: model({ findUnique: async () => world.userRow }),
          billingPlan: model({ findMany: async () => [] }),
          appSetting: model({ findUnique: async () => null }),
        },
      },
    });
    mock.module(mod("lib/stripe.ts"), {
      namedExports: {
        isStripeConfigured: () => world.stripeConfigured,
        getStripe: () => {
          throw new Error("Diagnostics must not construct a Stripe client.");
        },
        stripeKeyLiveMode: () => true,
      },
    });
    mock.module(mod("lib/stripePromotionProvisioning.ts"), {
      namedExports: {
        inspectStripePromotionLinkage: async () => {
          if (world.linkageError) throw world.linkageError;
          return world.linkage;
        },
        // Present so a call would be visible rather than a module-resolution
        // error. It must stay at zero.
        ensureStripePromotionDiscount: async () => {
          world.provisioningCalls += 1;
          throw new Error("Diagnostics must not provision.");
        },
        StripePromotionProvisioningError: class extends Error {},
      },
    });
    const realSecurity = require(
      resolve(ROOT, "lib/billingPromotionSecurity.ts")
    ) as Record<string, unknown>;
    mock.module(mod("lib/billingPromotionSecurity.ts"), {
      namedExports: {
        ...realSecurity,
        reservePromotionCheckout: async () => {
          world.leaseCalls += 1;
          throw new Error("Diagnostics must not reserve a checkout lease.");
        },
        releasePromotionCheckout: async () => {
          world.leaseCalls += 1;
          throw new Error("Diagnostics must not release a checkout lease.");
        },
        validatePromotionForCheckout: async () => {
          throw new Error(
            "Diagnostics must not run the request-scoped validator."
          );
        },
      },
    });
  }
  return import(
    mod("app/api/admin/billing/promotions/diagnose/route.ts")
  ) as Promise<{ POST: (request: Request) => Promise<Response> }>;
}

const post = async (body: unknown) => {
  const { POST } = await loadRoute();
  return POST(
    new Request("https://tomverse.app/api/admin/billing/promotions/diagnose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
};

const VALID_BODY = {
  promotionId: "promo_eddie",
  planId: "pro",
  billingInterval: "monthly",
};

test.beforeEach(() => {
  world = freshWorld();
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

test("a signed-out caller gets 404, not 401", async () => {
  world.session = null;
  const response = await post(VALID_BODY);
  assert.equal(response.status, 404);
  assert.equal(world.audits.length, 0);
});

test("a signed-in non-admin gets 404, so the route is not discoverable", async () => {
  world.isAdmin = false;
  assert.equal((await post(VALID_BODY)).status, 404);
});

test("readonly, support and ops are refused the billing diagnosis", async () => {
  for (const permission of ["ops:write", "support:write", "audit:read"]) {
    world = freshWorld();
    world.permissions = [permission];
    const response = await post(VALID_BODY);
    assert.equal(response.status, 403, permission);
    assert.equal(world.audits.length, 0, permission);
  }
});

test("owner and billing are allowed", async () => {
  world.permissions = ["billing:write"];
  assert.equal((await post(VALID_BODY)).status, 200);
});

/* -------------------------------------------------------------------------- */
/* Input contract                                                              */
/* -------------------------------------------------------------------------- */

test("a payload naming a Stripe object is refused by the schema", async () => {
  // The body may not carry a Stripe id. Accepting one would turn an
  // authenticated console into a general-purpose reader of the Stripe account.
  const response = await post({
    ...VALID_BODY,
    stripePromotionCodeId: "promo_anything",
  });
  assert.equal(response.status, 400);
});

test("a body with neither a promotion id nor a code is refused", async () => {
  assert.equal(
    (await post({ planId: "pro", billingInterval: "monthly" })).status,
    400
  );
});

test("an unknown plan or interval is refused", async () => {
  assert.equal(
    (await post({ ...VALID_BODY, planId: "enterprise" })).status,
    400
  );
  assert.equal(
    (await post({ ...VALID_BODY, billingInterval: "weekly" })).status,
    400
  );
});

test("an unknown promotion is 404 and writes no audit entry", async () => {
  world.promotionRow = null;
  const response = await post({ ...VALID_BODY, code: "NOPE" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    code: "PROMOTION_NOT_FOUND",
    error: "Promotion not found.",
  });
  assert.equal(world.audits.length, 0);
});

test("the rate limit is consumed before any read", async () => {
  await loadRoute();
  // `apiSecurityErrorClass`, never a fresh `await import()` of the mocked
  // module: see the note where it is captured.
  world.rateLimitError = new apiSecurityErrorClass(
    429,
    "RATE_LIMITED",
    "Too many requests."
  );
  const response = await post(VALID_BODY);
  assert.equal(response.status, 429);
  assert.equal(world.audits.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Response shape and headers                                                  */
/* -------------------------------------------------------------------------- */

test("the response is private and never stored", async () => {
  const response = await post(VALID_BODY);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0"
  );
});

test("a configuration-only run reports the account checks as not evaluated", async () => {
  const body = (await (await post(VALID_BODY)).json()) as {
    accountSelected: boolean;
    report: {
      account: { evaluated: boolean; checks: { reason: string | null }[] };
      abuseSignals: { evaluated: boolean; reason: string };
    };
  };
  assert.equal(body.accountSelected, false);
  assert.equal(body.report.account.evaluated, false);
  assert.equal(body.report.account.checks[0].reason, "no_account_selected");
  // And the abuse layer is always reported as not evaluated, because the
  // request's IP is the operator's.
  assert.equal(body.report.abuseSignals.evaluated, false);
  assert.equal(
    body.report.abuseSignals.reason,
    "admin_request_ip_is_not_the_customer_ip"
  );
});

test("an account-specific run reads the existing account and finds it already used", async () => {
  world.userRow = {
    id: "user-1",
    plan: "Free",
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    subscriptionCurrentPeriodEnd: null,
  };
  world.redemptionRow = { id: "redemption-1" };
  const body = (await (
    await post({ ...VALID_BODY, userId: "user-1" })
  ).json()) as {
    report: { status: string; account: { checks: { id: string; reason: string | null }[] } };
  };
  assert.equal(body.report.status, "blocked");
  assert.ok(
    body.report.account.checks.some((item) => item.reason === "already_used")
  );
});

test("an unconfigured Stripe still answers, with the linkage not checked", async () => {
  world.stripeConfigured = false;
  const response = await post(VALID_BODY);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    report: { stripe: { status: string; checks: { reason: string | null }[] } };
  };
  assert.equal(body.report.stripe.status, "not_checked");
  assert.equal(body.report.stripe.checks[0].reason, "stripe_not_configured");
});

test("a Stripe read that throws is reported without the provider's own words", async () => {
  world.linkageError = Object.assign(
    new Error("No such coupon: cpn_live_secret"),
    { type: "StripeInvalidRequestError", requestId: "req_secret" }
  );
  const response = await post(VALID_BODY);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes("cpn_live_secret"), false);
  assert.equal(text.includes("req_secret"), false);
  assert.match(text, /PROMOTION_DIAGNOSTICS_FAILED/);
});

test("the response carries no Stripe secret and no customer identity", async () => {
  world.userRow = {
    id: "user-1",
    plan: "Free",
    stripeSubscriptionId: "sub_123",
    subscriptionStatus: "canceled",
    subscriptionCurrentPeriodEnd: null,
  };
  const text = await (await post({ ...VALID_BODY, userId: "user-1" })).text();
  for (const forbidden of [
    "sk_live",
    "sk_test",
    "STRIPE_SECRET_KEY",
    "@tomverse.app",
    "checkout.stripe.com",
    "sub_123",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

/* -------------------------------------------------------------------------- */
/* Read-only guarantee                                                         */
/* -------------------------------------------------------------------------- */

test("running diagnostics provisions nothing and leases nothing", async () => {
  assert.equal((await post(VALID_BODY)).status, 200);
  assert.equal(world.provisioningCalls, 0);
  assert.equal(world.leaseCalls, 0);
  assert.deepEqual(world.writeAttempts, []);
});

test("repeated runs leave the promotion, redemptions and linkage untouched", async () => {
  const before = JSON.stringify(world.promotionRow);
  world.userRow = {
    id: "user-1",
    plan: "Free",
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    subscriptionCurrentPeriodEnd: null,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await post({ ...VALID_BODY, userId: "user-1" })).status, 200);
  }
  assert.equal(JSON.stringify(world.promotionRow), before);
  assert.equal(world.redemptionRow, null);
  assert.deepEqual(world.writeAttempts, []);
  assert.equal(world.provisioningCalls, 0);
});

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

test("one successful run writes exactly one audit entry", async () => {
  await post(VALID_BODY);
  assert.equal(world.audits.length, 1);
  const entry = world.audits[0];
  assert.equal(entry.action, "promotion.diagnostics.executed");
  const metadata = entry.metadata as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata).sort(), [
    "billingInterval",
    "mode",
    "planId",
    "promotionId",
    "reasonSlugs",
    "status",
    "targetUserId",
  ]);
  assert.equal(metadata.mode, "configuration_only");
  assert.equal(metadata.targetUserId, null);
});

test("the audit entry names the account by internal id and nothing else", async () => {
  world.userRow = {
    id: "user-1",
    plan: "Free",
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    subscriptionCurrentPeriodEnd: null,
  };
  await post({ ...VALID_BODY, userId: "user-1" });
  const metadata = world.audits[0].metadata as Record<string, unknown>;
  assert.equal(metadata.mode, "account_specific");
  assert.equal(metadata.targetUserId, "user-1");
  // No Stripe object id, no whole payload, no email.
  const serialized = JSON.stringify(world.audits[0]);
  assert.equal(serialized.includes("cpn_live_secret"), false);
  assert.equal(serialized.includes("promo_live_secret"), false);
  assert.equal(serialized.includes("localPolicy"), false);
});

test("a stored coupon that no longer matches is reported as a blocker", async () => {
  // The state found in staging: a coupon created by hand in the Stripe
  // dashboard, stored against the promotion. The linkage report used to answer
  // "create_missing_objects" here, so the console said there was nothing in
  // Stripe over an object that refuses every checkout.
  world.linkage = {
    ...HEALTHY_LINKAGE,
    storedCouponExists: true,
    storedCouponMismatches: [
      "identity:duration",
      "identity:duration_in_months",
      "identity:metadata_promotion_id",
    ],
    storedPromotionCodeId: null,
    storedPromotionCodeExists: false,
    recommendation: "manual_review",
  };
  const body = (await (await post(VALID_BODY)).json()) as {
    report: {
      status: string;
      stripe: { checks: { id: string; reason: string | null }[] };
      recommendedActions: { id: string }[];
    };
  };
  assert.equal(body.report.status, "blocked");
  assert.equal(
    body.report.stripe.checks.find((item) => item.id === "stored_coupon")
      ?.reason,
    "stored_coupon_mismatch"
  );
  assert.ok(
    body.report.recommendedActions.some(
      (item) => item.id === "conflicting_active_code_requires_operator_review"
    )
  );
});
