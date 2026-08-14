import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * Validation and Checkout must not disagree about anything decidable without
 * reading Stripe.
 *
 * The reported failure has this shape: the code validates, the order summary
 * shows the discount and "A$0.00 due today", and "Continue to payment" comes
 * back with "This promotion is not currently available." Some causes of that
 * genuinely need Stripe -- a coupon somebody edited in the dashboard, an object
 * in the wrong mode -- and the Admin diagnostics exists for those. But one class
 * did not: `promotionStripePolicyViolation()` is a pure predicate over the
 * policy row, and it ran only inside the checkout provisioner. A promotion with
 * a zero-month duration passed validation and failed the button, with no
 * network call involved in the disagreement.
 *
 * Both endpoints call `validatePromotionForCheckout`, so that is where the
 * check belongs, and this file drives the real one to prove they now agree.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const HEALTHY: import("../../lib/billingConfig").BillingPromotionConfig = {
  id: "promo_db",
  code: "EDDIEFRIEND100",
  discountPercent: 100,
  discountAmountCents: null,
  maxRedemptions: 1000,
  redeemedCount: 0,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription" as const,
  accessDurationDays: null,
  appliesToPlanIds: ["pro", "max"] as ("pro" | "max")[],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: null,
  endsAt: "2026-12-01T00:00:00.000Z",
  allowAnnualStacking: false,
  isActive: true,
};

let promotionRow: typeof HEALTHY | null = HEALTHY;
let installed = false;

async function loadValidator() {
  if (!installed) {
    installed = true;
    process.env.NEXTAUTH_SECRET ||= "promotion-parity-test-secret";
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realConfig = require(resolve(ROOT, "lib/billingConfig.ts")) as Record<
      string,
      unknown
    >;
    mock.module(mod("lib/billingConfig.ts"), {
      namedExports: {
        ...realConfig,
        getBillingPromotionByCode: async () => promotionRow,
      },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          billingPromotionRedemption: {
            findUnique: async () => null,
            findMany: async () => [],
          },
        },
      },
    });
  }
  return import(mod("lib/billingPromotionSecurity.ts")) as Promise<
    typeof import("../../lib/billingPromotionSecurity")
  >;
}

const NOW = new Date("2026-08-14T00:00:00.000Z");
const request = () =>
  new Request("https://tomverse.app/api/billing/promotion/validate", {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });

const validate = async (overrides: Partial<typeof HEALTHY> = {}) => {
  const { validatePromotionForCheckout } = await loadValidator();
  promotionRow = { ...HEALTHY, ...overrides };
  return validatePromotionForCheckout({
    code: "EDDIEFRIEND100",
    planId: "pro",
    billingInterval: "monthly",
    userId: null,
    request: request(),
    now: NOW,
  });
};

test("a healthy promotion still validates", async () => {
  const result = await validate();
  assert.equal(result.valid, true);
});

test("every policy shape Stripe cannot represent is refused at validation", async () => {
  // Exactly the set `promotionStripePolicyViolation` refuses, checked through
  // the function both endpoints call rather than against a second copy of the
  // list.
  const { promotionStripePolicyViolation } = (await import(
    mod("lib/stripePromotionProvisioningCore.ts")
  )) as typeof import("../../lib/stripePromotionProvisioningCore");

  for (const [overrides, label] of [
    [{ durationMonths: 0 }, "zero-month duration"],
    [{ durationMonths: -1 }, "negative duration"],
    [{ discountPercent: 0, discountAmountCents: null }, "no discount at all"],
  ] as const) {
    const candidate = { ...HEALTHY, ...overrides };
    assert.ok(
      promotionStripePolicyViolation(candidate),
      `${label}: the provisioner should refuse this`
    );
    const result = await validate(overrides);
    assert.equal(result.valid, false, label);
    assert.equal(
      result.valid === false ? result.reason : null,
      "unavailable",
      label
    );
  }
});

test("the message a customer sees is the one Checkout already gave them", async () => {
  // Same code, same status, same sentence -- the change is only that it arrives
  // before the summary rather than after the button.
  const { promotionValidationError } = (await import(
    mod("lib/billingPromotionCore.ts")
  )) as typeof import("../../lib/billingPromotionCore");
  const { externalCheckoutError } = (await import(
    mod("lib/stripePromotionProvisioningCore.ts")
  )) as typeof import("../../lib/stripePromotionProvisioningCore");
  const fromValidation = promotionValidationError("unavailable");
  const fromCheckout = externalCheckoutError("PROMOTION_COUPON_INVALID");
  assert.equal(fromValidation.code, fromCheckout.code);
  assert.equal(fromValidation.message, fromCheckout.error);
  assert.equal(fromValidation.status, fromCheckout.status);
});

test("an internal pass is not held to the Stripe policy it never reaches", async () => {
  // Fulfilled by granting an access period; no Coupon, no Promotion Code, no
  // Session. Judging it against Stripe's requirements would refuse a promotion
  // that works.
  const result = await validate({
    fulfillmentType: "internal_pass",
    accessDurationDays: 60,
    durationMonths: 1,
    appliesToPlanIds: ["pro"],
  });
  assert.equal(result.valid, true);
});

test("an unknown code is still just invalid", async () => {
  const { validatePromotionForCheckout } = await loadValidator();
  promotionRow = null;
  const result = await validatePromotionForCheckout({
    code: "NOPE",
    planId: "pro",
    billingInterval: "monthly",
    userId: null,
    request: request(),
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.equal(result.valid === false ? result.reason : null, "invalid");
});
