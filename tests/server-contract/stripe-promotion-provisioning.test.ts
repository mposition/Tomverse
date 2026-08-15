import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  ensureStripePromotionDiscount,
  inspectStripePromotionLinkage,
  StripePromotionProvisioningError,
} from "../../lib/stripePromotionProvisioning";

/**
 * Contract for the promotion provisioning service, driven against a fake Stripe.
 *
 * Nothing here talks to Stripe. The behaviours being pinned are the ones that
 * only appear when Stripe and the database disagree -- a stale id, a partial
 * success, two requests racing, an object that belongs to somebody else -- and
 * those are exactly the states a live account cannot be put into on purpose.
 */

const ENDS_AT = "2026-08-15T00:00:00.000Z";
const ENDS_AT_SECONDS = Math.floor(new Date(ENDS_AT).getTime() / 1000);
const NOW = new Date("2026-08-02T00:00:00.000Z");

type FakeCoupon = {
  id: string;
  livemode: boolean;
  valid: boolean;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: string;
  duration_in_months: number | null;
  metadata: Record<string, string>;
  applies_to?: { products: string[] };
};

type FakePromotionCode = {
  id: string;
  code: string;
  active: boolean;
  livemode: boolean;
  promotion: { type: "coupon"; coupon: string };
  customer: string | null;
  max_redemptions: number | null;
  times_redeemed: number;
  expires_at: number | null;
  metadata: Record<string, string>;
};

const missingResource = (resource: string) =>
  Object.assign(new Error(`No such ${resource}`), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    statusCode: 400,
    requestId: "req_missing",
  });

class FakeStripe {
  coupons: FakeCoupon[] = [];
  promotionCodes: FakePromotionCode[] = [];
  /** Every idempotency key seen, so a duplicate create is visible in a test. */
  couponCreateKeys: string[] = [];
  promotionCodeCreateKeys: string[] = [];
  /** key -> already-created object, mimicking Stripe's replay behaviour. */
  private couponReplay = new Map<string, FakeCoupon>();
  private promotionCodeReplay = new Map<string, FakePromotionCode>();
  private sequence = 0;
  listCalls = 0;

  private nextId(prefix: string) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  readonly couponsApi = {
    retrieve: async (id: string) => {
      const found = this.coupons.find((entry) => entry.id === id);
      if (!found) throw missingResource("coupon");
      return found as unknown as Stripe.Coupon;
    },
    create: async (
      params: Record<string, unknown>,
      options?: { idempotencyKey?: string }
    ) => {
      const key = options?.idempotencyKey || "";
      this.couponCreateKeys.push(key);
      const replayed = this.couponReplay.get(key);
      if (replayed) return replayed as unknown as Stripe.Coupon;
      const created: FakeCoupon = {
        id: this.nextId("cpn"),
        livemode: true,
        valid: true,
        percent_off: (params.percent_off as number) ?? null,
        amount_off: (params.amount_off as number) ?? null,
        currency: (params.currency as string) ?? null,
        duration: params.duration as string,
        duration_in_months: (params.duration_in_months as number) ?? null,
        metadata: params.metadata as Record<string, string>,
      };
      this.coupons.push(created);
      this.couponReplay.set(key, created);
      return created as unknown as Stripe.Coupon;
    },
  };

  readonly promotionCodesApi = {
    retrieve: async (id: string) => {
      const found = this.promotionCodes.find((entry) => entry.id === id);
      if (!found) throw missingResource("promotion_code");
      return found as unknown as Stripe.PromotionCode;
    },
    list: async ({ code }: { code?: string }) => {
      this.listCalls += 1;
      return {
        data: this.promotionCodes.filter(
          (entry) => entry.code.toUpperCase() === (code || "").toUpperCase()
        ),
      } as unknown as Stripe.ApiList<Stripe.PromotionCode>;
    },
    create: async (
      params: Record<string, unknown>,
      options?: { idempotencyKey?: string }
    ) => {
      const key = options?.idempotencyKey || "";
      this.promotionCodeCreateKeys.push(key);
      const replayed = this.promotionCodeReplay.get(key);
      if (replayed) return replayed as unknown as Stripe.PromotionCode;
      const code = params.code as string;
      // Stripe's real constraint: one *active* promotion code per string.
      if (
        this.promotionCodes.some(
          (entry) =>
            entry.active && entry.code.toUpperCase() === code.toUpperCase()
        )
      ) {
        throw Object.assign(
          new Error(`A promotion code with code "${code}" already exists.`),
          {
            type: "StripeInvalidRequestError",
            code: "resource_already_exists",
            statusCode: 400,
            requestId: "req_dupe",
          }
        );
      }
      const promotion = params.promotion as { coupon: string };
      const created: FakePromotionCode = {
        id: this.nextId("promo"),
        code,
        active: true,
        livemode: true,
        promotion: { type: "coupon", coupon: promotion.coupon },
        customer: null,
        max_redemptions: (params.max_redemptions as number) ?? null,
        times_redeemed: 0,
        expires_at: (params.expires_at as number) ?? null,
        metadata: params.metadata as Record<string, string>,
      };
      this.promotionCodes.push(created);
      this.promotionCodeReplay.set(key, created);
      return created as unknown as Stripe.PromotionCode;
    },
  };

