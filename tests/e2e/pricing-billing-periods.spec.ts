import { expect, test } from "@playwright/test";
import { mockPublicBillingConfig } from "./support/app-fixtures";

test("annual totals explain their period and monthly equivalent before sign-in", async ({ page }) => {
  await mockPublicBillingConfig(page);
  await page.goto("/pricing?lang=en");
  for (const [plan, annual, monthly] of [["pro", "$144", "$12.00"], ["max", "$240", "$20.00"]]) {
    const card = page.getByTestId(`pricing-plan-card-${plan}`);
    await expect(card.getByText(`${annual} per year`, { exact: true })).toBeVisible();
    await expect(card.getByText("Annual · billed annually", { exact: true })).toBeVisible();
    await expect(page.getByTestId(`pricing-annual-equivalent-${plan}`)).toHaveText(`Monthly equivalent: ${monthly}, billed annually.`);
    await expect(page.getByTestId(`pricing-billing-choice-${plan}`)).toHaveText("Choose monthly or annual billing in the next step after signing in, before payment.");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
