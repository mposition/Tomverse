import { expect, test } from "@playwright/test";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`privacy provider heading starts with its section at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setDeterministicTheme(page, theme);
    await page.goto("/privacy?lang=en");
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "External AI providers", exact: true }) });
    await expect(section).toBeVisible();
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    const metrics = await section.evaluate((node) => {
      const heading = node.querySelector("h2")!;
      const paragraph = node.querySelector(":scope > div > p")!;
      const range = document.createRange();
      const text = [...heading.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())!;
      range.selectNodeContents(text);
      const title = range.getBoundingClientRect();
      return { titleTop: title.top, titleBottom: title.bottom, bodyTop: paragraph.getBoundingClientRect().top };
    });
    if (width >= 768) expect(Math.abs(metrics.titleTop - metrics.bodyTop)).toBeLessThan(10);
    else expect(metrics.titleBottom).toBeLessThanOrEqual(metrics.bodyTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