  asStripe(): Stripe {
    return {
      coupons: this.couponsApi,
      promotionCodes: this.promotionCodesApi,
    } as unknown as Stripe;
  }
}

/** Just enough Prisma to exercise the conditional linkage write. */
class FakeDb {
  updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] =
    [];
  constructor(
    public row: {
      id: string;
      code: string;
      stripeCouponId: string | null;
      stripePromotionCodeId: string | null;
    },
    /** Set to fail the write, modelling "Stripe accepted, the database did not". */
    public failWrites = false
  ) {}

  readonly billingPromotion = {
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      this.updates.push({ where, data });
      if (this.failWrites) throw new Error("database unavailable");
      const or = where.OR as { stripePromotionCodeId: string | null }[];
      const matchesLinkage =
        !or ||
        or.some(
          (clause) =>
            clause.stripePromotionCodeId === this.row.stripePromotionCodeId
        );
      if (
        where.id !== this.row.id ||
        where.code !== this.row.code ||
        !matchesLinkage
      ) {
        return { count: 0 };
      }
      Object.assign(this.row, data);
      return { count: 1 };
    },
    findUnique: async () => ({
      stripePromotionCodeId: this.row.stripePromotionCodeId,
    }),
  };
}

const promotionConfig = (overrides = {}) =>
  ({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    discountPercent: 100,
    discountAmountCents: null,
    maxRedemptions: 1000,
    redeemedCount: 0,
    durationMonths: 1,
    fulfillmentType: "stripe_subscription" as const,
    accessDurationDays: null,
    appliesToPlanIds: ["max" as const],
    stripeCouponId: null,
    stripePromotionCodeId: null,
    startsAt: null,
    endsAt: ENDS_AT,
    allowAnnualStacking: false,
    isActive: true,
    ...overrides,
  }) as Parameters<typeof ensureStripePromotionDiscount>[0]["promotion"];

const healthyObjects = (stripe: FakeStripe) => {
  stripe.coupons.push({
    id: "cpn_live",
    livemode: true,
    valid: true,
    percent_off: 100,
    amount_off: null,
    currency: null,
    duration: "repeating",
    duration_in_months: 1,
    metadata: { tomversePromotionId: "promo_db", planId: "max" },
  });
  stripe.promotionCodes.push({
    id: "promo_live",
    code: "EDDIEFRIEND100",
    active: true,
    livemode: true,
    promotion: { type: "coupon", coupon: "cpn_live" },
    customer: null,
    max_redemptions: 1000,
    times_redeemed: 0,
    expires_at: ENDS_AT_SECONDS,
    metadata: { tomversePromotionId: "promo_db", planId: "max" },
  });
};

const ensure = (
  stripe: FakeStripe,
  db: FakeDb,
  promotion = promotionConfig(),
  overrides: Partial<Parameters<typeof ensureStripePromotionDiscount>[0]> = {}
) =>
  ensureStripePromotionDiscount({
    promotion,
    planId: "max",
    planProductId: "prod_max",
    customerId: "cus_current",
    stripe: stripe.asStripe(),
    db: db as never,
    expectLiveMode: true,
    now: NOW,
    ...overrides,
  });

test("a stored, healthy promotion code is reused without creating anything", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  const result = await ensure(
    stripe,
    db,
    promotionConfig({
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    })
  );
  assert.deepEqual(result.discount, { promotion_code: "promo_live" });
  assert.equal(result.resolution, "linked");
  assert.deepEqual(result.driftReasons, []);
  assert.deepEqual(stripe.couponCreateKeys, []);
  assert.deepEqual(stripe.promotionCodeCreateKeys, []);
  // No search either: the linked object answered the question.
  assert.equal(stripe.listCalls, 0);
});

