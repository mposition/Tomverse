import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// V2 has no separate phone summary: the three plan cards stack, each with its own price,
// credits and button, so a phone reads the same data a desktop does.
for (const currency of ["USD", "AUD"] as const) {
  test(`mobile plan cards use current ${currency} prices and credits`, async ({ page, baseURL }) => {
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
    for (const plan of plans) {
      const card = page.getByTestId(`pricing-plan-card-${plan.id}`);
      await expect(card.getByTestId("pricing-plan-usage")).toContainText(plan.monthlyMessageLimit.toLocaleString("en-AU"));
      await expect(card.getByTestId("pricing-plan-price")).toContainText(`${currency === "AUD" ? "A$" : "$"}${plan.displayMonthlyPriceAmount.toFixed(2)}`);
      await expect(card.locator("h3")).toHaveText(plan.name);
    }
    // Cards stack on a phone, in the order Free, Pro, Max, and each action is reachable.
    const tops = await Promise.all(["free", "pro", "max"].map(async id => (await page.getByTestId(`pricing-plan-card-${id}`).boundingBox())!.y));
    expect(tops[0]).toBeLessThan(tops[1]);
    expect(tops[1]).toBeLessThan(tops[2]);
    const cta = page.getByTestId("pricing-cta-max");
    await cta.scrollIntoViewIfNeeded();
    await expect(cta).toBeVisible();
    await expect(page.locator("#pricing-plan-name-max")).toHaveCount(1);
    expect(checkouts).toBe(0);
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("desktop shows the three plan cards side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/pricing?lang=en");
  const boxes = await Promise.all(["free", "pro", "max"].map(async id => (await page.getByTestId(`pricing-plan-card-${id}`).boundingBox())!));
  expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThanOrEqual(1);
  expect(boxes[0].x).toBeLessThan(boxes[1].x);
  expect(boxes[1].x).toBeLessThan(boxes[2].x);
});
