import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { mockModelsCatalog } from "./support/models-catalog-fixture";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const width of [320, 1440]) {
  test(`Korean model text keeps words whole at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await mockModelsCatalog(page);
    await page.goto("/models?lang=ko");
    const title = page.getByTestId("models-title");
    expect(await renderedWordLineCount(title, "목록에서.")).toBe(1);
    const intro = page.locator(".hero-lede");
    for (const word of ["여부로", "모델입니다."]) expect(await renderedWordLineCount(intro, word)).toBe(1);
    const heading = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Claude Fable 5.2", exact: true }) }).getByRole("heading");
    expect(await renderedWordLineCount(heading, "Fable")).toBe(1);
    const plan = page.getByRole("article").first().locator(".chip").first();
    await expect(plan).toBeVisible();
    if (width === 320) {
      await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
      await intro.evaluate((node) => { node.textContent += ` https://example.com/${"long".repeat(30)}`; });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
