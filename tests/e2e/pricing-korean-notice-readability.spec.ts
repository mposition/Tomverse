import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`Korean pricing annual notes are readable at ${width}px in ${theme}`, async ({ page, baseURL }, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit phone and desktop viewports.");
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/pricing?lang=ko");
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    const annualNotes = page.getByTestId("pricing-annual-checkout-note");
    await expect(annualNotes).toHaveCount(2);
    for (const note of await annualNotes.all()) {
      await note.scrollIntoViewIfNeeded();
      const typography = await note.evaluate(element => ({ size: Number.parseFloat(getComputedStyle(element).fontSize), leading: Number.parseFloat(getComputedStyle(element).lineHeight) }));
      expect(typography.size).toBeGreaterThanOrEqual(14);
      expect(typography.leading).toBeGreaterThanOrEqual(20);
      await expectAccessibleContrast(note, "Annual checkout explanation");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toBeHidden();
  });
}
