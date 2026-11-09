import { expect, test } from "@playwright/test";
import { mockPublicBillingConfig } from "./support/app-fixtures";

test("annual totals explain their period and monthly equivalent before sign-in", async ({ page }) => {
  await mockPublicBillingConfig(page);
  await page.goto("/pricing?lang=en");
  for (const [plan, annual, monthly] of [["pro", "$144", "$12.00"], ["max", "$240", "$20.00"]]) {
    const card = page.getByTestId(`pricing-plan-card-${plan}`);
    await expect(card.getByText(`${annual} per year`, { exact: true })).toBeVisible();
    await expect(card.getByText("Annual · billed annually", { exact: true })).toBeVisible();
    await expect(page.getByTestId(`pricing-annual-equivalent-${plan}`)).toHaveText(`Monthly equivalent: about ${monthly}, billed annually.`);
    await expect(page.getByTestId(`pricing-billing-choice-${plan}`)).toHaveText("Choose monthly or annual billing in the next step after signing in, before payment.");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const scenario of [
  { name: "zero-decimal base currency", plan: { currency: "KRW", annualPriceCents: 144_000 }, expected: "₩12,000" },
  { name: "localized display amount", plan: { currency: "USD", annualPriceCents: 14_400, displayCurrency: "AUD", displayAnnualPriceAmount: 215 }, expected: "A$17.92" },
]) {
  test(`monthly equivalent respects ${scenario.name}`, async ({ page }) => {
    await page.route("**/api/billing/config**", (route) => route.fulfill({ json: {
      plans: [{ id: "pro", name: "Pro", monthlyPriceCents: 1_500, ...scenario.plan }],
      creditPacks: [], featuredPromotion: null,
    } }));
    await page.goto("/pricing?lang=en");
    await expect(page.getByTestId("pricing-annual-equivalent-pro")).toHaveText(`Monthly equivalent: about ${scenario.expected}, billed annually.`);
  });
}
