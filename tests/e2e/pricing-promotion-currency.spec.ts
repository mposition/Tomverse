import { expect, test, type Page } from "@playwright/test";

/**
 * A promotion the summary quotes is a promotion Checkout can charge.
 *
 * The reported failure, reproduced here: in the AUD market, Pro monthly at
 * A$20.00, `PAYMENTTEST27` -- a $14 fixed-amount discount -- validated. The
 * order summary showed "-$14" and "A$1.33 due today", and "Continue to payment"
 * answered "Fixed-amount promotion codes are currently available only for USD
 * checkout." in English, to a Korean page.
 *
 * A$1.33 was arrived at by turning $14 off a $15 USD plan into a 93.3% ratio
 * and applying that ratio to the Australian price. No such AUD discount exists
 * in the database or in Stripe, so the number was never chargeable and the
 * refusal a click later was correct -- it just arrived after the customer had
 * been shown a price.
 *
 * `discountAmountCents` is a USD amount, so validation now refuses these codes
 * in a non-USD market and the summary refuses to draw a discount it cannot
 * charge. The endpoint is mocked here because what is under test is the
 * client's half of that contract; the server's half, and the parity between the
 * two, is proved in tests/server-contract/promotion-validate-checkout-parity.test.ts
 * and billing-checkout-promotion.test.ts.
 */

const CURRENCY_REFUSAL = {
  valid: false,
  code: "PROMOTION_CURRENCY_NOT_SUPPORTED",
  error:
    "Fixed-amount promotion codes are currently available only for USD checkout. Use a percentage promotion for localized billing.",
};

const KOREAN_REFUSAL =
  "고정 금액 프로모션 코드는 현재 USD 결제에서만 사용할 수 있습니다.";

type Market = {
  currency: "USD" | "AUD";
  country: string;
  /** Monthly price in the market's minor unit. */
  monthlyMinor: number;
  monthlyAmount: number;
};

const AUD: Market = {
  currency: "AUD",
  country: "AU",
  monthlyMinor: 2000,
  monthlyAmount: 20,
};
const USD: Market = {
  currency: "USD",
  country: "US",
  monthlyMinor: 1500,
  monthlyAmount: 15,
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Harness = {
  /** Bodies posted to /api/billing/checkout. Must stay empty on a refusal. */
  checkoutRequests: Record<string, unknown>[];
  /** Bodies posted to /api/billing/promotion/validate. */
  validationRequests: Record<string, unknown>[];
};

async function mockPricing(
  page: Page,
  market: Market,
  validation: { status: number; body: unknown }
): Promise<Harness> {
  const harness: Harness = { checkoutRequests: [], validationRequests: [] };

  await page.route("**/api/auth/session**", (route) =>
    route.fulfill(
      json({
        user: { id: "user_1", email: "buyer@example.com", name: "Buyer" },
        expires: "2099-01-01T00:00:00.000Z",
      })
    )
  );
  await page.route("**/api/user/usage**", (route) =>
    route.fulfill(
      json({
        plan: "Free",
        balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0 },
        limits: { creditsDay: 30, creditsMonth: 300 },
      })
    )
  );

  const plan = (
    id: "free" | "pro" | "max",
    name: string,
    usdMonthly: number,
    displayMinor: number,
    displayAmount: number
  ) => ({
    id,
    name,
    monthlyPriceCents: usdMonthly,
    annualPriceCents: usdMonthly * 12,
    currency: "USD",
    monthlyMessageLimit: 3_000,
    // The market fields the checkout modal actually prices from. Without them
    // it falls back to the USD figures and the defect cannot appear at all.
    baseCurrency: "USD",
    baseMonthlyPriceCents: usdMonthly,
    baseAnnualPriceCents: usdMonthly * 12,
    displayCurrency: market.currency,
    displayMonthlyPriceMinor: displayMinor,
    displayAnnualPriceMinor: displayMinor * 12,
    displayMonthlyPriceAmount: displayAmount,
    displayAnnualPriceAmount: displayAmount * 12,
  });

  await page.route("**/api/billing/config**", (route) =>
    route.fulfill(
      json({
        plans: [
          plan("free", "Free", 0, 0, 0),
          plan("pro", "Pro", 1_500, market.monthlyMinor, market.monthlyAmount),
          plan(
            "max",
            "Max",
            2_500,
            market.monthlyMinor * 2,
            market.monthlyAmount * 2
          ),
        ],
        creditPacks: [],
        featuredPromotion: null,
        displayCurrency: market.currency,
        displayCountry: market.country,
        baseCurrency: "USD",
        pricingMode: "fixed",
      })
    )
  );

  await page.route("**/api/billing/promotion/validate**", async (route) => {
    harness.validationRequests.push(
      JSON.parse(route.request().postData() || "{}")
    );
    await route.fulfill(json(validation.body, validation.status));
  });

  await page.route("**/api/billing/checkout**", async (route) => {
    harness.checkoutRequests.push(
      JSON.parse(route.request().postData() || "{}")
    );
    await route.fulfill(json({ url: "https://example.test/stripe-session" }));
  });

  return harness;
}

