import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`mobile English catalog reaches models sooner in ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/models?lang=en");
    await expect(page.getByTestId("chat-consent-notice")).toBeVisible({ timeout: 30_000 });
    const first = page.getByRole("article").first();
    await expect(first).toBeVisible();
    // The analytics notice above the page is shown once and its copy is explicit by design (#3571, #3592); measure the catalogue's own intro.
    const consentHeight = await page.getByTestId("marketing-consent-slot").evaluate(node => node.getBoundingClientRect().height);
    expect(await first.evaluate(node => node.getBoundingClientRect().top + scrollY) - consentHeight).toBeLessThan(800);
    const details = page.getByTestId("models-mobile-usage-details");
    await expect(details).not.toHaveAttribute("open", "");
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(details.locator("p")).toBeVisible();
    await expect(details).toContainText("1.5×, 2× or 3×");
    await expect(details).toContainText("not a guarantee of data residency");
    await page.keyboard.press("Enter");
    await expect(details).not.toHaveAttribute("open", "");
    const status = page.getByTestId("models-status-link");
    expect((await status.boundingBox())!.height).toBeLessThanOrEqual(80);
    await expect(status).toHaveAttribute("target", "_blank");
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("desktop English catalog keeps complete usage and region guidance", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/models?lang=en");
  await expect(page.getByTestId("models-mobile-usage-details")).toBeHidden();
  await expect(page.getByText(/Credit categories are separate from subscription plans/).last()).toBeVisible();
  await expect(page.getByText(/Compare access plans, base credits, image input and catalog context limits/)).toBeVisible();
});
