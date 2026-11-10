import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

test.setTimeout(90_000);
for (const theme of ["light", "dark"] as const) {
  test(`${theme} aligns every comparison row across model cards`, async ({ page }) => {
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/en/models");
    const cards = page.locator("article");
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    for (const width of [1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const rows = await cards.evaluateAll((nodes) => nodes.map((node) => ({
        top: node.getBoundingClientRect().top,
        facts: [...node.querySelectorAll("div.mt-5 > div")].map((fact) => fact.getBoundingClientRect().top),
      })));
      expect(rows.length).toBeGreaterThan(3);
      for (let i = 0; i < rows.length; i += 3) {
        for (const row of rows.slice(i, i + 3)) {
          for (let fact = 0; fact < 5; fact++) {
            expect(Math.abs(row.facts[fact] - rows[i].facts[fact])).toBeLessThanOrEqual(1);
          }
        }
      }
      await expectNoHorizontalOverflow(page);
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(cards.first()).toHaveCSS("display", "block");
    await expectNoHorizontalOverflow(page);
  });
}
