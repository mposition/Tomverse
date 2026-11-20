import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog, modelsCatalogFixture } from "./support/models-catalog-fixture";

test.setTimeout(90_000);

// Cards in one grid row share a top and a height, and every credit figure sits at
// the same distance from its card's right edge, so the numbers read as one column.
test("aligns every card and credit figure across the grid", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockModelsCatalog(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/en/models");
  const cards = page.locator("article[data-model-id]");
  await expect(cards).toHaveCount(modelsCatalogFixture.length, { timeout: 60_000 });
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const rows = await cards.evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const credit = node.querySelector('[data-testid="model-page-credit-cost"]')!.getBoundingClientRect();
      return { top: Math.round(box.top), height: Math.round(box.height), creditInset: Math.round(box.right - credit.right) };
    }));
    const byTop = new Map<number, typeof rows>();
    for (const row of rows) byTop.set(row.top, [...(byTop.get(row.top) ?? []), row]);
    expect(byTop.size).toBeGreaterThan(1);
    for (const sameRow of byTop.values()) {
      for (const row of sameRow) expect(Math.abs(row.height - sameRow[0].height)).toBeLessThanOrEqual(1);
    }
    for (const row of rows) expect(Math.abs(row.creditInset - rows[0].creditInset)).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(cards.first()).toHaveCSS("display", "grid");
  await expectNoHorizontalOverflow(page);
});
