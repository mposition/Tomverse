import { expect, test } from "@playwright/test";
import { prepareGuestPage, expectNoHorizontalOverflow } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
for (const theme of ["light", "dark"] as const) {
  test(`terms prose has a readable desktop measure and reflows on phones in ${theme}`, async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.addInitScript(() => localStorage.setItem("tomverse_analytics_consent_v1", "declined"));
    await setDeterministicTheme(page, theme);
    await page.goto("/terms?lang=en");
    const paragraphs = page.locator("main article > div > p").filter({ hasText: /.+/ });
    await expect(page.getByRole("heading", { name: "Agreement, operator, and contact" })).toBeVisible();
    expect(await paragraphs.count()).toBeGreaterThan(5);
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const paragraph of await paragraphs.all()) {
      const sample = await paragraph.evaluate(node => {
        const style = getComputedStyle(node);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = style.font;
        return { characters: node.getBoundingClientRect().width / context.measureText("0").width, fontSize: parseFloat(style.fontSize) };
      });
      expect(sample.characters).toBeGreaterThanOrEqual(70);
      expect(sample.characters).toBeLessThanOrEqual(85);
      expect(sample.fontSize).toBeGreaterThanOrEqual(16);
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await expectNoHorizontalOverflow(page);
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expectNoHorizontalOverflow(page);
  });
}
