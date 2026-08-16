import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * When the stored price catalogue is missing or unusable, what does a customer
 * get quoted -- and is it the same number they get charged?
 *
 * `DEFAULT_BILLING_PRICE_CATALOG` is not a test fixture. Three production paths
 * reach it: no `AppSetting` row (the next read creates one from it), a row that
 * does not parse, and a row that parses but fails the schema. In all three the
 * default is the live price, silently. So the default has to be the approved
 * price, and the display path and the charge path have to agree on it -- a
 * pricing page quoting one number while Stripe charges another is the failure
 * this file exists to make impossible.
 *
 * `lib/billingPriceCatalog.ts` is deliberately NOT mocked here. Every other
 * checkout contract test stubs `getBillingPriceCatalog()` out so it can be
 * about something else; that means none of them can see this. What is replaced
 * is one level lower -- the `AppSetting` row itself -- so the real fallback
 * logic runs.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

// Note what is *not* set: `E2E_DISABLE_DATABASE`. With it on, the config route
// short-circuits to fixtures and `withDisplayCurrency()` reads the compiled
// default without touching the database at all -- which would make every
// assertion below pass without proving anything about the fallback.
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "price-catalog-contract-secret";
process.env.NEXTAUTH_URL ||= "https://tomverse.app";
process.env.PUBLIC_APP_URL ||= "https://tomverse.app";
process.env.STRIPE_SECRET_KEY ||= "sk_test_contract";

const PRO_PLAN = {
  id: "pro",
  name: "Pro",
  tier: "Pro",
  monthlyPriceCents: 1_500,
  annualPriceCents: 18_000,
  currency: "USD",
  stripeProductId: "prod_pro",
  stripePriceId: "price_pro_monthly",
  stripeAnnualPriceId: "price_pro_annual",
  dailyMessageLimit: 200,
  monthlyMessageLimit: 3_000,
  maxModels: 3,
  allowAttachments: true,
  allowSharing: true,
  allowDownloads: true,
  isActive: true,
};

type StoredRow = { value: string; updatedAt: Date } | null;

type World = {
  /** What `AppSetting.findUnique` answers for the catalogue key. */
  storedRow: StoredRow;
  /** Rows written back. A read path must not write; the bootstrap path may. */
  appSettingWrites: string[];
  sessionCreateParams: Record<string, unknown>[];
};

const freshWorld = (): World => ({
  storedRow: null,
  appSettingWrites: [],
  sessionCreateParams: [],
});

let world = freshWorld();
let mocksInstalled = false;
let defaults: {
  plans: Record<string, Record<string, { monthly: number; annual: number }>>;
};

async function loadRoutes() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const original = (path: string) =>
      require(resolve(ROOT, path)) as Record<string, unknown>;

    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => ({ user: { id: "user_1" } }),
      },
    });

    const realApiSecurity = original("lib/apiSecurity.ts");
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => undefined,
      },
    });

    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          appSetting: {
            findUnique: async () => world.storedRow,
            upsert: async ({ create }: { create: { value: string } }) => {
              world.appSettingWrites.push(create.value);
              return { value: create.value, updatedAt: new Date() };
            },
          },
          user: {
            findUnique: async () => ({
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
            }),
            update: async () => ({}),
            updateMany: async () => ({ count: 1 }),
          },
          billingPromotion: { updateMany: async () => ({ count: 1 }) },
        },
      },
    });

    const realBillingConfig = original("lib/billingConfig.ts");
    mock.module(mod("lib/billingConfig.ts"), {
      namedExports: {
        ...realBillingConfig,
        getBillingPlans: async () => [PRO_PLAN],
        getPublicBillingConfig: async () => ({
          plans: [PRO_PLAN],
          creditPacks: [],
          featuredPromotion: null,
          promotionPolicy: {
            codesListed: false,
            validation: "server_only",
            annualDiscountStacking: "promotion_specific_default_denied",
          },
        }),
      },
    });

    mock.module(mod("lib/stripe.ts"), {
      namedExports: {
        isStripeConfigured: () => true,
        getStripe: () => ({
          customers: { create: async () => ({ id: "cus_created" }) },
          checkout: {
            sessions: {
              create: async (params: Record<string, unknown>) => {
                world.sessionCreateParams.push(params);
                return { id: "cs_1", url: "https://stripe.test/cs_1" };
              },
            },
          },
        }),
      },
    });

    defaults = (
      original("lib/billingPriceCatalog.ts") as {
        DEFAULT_BILLING_PRICE_CATALOG: typeof defaults;
      }
    ).DEFAULT_BILLING_PRICE_CATALOG;
  }
  const [config, checkout] = await Promise.all([
    import(mod("app/api/billing/config/route.ts")) as Promise<{
      GET: (request: Request) => Promise<Response>;
    }>,
    import(mod("app/api/billing/checkout/route.ts")) as Promise<{
      POST: (request: Request) => Promise<Response>;
    }>,
  ]);
  return { config, checkout };
}