test("with nothing stored and nothing in Stripe, exactly one coupon and one code are created", async () => {
  const stripe = new FakeStripe();
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  const result = await ensure(stripe, db);
  assert.equal(result.resolution, "created");
  assert.equal(stripe.coupons.length, 1);
  assert.equal(stripe.promotionCodes.length, 1);
  assert.equal(stripe.coupons[0].percent_off, 100);
  assert.equal(stripe.coupons[0].duration_in_months, 1);
  assert.equal(stripe.promotionCodes[0].expires_at, ENDS_AT_SECONDS);
  assert.equal(stripe.promotionCodes[0].max_redemptions, 1000);
  // The linkage is written back, which is what stops the next attempt from
  // trying to create a code Stripe would then refuse as a duplicate.
  assert.equal(db.row.stripePromotionCodeId, result.promotionCodeId);
  assert.equal(db.row.stripeCouponId, result.couponId);
});

test("a partial success is repaired by exact-code search, not by creating a duplicate", async () => {
  // The failure this whole module exists for: Stripe accepted the create and
  // the database write that was meant to record it did not land. Previously the
  // next attempt tried to create the same code and Stripe refused it forever.
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  const result = await ensure(stripe, db);
  assert.equal(result.resolution, "adopted");
  assert.deepEqual(result.discount, { promotion_code: "promo_live" });
  assert.deepEqual(stripe.promotionCodeCreateKeys, []);
  assert.equal(stripe.promotionCodes.length, 1);
  assert.equal(db.row.stripePromotionCodeId, "promo_live");
  assert.equal(db.row.stripeCouponId, "cpn_live");
});

test("a stored id Stripe no longer knows falls back to reconciliation instead of failing", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_gone",
    stripePromotionCodeId: "promo_gone",
  });
  const result = await ensure(
    stripe,
    db,
    promotionConfig({
      stripeCouponId: "cpn_gone",
      stripePromotionCodeId: "promo_gone",
    })
  );
  assert.equal(result.resolution, "adopted");
  assert.equal(db.row.stripePromotionCodeId, "promo_live");
});

test("a test-mode object stored against a live deployment is a typed mode mismatch", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  stripe.promotionCodes[0].livemode = false;
  stripe.coupons[0].livemode = false;
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  await assert.rejects(
    ensure(
      stripe,
      db,
      promotionConfig({
        stripeCouponId: "cpn_live",
        stripePromotionCodeId: "promo_live",
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof StripePromotionProvisioningError);
      assert.equal(error.code, "PROMOTION_STRIPE_MODE_MISMATCH");
      assert.equal(error.stage, "promotion_code");
      return true;
    }
  );
});

test("an inactive, expired or exhausted stored code is reported, never silently replaced", async () => {
  for (const mutate of [
    (code: FakePromotionCode) => {
      code.active = false;
    },
    (code: FakePromotionCode) => {
      code.expires_at = Math.floor(NOW.getTime() / 1000) - 60;
    },
    (code: FakePromotionCode) => {
      code.times_redeemed = 1000;
    },
  ]) {
    const stripe = new FakeStripe();
    healthyObjects(stripe);
    mutate(stripe.promotionCodes[0]);
    const db = new FakeDb({
      id: "promo_db",
      code: "EDDIEFRIEND100",
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    });
    await assert.rejects(
      ensure(
        stripe,
        db,
        promotionConfig({
          stripeCouponId: "cpn_live",
          stripePromotionCodeId: "promo_live",
        })
      ),
      StripePromotionProvisioningError
    );
    // The object is left exactly as it was: it may be attached to live
    // subscriptions, so this code does not get to retire it.
    assert.equal(stripe.promotionCodes.length, 1);
    assert.deepEqual(stripe.promotionCodeCreateKeys, []);
  }
});

test("an active code that belongs to another promotion is neither adopted nor overwritten", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  stripe.promotionCodes[0].metadata = {
    tomversePromotionId: "promo_someone_else",
    planId: "max",
  };
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  await assert.rejects(ensure(stripe, db), (error: unknown) => {
    assert.ok(error instanceof StripePromotionProvisioningError);
    assert.equal(error.code, "PROMOTION_CODE_CONFLICT");
    assert.deepEqual(
      error.details.reason,
      "active_code_owned_by_another_object"
    );
    return true;
  });
  assert.equal(db.row.stripePromotionCodeId, null);
  assert.deepEqual(stripe.promotionCodeCreateKeys, []);
});

