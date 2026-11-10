import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

for (const currency of ["USD", "AUD"] as const) {
  test(`mobile plan summary uses current ${currency} prices and credits`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    const plans = [
      { id: "free", name: "Free", monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD", monthlyMessageLimit: 450, displayCurrency: currency, displayMonthlyPriceAmount: 0 },
      { id: "pro", name: "Pro", monthlyPriceCents: 1500, annualPriceCents: 14400, currency: "USD", monthlyMessageLimit: 3456, displayCurrency: currency, displayMonthlyPriceAmount: currency === "USD" ? 15 : 20 },
      { id: "max", name: "Max", monthlyPriceCents: 2500, annualPriceCents: 24000, currency: "USD", monthlyMessageLimit: 9876, displayCurrency: currency, displayMonthlyPriceAmount: currency === "USD" ? 25 : 39 },
    ];
    await page.route("**/api/billing/config**", route => route.fulfill({ json: { plans, creditPacks: [], featuredPromotion: null } }));
    let checkouts = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/billing/checkout")) checkouts++; });
    await page.goto("/pricing?lang=en");
    const summary = page.getByTestId("pricing-mobile-plan-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByRole("listitem")).toHaveCount(3);
    for (const [index, plan] of plans.entries()) {
      const row = summary.getByRole("listitem").nth(index);
      await expect(row).toContainText(`${plan.monthlyMessageLimit.toLocaleString("en-US")} monthly credits`);
      await expect(row.getByRole("heading")).toContainText(`${currency === "AUD" ? "A$" : "$"}${plan.displayMonthlyPriceAmount.toFixed(2)}`);
      await expect(row.getByRole("link")).toBeInViewport();
      const box = (await row.getByRole("link").boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(900);
    }
    const max = summary.getByRole("link", { name: "View Max plan options" });
    await max.focus(); await page.keyboard.press("Enter");
    const heading = page.locator("#pricing-plan-name-max");
    await expect(heading).toBeFocused(); await expect(heading).toBeInViewport();
    await expect(page.getByTestId("pricing-cta-max")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await page.getByTestId("pricing-cta-max").evaluate(node => node.contains(document.activeElement))).toBe(true);
    expect(checkouts).toBe(0);
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await summary.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    for (const row of await summary.getByRole("listitem").all()) {
      const name = (await row.getByRole("heading").boundingBox())!;
      const action = (await row.getByRole("link").boundingBox())!;
      expect(name.y + name.height <= action.y + 1 || name.x + name.width <= action.x + 1).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("desktop keeps its existing full plan comparison without the phone summary", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/pricing?lang=en");
  await expect(page.getByTestId("pricing-mobile-plan-summary")).toBeHidden();
  await expect(page.getByTestId("pricing-plan-card-pro")).toBeVisible();
});
