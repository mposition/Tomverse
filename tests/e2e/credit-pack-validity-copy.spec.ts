import { expect, test } from "@playwright/test";
import { mockPublicBillingConfig } from "./support/app-fixtures";

for (const [locale, validity] of [["en", "Valid for 365 days"], ["ko", "365일 유효"]]) {
  test(`credit-pack validity uses the catalog day count in ${locale}`, async ({ page }) => {
    await mockPublicBillingConfig(page);
    await page.goto(`/pricing?lang=${locale}`);
    const cards = page.locator("article[data-pack-id]");
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) {
      await expect(card.getByText(validity, { exact: true })).toBeVisible();
    }
  });
}