test("a coupon restricted to another product fails rather than charging full price", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  stripe.coupons[0].applies_to = { products: ["prod_pro"] };
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  await assert.rejects(
    ensure(
      stripe,
      db,
      promotionConfig({
        stripeCouponId: "cpn_live",
        stripePromotionCodeId: "promo_live",
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof StripePromotionProvisioningError);
      assert.equal(error.code, "PROMOTION_PRODUCT_MISMATCH");
      return true;
    }
  );
});

test("a durationMonths Stripe cannot represent fails before any network call", async () => {
  const stripe = new FakeStripe();
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  await assert.rejects(
    ensure(stripe, db, promotionConfig({ durationMonths: 0 })),
    (error: unknown) => {
      assert.ok(error instanceof StripePromotionProvisioningError);
      assert.equal(error.code, "PROMOTION_COUPON_INVALID");
      assert.equal(error.details.policyViolation, "duration_months_invalid");
      return true;
    }
  );
  assert.equal(stripe.listCalls, 0);
  assert.deepEqual(stripe.couponCreateKeys, []);
});

test("a create that succeeds while the database write fails leaves no duplicate on retry", async () => {
  const stripe = new FakeStripe();
  const failing = new FakeDb(
    {
      id: "promo_db",
      code: "EDDIEFRIEND100",
      stripeCouponId: null,
      stripePromotionCodeId: null,
    },
    true
  );
  await assert.rejects(ensure(stripe, failing), /database unavailable/);
  assert.equal(stripe.promotionCodes.length, 1);
  assert.equal(failing.row.stripePromotionCodeId, null);

  // The retry finds the orphaned object by code and links it, rather than
  // asking Stripe for a second code it would refuse as a duplicate.
  const recovering = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  const result = await ensure(stripe, recovering);
  assert.equal(result.resolution, "adopted");
  assert.equal(stripe.promotionCodes.length, 1);
  assert.equal(stripe.coupons.length, 1);
  assert.equal(recovering.row.stripePromotionCodeId, result.promotionCodeId);
});

test("two concurrent first-time requests share one coupon and one promotion code", async () => {
  const stripe = new FakeStripe();
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  const [first, second] = await Promise.all([
    ensure(stripe, db),
    ensure(stripe, db),
  ]);
  assert.equal(first.promotionCodeId, second.promotionCodeId);
  assert.equal(first.couponId, second.couponId);
  assert.equal(stripe.coupons.length, 1);
  assert.equal(stripe.promotionCodes.length, 1);
  // Both creates went out, but under the same idempotency key -- which is what
  // makes Stripe return one object instead of minting a second.
  assert.equal(new Set(stripe.couponCreateKeys).size, 1);
  assert.equal(new Set(stripe.promotionCodeCreateKeys).size, 1);
});

test("a cap the database and Stripe disagree on is reported as drift and still checks out", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  stripe.promotionCodes[0].max_redemptions = 10;
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  const result = await ensure(
    stripe,
    db,
    promotionConfig({
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    })
  );
  assert.deepEqual(result.discount, { promotion_code: "promo_live" });
  assert.deepEqual(result.driftReasons, ["drift:max_redemptions"]);
});

test("the read-only inspection reports state and mutates nothing", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const report = await inspectStripePromotionLinkage({
    promotion: promotionConfig({
      stripeCouponId: null,
      stripePromotionCodeId: null,
    }),
    planId: "max",
    planProductId: "prod_max",
    stripe: stripe.asStripe(),
    expectLiveMode: true,
    now: NOW,
  });
  assert.equal(report.recommendation, "adopt_exact_match");
  assert.equal(report.exactCodeCandidates.length, 1);
  assert.equal(report.exactCodeCandidates[0].adoptable, true);
  assert.deepEqual(stripe.couponCreateKeys, []);
  assert.deepEqual(stripe.promotionCodeCreateKeys, []);

  const healthy = await inspectStripePromotionLinkage({
    promotion: promotionConfig({
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    }),
    planId: "max",
    planProductId: "prod_max",
    stripe: stripe.asStripe(),
    expectLiveMode: true,
    now: NOW,
  });
  assert.equal(healthy.recommendation, "healthy");
  // It returns before the exact-code search, so the empty candidate list means
  // "not looked at". A reader that cannot tell that from "Stripe holds nothing"
  // reports a healthy promotion as `no_stripe_object_for_code`.
  assert.equal(healthy.exactCodeSearchPerformed, false);
  assert.deepEqual(healthy.exactCodeCandidates, []);

  const empty = await inspectStripePromotionLinkage({
    promotion: promotionConfig({ code: "NOTHING_HERE" }),
    planId: "max",
    stripe: stripe.asStripe(),
    expectLiveMode: true,
    now: NOW,
  });
  assert.equal(empty.recommendation, "create_missing_objects");
  assert.equal(empty.exactCodeSearchPerformed, true);
  assert.deepEqual(empty.exactCodeCandidates, []);
});

