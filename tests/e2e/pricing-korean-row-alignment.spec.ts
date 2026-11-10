import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

async function expectAligned(page: Page) {
  const tops = await Promise.all(["free", "pro", "max"].map(async id => ({
    cta: (await page.getByTestId(`pricing-cta-${id}`).boundingBox())!.y,
    features: (await page.getByTestId(`pricing-plan-card-${id}`).locator(":scope > ul").boundingBox())!.y,
  })));
  for (const key of ["cta", "features"] as const) expect(Math.max(...tops.map(top => top[key])) - Math.min(...tops.map(top => top[key]))).toBeLessThanOrEqual(1);
}

for (const theme of ["light", "dark"] as const) for (const promotion of [false, true]) {
  test(`Korean plan rows align in ${theme}, promotion ${promotion}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.route("**/api/billing/config**", route => route.fulfill({ json: {
      plans: [
        { id: "free", name: "Free", monthlyMessageLimit: 300, monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD" },
        { id: "pro", name: "Pro", monthlyMessageLimit: 6000, monthlyPriceCents: 1900, annualPriceCents: 18240, currency: "USD" },
        { id: "max", name: "Max", monthlyMessageLimit: 20000, monthlyPriceCents: 4900, annualPriceCents: 47040, currency: "USD" },
      ], creditPacks: [], featuredPromotion: promotion ? { code: "LAYOUT_FIXTURE", discountPercent: 50, discountAmountCents: null, durationMonths: 1, appliesToPlanIds: ["pro", "max"], billingIntervals: ["monthly"], endsAt: "2099-03-01T00:00:00.000Z" } : null,
    } }));
    await page.goto("/pricing?lang=ko");
    await expect(page.getByTestId("pricing-plan-card-pro")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pricing-sale-block")).toHaveCount(promotion ? 2 : 0);
    await expect(page.locator("main")).not.toContainText("NaN");
    await expectAligned(page);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await expectAligned(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expectAligned(page);
    await expectNoHorizontalOverflow(page);
    await page.addStyleTag({ content: "html { font-size: 100%; }" });
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.getByTestId("pricing-annual-placeholder")).toBeHidden();
    const mobileGap = await page.getByTestId("pricing-plan-card-free").getByTestId("pricing-plan-usage").evaluate(element => {
      let previous = element.previousElementSibling!;
      while (getComputedStyle(previous).display === "none") previous = previous.previousElementSibling!;
      return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    expect(mobileGap).toBeGreaterThanOrEqual(11);
    expect(mobileGap).toBeLessThanOrEqual(13);
    await expectNoHorizontalOverflow(page);
  });
}
