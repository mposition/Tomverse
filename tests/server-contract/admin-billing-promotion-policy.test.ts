import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * `PATCH /api/admin/billing`, and the fixed-amount promotion block it carries.
 *
 * The unit tests next door prove the matrix in
 * docs/policy/promotion-discount-currency.md section 4. What this file proves
 * is that the endpoint reaches it -- section 6 says the block applies to the
 * Admin API and not only the Admin UI, because the panel is not the only client
 * this endpoint has, and a rule enforced in a React component is enforced
 * nowhere.
 *
 * Two things beyond the verdict matter here and are asserted directly:
 *
 * - A refused save writes *nothing*. The panel PATCHes plans, prices and
 *   promotions together, so a refusal that had already upserted the plans
 *   would leave the admin with a half-applied form and no way to tell which
 *   half.
 * - An allowed narrowing edit still works. Deactivating a live fixed-amount
 *   promotion is the edit an operator most needs, and a block that took it away
 *   would leave a promotion nothing could switch off.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const FIXED_ROW = {
  id: "promo_paymenttest27",
  code: "PAYMENTTEST27",
  discountPercent: 0,
  discountAmountCents: 1400,
  maxRedemptions: 100,
  redeemedCount: 3,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription",
  accessDurationDays: null,
  appliesToPlanIds: JSON.stringify(["pro"]),
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: new Date("2026-07-01T00:00:00.000Z"),
  endsAt: new Date("2026-09-01T00:00:00.000Z"),
  allowAnnualStacking: false,
  isActive: false,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

/** The payload shape the Admin panel sends for a promotion. */
const payload = (overrides: Record<string, unknown> = {}) => ({
  id: FIXED_ROW.id,
  code: FIXED_ROW.code,
  discountPercent: 0,
  discountAmountCents: 1400,
  maxRedemptions: 100,
  redeemedCount: 3,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription" as const,
  accessDurationDays: null,
  appliesToPlanIds: ["pro"],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: "2026-07-01T00:00:00.000Z",
  endsAt: "2026-09-01T00:00:00.000Z",
  allowAnnualStacking: false,
  isActive: false,
  ...overrides,
});

type World = {
  session: unknown;
  isAdmin: boolean;
  permissions: string[];
  promotionRows: (typeof FIXED_ROW)[];
  writes: string[];
  audits: number;
};

const freshWorld = (): World => ({
  session: { user: { id: "admin-1", email: "billing@tomverse.app" } },
  isAdmin: true,
  permissions: ["billing:write"],
  promotionRows: [FIXED_ROW],
  writes: [],
  audits: 0,
});

let world = freshWorld();
let installed = false;

/**
 * Records every write instead of performing one.
 *
 * The route's success path is not what this file is about, so the stand-in
 * answers writes rather than refusing them: an allowed save has to get all the
 * way through, and a refused one has to leave this list empty.
 */
const model = (name: string, reads: Record<string, unknown>) =>
  new Proxy(reads, {
    get(target, property: string) {
      if (property in target) return target[property];
      return async () => {
        world.writes.push(`${name}.${property}`);
        return { count: 0 };
      };
    },
  });

async function loadRoute() {
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
        writeAdminAuditLog: async () => {
          world.audits += 1;
        },
      },
    });
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
      string,
      unknown
    >;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/appSettings.ts"), {
      namedExports: {
        getPublicAppSettings: async () => ({}),
        isValidGuestDefaultModel: () => true,
        updateGuestDefaultModel: async () => {},
      },
    });
    mock.module(mod("lib/billingConfig.ts"), {
      namedExports: {
        getBillingPlans: async () => [],
        getBillingPromotions: async () => [],
        syncBillingDefaultsToDatabase: async () => {},
      },
    });
    const realCatalog = require(
      resolve(ROOT, "lib/billingPriceCatalog.ts")
    ) as Record<string, unknown>;
    mock.module(mod("lib/billingPriceCatalog.ts"), {
      namedExports: {
        ...realCatalog,
        getBillingPriceCatalogWithMeta: async () => ({
          catalog: {},
          updatedAt: null,
        }),
        saveBillingPriceCatalog: async () => {},
      },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          billingPlan: model("billingPlan", { findMany: async () => [] }),
          billingPromotion: model("billingPromotion", {
            findMany: async () => world.promotionRows,
          }),
          appSetting: model("appSetting", { findUnique: async () => null }),
        },
      },
    });
  }
  return import(mod("app/api/admin/billing/route.ts")) as Promise<{
    PATCH: (request: Request) => Promise<Response>;
  }>;
}