/**
 * The reported outage, driven end to end through the real provisioner.
 *
 * EDDIEFRIEND100 is eligible for Pro *and* Max. Its Stripe objects were stamped
 * `planId: max` by whichever checkout provisioned them, because `BillingPromotion`
 * has one `stripeCouponId`/`stripePromotionCodeId` pair for the whole row and a
 * Stripe promotion code string is unique across the account -- there is nowhere
 * to put a second, Pro-stamped object and no way to create one. A Pro checkout
 * then failed the strict `metadata.planId` equality, which is an identity
 * mismatch, which is fatal, which surfaces as
 * "This promotion is not currently available." Validation never saw it because
 * validation never reads Stripe.
 */
test("a promotion eligible for both plans checks out on the plan its objects were not stamped with", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  const result = await ensure(
    stripe,
    db,
    promotionConfig({
      appliesToPlanIds: ["pro", "max"],
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    }),
    { planId: "pro", planProductId: "prod_pro" }
  );
  assert.deepEqual(result.discount, { promotion_code: "promo_live" });
  assert.equal(result.resolution, "linked");
  assert.deepEqual(result.driftReasons, []);
  // And it did not try to repair the situation by creating a second object,
  // which Stripe would refuse as a duplicate code string.
  assert.deepEqual(stripe.promotionCodeCreateKeys, []);
  assert.deepEqual(stripe.couponCreateKeys, []);
});

test("the same promotion is still adoptable on the other plan after a lost linkage", async () => {
  // The partial-success repair has to work on both plans too, or the promotion
  // is stuck the moment a database write is lost.
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: null,
    stripePromotionCodeId: null,
  });
  const result = await ensure(
    stripe,
    db,
    promotionConfig({ appliesToPlanIds: ["pro", "max"] }),
    { planId: "pro", planProductId: "prod_pro" }
  );
  assert.equal(result.resolution, "adopted");
  assert.equal(db.row.stripePromotionCodeId, "promo_live");
  assert.deepEqual(stripe.promotionCodeCreateKeys, []);
});

test("a plan the promotion does not cover is still refused by the product restriction", async () => {
  // Relaxing the metadata stamp must not relax which plan a discount may be
  // charged against. A coupon restricted to the Max product fails a Pro
  // checkout, loudly, rather than quietly charging full price.
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  stripe.coupons[0].applies_to = { products: ["prod_max"] };
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  await assert.rejects(
    ensure(
      stripe,
      db,
      promotionConfig({
        appliesToPlanIds: ["pro", "max"],
        stripeCouponId: "cpn_live",
        stripePromotionCodeId: "promo_live",
      }),
      { planId: "pro", planProductId: "prod_pro" }
    ),
    (error: unknown) => {
      assert.ok(error instanceof StripePromotionProvisioningError);
      assert.equal(error.code, "PROMOTION_PRODUCT_MISMATCH");
      return true;
    }
  );
});

test("an object stamped for a plan the row no longer covers still works, and says so", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: "cpn_live",
    stripePromotionCodeId: "promo_live",
  });
  const result = await ensure(
    stripe,
    db,
    promotionConfig({
      appliesToPlanIds: ["pro"],
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    }),
    { planId: "pro", planProductId: "prod_pro" }
  );
  assert.equal(result.resolution, "linked");
  assert.deepEqual(result.driftReasons, [
    "drift:metadata_plan_id_stale",
    "drift:metadata_plan_id_stale",
  ]);
});

