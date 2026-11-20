import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog } from "./support/models-catalog-fixture";

// Korean phone layout: the model cards start promptly, the filters and the credit
// guide are expandable, and nothing overflows even with the browser's text enlarged.
test("Korean mobile model cards start promptly with expandable guidance", async ({ page, baseURL }) => {
  const copy = modelsPageContent.ko;
  await page.setViewportSize({ width: 320, height: 900 });
  await prepareGuestPage(page, "ko");
  await mockModelsCatalog(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
  await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
  await page.goto("/models?lang=ko");
  await expect(page.getByTestId("chat-consent-notice")).toBeVisible();
  const firstCard = page.getByRole("article").first();
  await expect(firstCard).toBeVisible();
  expect(await firstCard.evaluate((node) => node.getBoundingClientRect().top + scrollY)).toBeLessThan(1400);
  // The count stays visible while the filter rows are collapsed.
  await expect(page.getByTestId("models-count")).toBeVisible();
  const filters = page.locator("#models-catalog-filters");
  await expect(filters).toBeHidden();
  const toggle = page.getByTestId("models-mobile-filters-toggle");
  await toggle.click();
  await expect(filters.getByRole("button", { name: copy.list.plans.Guest, exact: true })).toBeVisible();
  await toggle.click();
  await expect(filters).toBeHidden();

  const details = page.locator("#model-input-credit-guide");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").focus();
  await details.locator("summary").press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(details.getByTestId("model-input-credit-band").nth(1)).toContainText("1.5배");
  await details.locator("summary").press("Enter");
  await expect(details).not.toHaveAttribute("open", "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("desktop keeps the complete Korean credit guidance visible", async ({ page }) => {
  const copy = modelsPageContent.ko;
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "ko");
  await mockModelsCatalog(page);
  await page.goto("/models?lang=ko");
  await expect(page.getByTestId("models-mobile-filters-toggle")).toBeHidden();
  await expect(page.getByText(copy.credits.body)).toBeVisible();
  await expect(page.getByText(copy.list.planNote)).toBeVisible();
});
