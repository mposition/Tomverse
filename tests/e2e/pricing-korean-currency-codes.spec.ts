import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { billingMinorToMajor, formatBillingAmount, type BillingCurrency } from "../../lib/billingMarkets";

// Public billing-response fixtures exercise display behavior without changing the catalog.
const planPrices = {
  pro: { AUD: { monthly: 2_000, annual: 19_200 }, KRW: { monthly: 20_000, annual: 192_000 } },
  max: { AUD: { monthly: 3_900, annual: 37_400 }, KRW: { monthly: 35_000, annual: 336_000 } },
};
const packPrices = { USD: 499, AUD: 700, KRW: 7_000 };

for (const scenario of ["USD", "AUD", "KRW", "partial", "unavailable"] as const) {
  test(`Korean prices identify the actual display currency with ${scenario} metadata`, async ({ page }, info) => {
    await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
    await prepareGuestPage(page, "ko");
    const currency: BillingCurrency = scenario === "AUD" ? "AUD" : scenario === "KRW" || scenario === "partial" ? "KRW" : "USD";
    const plans = (["free", "pro", "max"] as const).map(id => {
      const baseMonthly = id === "free" ? 0 : id === "pro" ? 1_500 : 2_500;
      const baseAnnual = id === "free" ? 0 : id === "pro" ? 14_400 : 24_000;
      const prices = id === "free" ? { monthly: 0, annual: 0 } : currency === "USD" ? { monthly: baseMonthly, annual: baseAnnual } : planPrices[id][currency as "AUD" | "KRW"];
      return { id, name: id === "free" ? "Free" : id === "pro" ? "Pro" : "Max", currency: "USD", monthlyPriceCents: baseMonthly, annualPriceCents: baseAnnual,
        displayCurrency: currency, displayMonthlyPriceAmount: scenario === "partial" ? undefined : billingMinorToMajor(prices.monthly, currency), displayAnnualPriceAmount: billingMinorToMajor(prices.annual, currency) };
    });
    const packMinor = packPrices[currency as keyof typeof packPrices];
    const promotion = scenario === "AUD" || scenario === "partial";
    await page.route("**/api/billing/config**", route => scenario === "unavailable" ? route.fulfill({ status: 503, body: "" }) : route.fulfill({ json: {
      plans, displayCurrency: currency, featuredPromotion: promotion ? { code: "CURRENCY_FIXTURE", discountPercent: 50, durationMonths: 1, appliesToPlanIds: ["pro", "max"], billingIntervals: ["monthly"], endsAt: "2099-01-01T00:00:00.000Z" } : null,
      creditPacks: [{ id: "starter_500", name: "Starter", credits: 500, priceMinor: packMinor, priceCents: 499, currency, validityDays: 365, allowedPlans: ["Free", "Pro", "Max"] }],
    } }));
    await page.goto("/pricing?lang=ko");
    const pro = page.getByTestId("pricing-plan-card-pro");
    const monthlyCurrency = scenario === "partial" || scenario === "unavailable" ? "USD" : currency;
    const annualCurrency = scenario === "unavailable" ? "USD" : currency;
    if (scenario === "unavailable") {
      await expect(pro).toContainText("$15 USD");
      await expect(pro).toContainText("$144 USD");
    } else {
      const monthly = scenario === "partial" ? "$15" : formatBillingAmount(plans[1].displayMonthlyPriceAmount!, currency);
      await expect(pro).toContainText(`${monthly} ${monthlyCurrency}`);
      await expect(pro).toContainText(`${formatBillingAmount(plans[1].displayAnnualPriceAmount, currency)} ${annualCurrency}`);
      await expect(page.getByTestId("pricing-credit-packs")).toContainText(`${formatBillingAmount(billingMinorToMajor(packMinor, currency), currency)} ${currency}`);
      if (promotion) await expect(pro).toContainText(scenario === "partial" ? "$7.5 USD" : "A$10.00 AUD");
    }
    await expect(pro).toContainText(`표시 통화: ${annualCurrency}. 최종 결제 통화와 금액은 결제 화면에서 확인하세요.`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("Korean purchase details keep the same final-currency confirmation guidance", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "ko");
  await page.route("**/api/auth/session**", route => route.fulfill({ json: { user: { id: "currency-buyer", email: "buyer@example.com", name: "Buyer" }, expires: "2099-01-01T00:00:00.000Z" } }));
  await page.route("**/api/user/usage**", route => route.fulfill({ json: { plan: "Free", subscription: { status: null, billingInterval: null }, balances: { planRemainingCredits: 300, purchasedRemainingCredits: 0 }, limits: { creditsDay: 30, creditsMonth: 300 } } }));
  await page.route("**/api/billing/config**", route => route.fulfill({ json: { displayCurrency: "AUD", displayCountry: "AU", featuredPromotion: null, creditPacks: [], plans: [
    { id: "free", name: "Free", currency: "USD", monthlyPriceCents: 0, annualPriceCents: 0, displayCurrency: "AUD", displayMonthlyPriceAmount: 0, displayAnnualPriceAmount: 0 },
    { id: "pro", name: "Pro", currency: "USD", monthlyPriceCents: 1500, annualPriceCents: 14400, displayCurrency: "AUD", displayMonthlyPriceAmount: 20, displayAnnualPriceAmount: 192 },
    { id: "max", name: "Max", currency: "USD", monthlyPriceCents: 2500, annualPriceCents: 24000, displayCurrency: "AUD", displayMonthlyPriceAmount: 39, displayAnnualPriceAmount: 374 },
  ] } }));
  let checkouts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/billing/checkout")) checkouts++; });
  await page.goto("/pricing?lang=ko");
  await page.getByTestId("pricing-cta-pro").getByRole("button").first().click();
  await expect(page.getByTestId("checkout-due-today")).toBeVisible();
  await expect(page.getByText(/^표시 금액: .*최종 결제 통화와 금액은 결제 화면에서 확인하세요\.$/)).toBeVisible();
  expect(checkouts).toBe(0);
});