/**
 * A coupon somebody created by hand in the Stripe dashboard.
 *
 * Modelled on the object found in staging on 2026-08-14: named after the code
 * rather than "<CODE> <PLAN>", `duration: once` where the policy says
 * `repeating` for one month, and no metadata at all. `ensureCoupon()` retrieves
 * it, fails it, and throws PROMOTION_COUPON_INVALID -- which reaches the
 * customer as "This promotion is not currently available." after validation had
 * already shown them the discount.
 */
const handMadeCoupon = (stripe: FakeStripe, id = "cpn_by_hand") => {
  stripe.coupons.push({
    id,
    livemode: true,
    valid: true,
    percent_off: 100,
    amount_off: null,
    currency: null,
    duration: "once",
    duration_in_months: null,
    metadata: {},
  });
  return id;
};

test("a hand-made coupon stored against the promotion refuses checkout, and says which field", async () => {
  const stripe = new FakeStripe();
  const couponId = handMadeCoupon(stripe);
  const db = new FakeDb({
    id: "promo_db",
    code: "EDDIEFRIEND100",
    stripeCouponId: couponId,
    stripePromotionCodeId: null,
  });
  await assert.rejects(
    ensure(
      stripe,
      db,
      promotionConfig({ stripeCouponId: couponId, stripePromotionCodeId: null })
    ),
    (error: unknown) => {
      assert.ok(error instanceof StripePromotionProvisioningError);
      assert.equal(error.code, "PROMOTION_COUPON_INVALID");
      assert.equal(error.stage, "coupon");
      const mismatches = error.details.mismatches as string[];
      assert.ok(mismatches.includes("identity:duration"));
      assert.ok(mismatches.includes("identity:duration_in_months"));
      assert.ok(mismatches.includes("identity:metadata_promotion_id"));
      return true;
    }
  );
  // Never repaired or replaced: the coupon may be attached to live
  // subscriptions, so the answer is a report, not a rewrite.
  assert.deepEqual(stripe.couponCreateKeys, []);
  assert.equal(db.row.stripeCouponId, couponId);
});

test("the inspection reports that stored coupon instead of calling it missing objects", async () => {
  // The regression this test exists for: the report printed `storedCouponId`
  // and never checked it, so this exact state came back as
  // `create_missing_objects` -- "nothing here yet, the next checkout will
  // provision it" -- over a coupon that was about to refuse every checkout.
  const stripe = new FakeStripe();
  const couponId = handMadeCoupon(stripe);
  const promotion = promotionConfig({
    stripeCouponId: couponId,
    stripePromotionCodeId: null,
  });
  const report = await inspectStripePromotionLinkage({
    promotion,
    planId: "max",
    planProductId: "prod_max",
    stripe: stripe.asStripe(),
    expectLiveMode: true,
    now: NOW,
  });
  assert.equal(report.storedCouponExists, true);
  assert.ok(report.storedCouponMismatches.includes("identity:duration"));
  assert.equal(report.recommendation, "manual_review");
  assert.notEqual(report.recommendation, "create_missing_objects");
});

test("a stored coupon id Stripe has forgotten is not treated as a blocker", async () => {
  // Recoverable on its own: `ensureCoupon()` re-creates it under a stable
  // idempotency key, so the recommendation must not escalate to manual review.
  const stripe = new FakeStripe();
  const report = await inspectStripePromotionLinkage({
    promotion: promotionConfig({
      stripeCouponId: "cpn_long_gone",
      stripePromotionCodeId: null,
    }),
    planId: "max",
    planProductId: "prod_max",
    stripe: stripe.asStripe(),
    expectLiveMode: true,
    now: NOW,
  });
  assert.equal(report.storedCouponExists, false);
  assert.deepEqual(report.storedCouponMismatches, []);
  assert.equal(report.recommendation, "create_missing_objects");
});

test("a healthy stored coupon still reports healthy", async () => {
  const stripe = new FakeStripe();
  healthyObjects(stripe);
  const report = await inspectStripePromotionLinkage({
    promotion: promotionConfig({
      stripeCouponId: "cpn_live",
      stripePromotionCodeId: "promo_live",
    }),
    planId: "max",
    planProductId: "prod_max",
    stripe: stripe.asStripe(),
    expectLiveMode: true,
    now: NOW,
  });
  assert.equal(report.storedCouponExists, true);
  assert.deepEqual(report.storedCouponMismatches, []);
  assert.equal(report.recommendation, "healthy");
});
