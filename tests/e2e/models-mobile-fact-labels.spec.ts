import { expect, test } from "@playwright/test";
import { modelsPageContent } from "@/components/marketing/v2/models/modelsPageContent";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog } from "./support/models-catalog-fixture";

test("English mobile model facts are concise and readable", async ({ page }) => {
  test.setTimeout(90_000);
  const copy = modelsPageContent.en;
  await page.setViewportSize({ width: 320, height: 900 });
  await prepareGuestPage(page, "en");
  await mockModelsCatalog(page);
  await page.goto("/en/models");
  const card = page.getByRole("article").first();
  const credit = card.getByTestId("model-page-credit-cost");
  await expect(credit).toHaveAccessibleName(new RegExp(copy.list.creditLabel), { timeout: 30_000 });
  // The visible figure is the number and its unit, not the long label.
  await expect(credit).toHaveText(/^\d+\s*credits?$/);
  for (const label of [credit.locator("b"), credit.locator("small"), ...await card.locator(".chip").all()]) {
    expect(await label.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
  }
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expectNoHorizontalOverflow(page);
  await page.addStyleTag({ content: "html { font-size: 100%; }" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(credit).toHaveAccessibleName(new RegExp(copy.list.creditLabel));
  await expectNoHorizontalOverflow(page);
});