/** Opens the Pro checkout modal from the pricing page. */
async function openProCheckout(page: Page, query: string) {
  await page.goto(`/pricing${query}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByTestId("pricing-cta-pro").getByRole("button").first().click();
  await expect(page.getByTestId("checkout-due-today")).toBeVisible();
}

const applyCode = async (page: Page, code: string) => {
  await page.getByRole("textbox", { name: /promo|프로모션/i }).fill(code);
  await page.getByRole("button", { name: /^(Apply|적용)$/ }).click();
};

const toasts = (page: Page) => page.getByTestId("app-toast");

test.describe("a fixed-amount promotion in a market it cannot be charged in", () => {
  test(
    "is refused without ever quoting a discount",
    { tag: "@ui-risk" },
    async ({ page }) => {
      const harness = await mockPricing(page, AUD, {
        status: 400,
        body: CURRENCY_REFUSAL,
      });
      await openProCheckout(page, "?lang=ko");

      // The price before anything is applied.
      await expect(page.getByTestId("checkout-due-today")).toHaveText(/20/);

      await applyCode(page, "PAYMENTTEST27");
      await expect(toasts(page)).toHaveCount(1);

      // 5. the localised refusal, not the server's English sentence.
      await expect(toasts(page)).toContainText(KOREAN_REFUSAL);
      await expect(toasts(page)).not.toContainText("Fixed-amount promotion");

      // 4. no success toast: exactly one toast, and it is the refusal.
      await expect(toasts(page)).not.toContainText("적용되었습니다");

      // 6. no discount row, so no "-$14".
      await expect(page.getByTestId("checkout-promotion-row")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("-$14");

      // 7. due today is still the local price, not A$1.33.
      const due = page.getByTestId("checkout-due-today");
      await expect(due).toHaveText(/20/);
      await expect(due).not.toHaveText(/1\.33/);

      // The customer can still correct the code: the field keeps what they
      // typed rather than being cleared out from under them.
      await expect(
        page.getByRole("textbox", { name: /promo|프로모션/i })
      ).toHaveValue("PAYMENTTEST27");

      // 8. nothing was sent to Checkout.
      expect(harness.checkoutRequests).toEqual([]);
      // Validation was asked about the market it would be charged in.
      expect(harness.validationRequests.at(-1)).toMatchObject({
        currency: "AUD",
        country: "AU",
      });
    }
  );

  test(
    "is not quoted even if validation wrongly says it applies",
    { tag: "@ui-risk" },
    async ({ page }) => {
      // The exact state the defect produced, forced directly: the server says
      // the code is valid, and the summary has a USD fixed discount and an
      // Australian price in front of it. This is the case that used to render
      // "-$14" and "A$1.33 due today".
      //
      // Validation refuses these codes now, so reaching this state needs a
      // server that disagrees -- a stale deployment, a market that changed
      // between the reply and the render, a response that arrived late. The
      // summary decides from what it can charge rather than from what is in
      // state, so none of those can put a price on screen that Checkout will
      // not honour.
      const harness = await mockPricing(page, AUD, {
        status: 200,
        body: {
          valid: true,
          promotion: {
            discountPercent: 0,
            discountAmountCents: 1400,
            durationMonths: 1,
            fulfillmentType: "stripe_subscription",
            accessDurationDays: null,
            paymentMethodRequired: true,
            automaticRenewal: true,
            allowAnnualStacking: false,
          },
        },
      });
      await openProCheckout(page, "?lang=ko");
      await applyCode(page, "PAYMENTTEST27");

      // The apply itself succeeded, so the success toast is correct here. What
      // must not follow is a discount against a currency it cannot be charged
      // in.
      await expect(page.getByTestId("checkout-promotion-row")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("-$14");

      const due = page.getByTestId("checkout-due-today");
      await expect(due).toHaveText(/20/);
      await expect(due).not.toHaveText(/1\.33/);

      // And the button still offers the real price rather than being disabled:
      // the customer can proceed at A$20.00, or clear the code.
      await page
        .getByRole("button", { name: /Continue to checkout|결제 계속하기/ })
        .click();
      await expect
        .poll(() => harness.checkoutRequests.length)
        .toBeGreaterThan(0);
      expect(harness.checkoutRequests[0]).toMatchObject({ currency: "AUD" });
    }
  );
});

test.describe("promotions that can be charged still work", () => {
  test(
    "a percentage promotion discounts the local price and proceeds",
    { tag: "@ui-risk" },
    async ({ page }) => {
      const harness = await mockPricing(page, AUD, {
        status: 200,
        body: {
          valid: true,
          promotion: {
            discountPercent: 50,
            discountAmountCents: null,
            durationMonths: 1,
            fulfillmentType: "stripe_subscription",
            accessDurationDays: null,
            paymentMethodRequired: true,
            automaticRenewal: true,
            allowAnnualStacking: false,
          },
        },
      });
      await openProCheckout(page, "?lang=ko");
      await applyCode(page, "HALFOFF");

      await expect(page.getByTestId("checkout-promotion-row")).toBeVisible();
      await expect(page.getByTestId("checkout-promotion-row")).toContainText(
        "-50%"
      );
      // Half of A$20.00, in AUD -- not a USD figure and not a converted one.
      await expect(page.getByTestId("checkout-due-today")).toHaveText(/10/);

      await page
        .getByRole("button", { name: /Continue to checkout|결제 계속하기/ })
        .click();
      await expect
        .poll(() => harness.checkoutRequests.length)
        .toBeGreaterThan(0);
      expect(harness.checkoutRequests[0]).toMatchObject({
        promoCode: "HALFOFF",
        currency: "AUD",
      });
    }
  );

  test(
    "a fixed-amount promotion in USD subtracts exactly its own amount",
    { tag: "@ui-risk" },
    async ({ page }) => {
      const harness = await mockPricing(page, USD, {
        status: 200,
        body: {
          valid: true,
          promotion: {
            discountPercent: 0,
            discountAmountCents: 1400,
            durationMonths: 1,
            fulfillmentType: "stripe_subscription",
            accessDurationDays: null,
            paymentMethodRequired: true,
            automaticRenewal: true,
            allowAnnualStacking: false,
          },
        },
      });
      await openProCheckout(page, "?lang=en");
      await applyCode(page, "PAYMENTTEST27");

      await expect(page.getByTestId("checkout-promotion-row")).toContainText(
        "-$14"
      );
      // $15.00 - $14.00. An exact subtraction in one currency, which is the
      // only thing a USD-denominated discount can mean.
      await expect(page.getByTestId("checkout-due-today")).toHaveText(/1\.00/);

      await page.getByRole("button", { name: /Continue to checkout/ }).click();
      await expect
        .poll(() => harness.checkoutRequests.length)
        .toBeGreaterThan(0);
      expect(harness.checkoutRequests[0]).toMatchObject({
        promoCode: "PAYMENTTEST27",
        currency: "USD",
      });
    }
  );
});