/** The AUD market, decided from the trusted edge country header. */
const AU_HEADERS = { "cf-ipcountry": "AU" };

/** What the pricing page would show an Australian visitor for Pro monthly. */
const quotedMonthlyMinor = async () => {
  const { config } = await loadRoutes();
  const response = await config.GET(
    new Request("https://tomverse.app/api/billing/config", {
      headers: AU_HEADERS,
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    displayCurrency: string;
    plans: { id: string; displayMonthlyPriceMinor: number }[];
  };
  assert.equal(body.displayCurrency, "AUD");
  return body.plans.find((plan) => plan.id === "pro")!.displayMonthlyPriceMinor;
};

/** What Stripe would actually be told to charge for the same purchase. */
const chargedMonthlyMinor = async () => {
  const { checkout } = await loadRoutes();
  world.sessionCreateParams = [];
  const response = await checkout.POST(
    new Request("https://tomverse.app/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", ...AU_HEADERS },
      body: JSON.stringify({
        planId: "pro",
        billingInterval: "monthly",
        currency: "AUD",
        country: "AU",
      }),
    })
  );
  assert.equal(
    response.status,
    200,
    `checkout answered ${response.status}: ${await response.clone().text()}`
  );
  const params = world.sessionCreateParams.at(-1) as {
    line_items: { price_data: { unit_amount: number; currency: string } }[];
  };
  assert.equal(params.line_items[0].price_data.currency, "aud");
  return params.line_items[0].price_data.unit_amount;
};

const storedRow = (value: unknown) => ({
  value: typeof value === "string" ? value : JSON.stringify(value),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
});

/**
 * Captures the fallback event while a body runs.
 *
 * The event is the only thing that distinguishes "serving the override" from
 * "serving the default" at runtime, so it is asserted rather than tolerated:
 * a fallback that stopped announcing itself would put production back in the
 * state this work exists to end.
 */
const withWarnings = async <T>(body: () => Promise<T>) => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    const result = await body();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
};

type FallbackEvent = { event?: string; source?: string; served?: string };

