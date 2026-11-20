import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog } from "./support/models-catalog-fixture";

// On a phone the filter rows start collapsed, so the first model is reached within
// about one and a half screens even with the consent notice open.
test("mobile English catalog reaches models sooner", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await prepareGuestPage(page, "en");
  await mockModelsCatalog(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
  await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
  await page.goto("/models?lang=en");
  await expect(page.getByTestId("chat-consent-notice")).toBeVisible({ timeout: 30_000 });
  const first = page.getByRole("article").first();
  await expect(first).toBeVisible();
  expect(await first.evaluate((node) => node.getBoundingClientRect().top + scrollY)).toBeLessThan(1400);
  const details = page.locator("#model-input-credit-guide");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(details.locator("p").first()).toBeVisible();
  await expect(details).toContainText("1.5× base credits");
  await expect(details).toContainText("2× base credits");
  await expect(details).toContainText("3× base credits");
  await page.keyboard.press("Enter");
  await expect(details).not.toHaveAttribute("open", "");
  const status = page.getByTestId("models-status-link");
  await expect(status).toHaveAttribute("target", "_blank");
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("desktop English catalog keeps complete credit and plan guidance visible", async ({ page }) => {
  const copy = modelsPageContent.en;
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await mockModelsCatalog(page);
  await page.goto("/models?lang=en");
  await expect(page.getByText(copy.credits.body)).toBeVisible();
  await expect(page.getByText(copy.list.planNote)).toBeVisible();
  await expect(page.getByText(copy.hero.body)).toBeVisible();
});
