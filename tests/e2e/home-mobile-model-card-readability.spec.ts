import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const width of [320, 390]) for (const theme of ["light", "dark"] as const) {
  test(`mobile home model cards are level and use one readable note at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.goto("/?lang=en");
    const cards = page.getByTestId("launch-model-stamp");
    await expect(cards).toHaveCount(3);
    const tops = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS("transform", "none");
      await expect(card).toHaveCSS("animation-name", "none");
      await expect(card.locator("span")).toBeHidden();
      await expectAccessibleContrast(card.locator("strong"), "Mobile model name");
    }
    const note = page.getByTestId("launch-mobile-model-note");
    await expect(note).toBeVisible();
    await expect(page.getByText("Choose in one place", { exact: true }).filter({ visible: true })).toHaveCount(1);
    expect(await note.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    await expectAccessibleContrast(note, "Shared mobile model explanation");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