const fallbackEvents = (warnings: string[]): FallbackEvent[] =>
  warnings
    .map((line) => {
      try {
        return JSON.parse(line) as FallbackEvent;
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is FallbackEvent =>
        entry?.event === "billing_price_catalog_fallback"
    );

test.beforeEach(() => {
  world = freshWorld();
});

test("with no AppSetting row, the quote and the charge are both the default", async () => {
  const quoted = await quotedMonthlyMinor();
  const charged = await chargedMonthlyMinor();

  assert.equal(quoted, charged);
  assert.equal(quoted, defaults.plans.pro.AUD.monthly);
  // And the missing row was created from the defaults, so this is not a
  // transient state that a later read would resolve differently.
  assert.ok(world.appSettingWrites.length > 0);
});

test("with an unparseable stored row, the quote and the charge are both the default", async () => {
  world.storedRow = storedRow("{not json");

  const quoted = await quotedMonthlyMinor();
  const charged = await chargedMonthlyMinor();

  assert.equal(quoted, charged);
  assert.equal(quoted, defaults.plans.pro.AUD.monthly);
});

test("with a schema-invalid stored row, the quote and the charge are both the default", async () => {
  // A plausible corruption: the annual price is gone. The schema requires it,
  // so the whole catalogue is discarded -- including the monthly price, which
  // is intact and which the customer would otherwise have been charged.
  world.storedRow = storedRow({
    ...JSON.parse(JSON.stringify(defaults)),
    plans: {
      ...JSON.parse(JSON.stringify(defaults.plans)),
      pro: {
        ...JSON.parse(JSON.stringify(defaults.plans.pro)),
        AUD: { monthly: 2_000 },
      },
    },
  });

  const quoted = await quotedMonthlyMinor();
  const charged = await chargedMonthlyMinor();

  assert.equal(quoted, charged);
  assert.equal(
    quoted,
    defaults.plans.pro.AUD.monthly,
    "one missing field discards the whole stored catalogue, so the default is what both paths use"
  );
});

test("a valid stored override is honoured by both paths, not just one", async () => {
  // The override state, which is what production is in. The point is not that
  // the override works -- it is that the display path and the charge path move
  // together, so no state exists where a customer is quoted one number and
  // charged another.
  const override = JSON.parse(JSON.stringify(defaults));
  // Derived from the default rather than written out. Aligning the default to
  // the approved price (#637) made a literal here equal to the default, and a
  // test where the override and the fallback are the same number cannot tell
  // which one answered.
  const overridden = defaults.plans.pro.AUD.monthly + 500;
  override.plans.pro.AUD = {
    monthly: overridden,
    annual: Math.round(overridden * 12 * 0.8),
  };
  world.storedRow = storedRow(override);

  const quoted = await quotedMonthlyMinor();
  const charged = await chargedMonthlyMinor();

  assert.equal(quoted, charged);
  assert.equal(quoted, overridden);
  assert.notEqual(
    quoted,
    defaults.plans.pro.AUD.monthly,
    "this test proves nothing unless the override and the default actually differ"
  );
  // A read must not rewrite a row it could read.
  assert.deepEqual(world.appSettingWrites, []);
});

/* -------------------------------------------------------------------------- */
/* The fallback says so                                                        */
/* -------------------------------------------------------------------------- */

test("each fallback state announces itself, and names which one it is", async () => {
  const cases: [string, () => void][] = [
    ["created_from_default", () => {
      world.storedRow = null;
    }],
    ["default_row_unparseable", () => {
      world.storedRow = storedRow("{not json");
    }],
    ["default_row_invalid", () => {
      world.storedRow = storedRow({ version: 1, plans: {}, creditPacks: {} });
    }],
  ];

  for (const [expected, arrange] of cases) {
    world = freshWorld();
    arrange();
    const { warnings } = await withWarnings(() => quotedMonthlyMinor());
    const events = fallbackEvents(warnings);
    assert.ok(
      events.length > 0,
      `${expected}: a silent fallback is the defect this event exists for`
    );
    assert.equal(events[0].source, expected);
    assert.equal(
      events[0].served,
      "compiled_default",
      "the line has to say what the customer got, not only that something failed"
    );
  }
});

test("a readable stored catalogue says nothing", async () => {
  // An event on the healthy path would be noise on every request, and noise is
  // how a real one gets ignored.
  const override = JSON.parse(JSON.stringify(defaults));
  override.plans.pro.AUD = { monthly: 2_100, annual: 20_160 };
  world.storedRow = storedRow(override);

  const { result, warnings } = await withWarnings(() => quotedMonthlyMinor());
  assert.equal(result, 2_100);
  assert.deepEqual(fallbackEvents(warnings), []);
});

test("the Admin catalogue read reports which table answered", async () => {
  // The panel renders the stored row's `updatedAt` beside the catalogue. When
  // the row is unreadable those numbers are the defaults, so without this the
  // console shows a recent timestamp next to values that row never held.
  const { getBillingPriceCatalogWithMeta } = (await import(
    mod("lib/billingPriceCatalog.ts")
  )) as typeof import("../../lib/billingPriceCatalog");

  world.storedRow = storedRow({ version: 1, plans: {}, creditPacks: {} });
  const invalid = await withWarnings(() => getBillingPriceCatalogWithMeta());
  assert.equal(invalid.result.source, "default_row_invalid");
  assert.equal(
    invalid.result.updatedAt,
    "2026-08-01T00:00:00.000Z",
    "the timestamp is still the row's -- `source` is what stops it being read as this catalogue's"
  );

  world = freshWorld();
  const override = JSON.parse(JSON.stringify(defaults));
  world.storedRow = storedRow(override);
  const stored = await withWarnings(() => getBillingPriceCatalogWithMeta());
  assert.equal(stored.result.source, "stored");
});
