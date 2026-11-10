import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`English mobile model facts are concise and readable in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.goto("/en/models");
    const card = page.getByRole("article").first();
    const access = card.getByTestId("model-access-label");
    const credits = card.getByTestId("model-base-charge-label");
    await expect(access.locator("span:visible")).toHaveText("Access", { timeout: 30_000 });
    await expect(credits.locator("span:visible")).toHaveText("Base credits");
    for (const label of [access, credits, ...await card.locator("span.rounded-full").all()]) {
      expect(await label.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    }
    await expect(card.getByTestId("model-page-credit-cost")).toHaveAccessibleName(/Base credits for a short request/);
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expectNoHorizontalOverflow(page);
    await page.addStyleTag({ content: "html { font-size: 100%; }" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(access.locator("span:visible")).toHaveText("Access starts with");
    await expect(credits.locator("span:visible")).toHaveText("Base credits for a short request");
  });
}
