import { expect, test } from "@playwright/test";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

// The V2 document stacks every clause heading above its text, at every width, so
// the heading must sit directly above the first paragraph of its own section --
// never beside it, below it or a screen away.
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
      const body = paragraph.getBoundingClientRect();
      return { titleBottom: title.bottom, bodyTop: body.top, titleLeft: title.left, bodyRight: body.right };
    });
    expect(metrics.titleBottom).toBeLessThanOrEqual(metrics.bodyTop);
    expect(metrics.bodyTop - metrics.titleBottom).toBeLessThan(48);
    expect(metrics.titleLeft).toBeLessThan(metrics.bodyRight);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