const patch = async (body: unknown) => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    new Request("https://tomverse.app/api/admin/billing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return {
    response,
    body: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
};

test.beforeEach(() => {
  world = freshWorld();
});

test("creating a fixed-amount promotion is refused, and nothing is written", async () => {
  world.promotionRows = [];
  const { response, body } = await patch({
    promotions: [payload({ id: "promo_newfixed", code: "NEWFIXED", isActive: true })],
  });

  assert.equal(response.status, 400);
  assert.equal(body?.code, "PROMOTION_FIXED_AMOUNT_BLOCKED");
  assert.match(String(body?.error), /NEWFIXED/);
  assert.deepEqual(world.writes, []);
});

test("a refused promotion aborts the whole save, plans and prices included", async () => {
  world.promotionRows = [];
  const { response } = await patch({
    plans: [
      {
        id: "pro",
        monthlyPriceCents: 1_500,
        annualPriceCents: 18_000,
        dailyMessageLimit: 100,
        monthlyMessageLimit: 3_000,
        maxModels: 3,
        allowAttachments: true,
        allowSharing: true,
        allowDownloads: true,
        isActive: true,
        stripeProductId: null,
        stripePriceId: null,
        stripeAnnualPriceId: null,
      },
    ],
    promotions: [payload({ id: "promo_newfixed", code: "NEWFIXED", isActive: true })],
  });

  assert.equal(response.status, 400);
  // Not "no promotion was written" -- no *plan* was written either. The refusal
  // has to come before the first upsert, not between the promotion ones.
  assert.deepEqual(world.writes, []);
  assert.equal(world.audits, 0);
});

test("reactivating a stored fixed-amount promotion is refused", async () => {
  const { response, body } = await patch({
    promotions: [payload({ isActive: true })],
  });

  assert.equal(response.status, 400);
  assert.equal(body?.code, "PROMOTION_FIXED_AMOUNT_BLOCKED");
  assert.deepEqual(world.writes, []);
});

test("widening a stored fixed-amount promotion is refused", async () => {
  for (const widening of [
    { discountAmountCents: 2_000 },
    { appliesToPlanIds: ["pro", "max"] },
    { endsAt: "2027-01-01T00:00:00.000Z" },
    { maxRedemptions: 500 },
    { durationMonths: 6 },
    { code: "RENAMED", id: FIXED_ROW.id },
  ]) {
    world = freshWorld();
    const { response, body } = await patch({
      promotions: [payload(widening)],
    });
    assert.equal(
      response.status,
      400,
      `expected a refusal for ${JSON.stringify(widening)}`
    );
    assert.equal(body?.code, "PROMOTION_FIXED_AMOUNT_BLOCKED");
    assert.deepEqual(world.writes, []);
  }
});

test("narrowing a stored fixed-amount promotion is saved", async () => {
  world.promotionRows = [{ ...FIXED_ROW, isActive: true }];
  const { response } = await patch({
    promotions: [
      payload({
        isActive: false,
        endsAt: "2026-08-05T00:00:00.000Z",
        discountAmountCents: 500,
        maxRedemptions: 10,
      }),
    ],
  });

  assert.equal(response.status, 200);
  assert.ok(
    world.writes.includes("billingPromotion.upsert"),
    "an allowed narrowing edit has to reach the database"
  );
});

test("percentage promotions save unaffected", async () => {
  world.promotionRows = [];
  const { response } = await patch({
    promotions: [
      payload({
        id: "promo_halfoff",
        code: "HALFOFF",
        discountPercent: 50,
        discountAmountCents: null,
        isActive: true,
      }),
    ],
  });

  assert.equal(response.status, 200);
  assert.ok(world.writes.includes("billingPromotion.upsert"));
});

test("an unchanged fixed-amount promotion rides along with an unrelated edit", async () => {
  // The panel sends the whole list on every save. If an untouched fixed-amount
  // row were refused, the billing form would be frozen for as long as one such
  // code exists -- which is exactly the state production is in.
  world.promotionRows = [FIXED_ROW];
  const { response } = await patch({
    promotions: [
      payload(),
      payload({
        id: "promo_halfoff",
        code: "HALFOFF",
        discountPercent: 50,
        discountAmountCents: null,
        isActive: true,
      }),
    ],
  });

  assert.equal(response.status, 200);
});
