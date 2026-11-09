import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const width of [320, 390]) for (const theme of ["light", "dark"] as const) {
  test(`Korean home title keeps its brand and period together at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    for (const path of ["/?lang=ko", "/ko"]) {
      await page.goto(path);
      const ending = page.getByTestId("landing-hero-title").locator("span").last();
      expect(await renderedWordLineCount(ending, "Tomverse에.")).toBe(1);
      expect(await ending.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(32);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}
