import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`privacy consent gives its policy link a separate complete line in ${theme}`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/privacy?lang=en");
    const notice = page.getByTestId("chat-consent-notice");
    const link = notice.getByRole("link", { name: "Privacy policy", exact: true });
    await expect(link).toHaveCSS("display", "block", { timeout: 30_000 });
    for (const size of ["100%", "200%"]) {
      await page.addStyleTag({ content: `html { font-size: ${size}; }` });
      const sample = await link.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element.parentElement!.firstChild!);
        const end = range.getBoundingClientRect().bottom;
        range.selectNodeContents(element);
        return { aboveEnd: end, top: element.getBoundingClientRect().top, lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size };
      });
      expect(sample.lines).toBe(1);
      expect(sample.top).toBeGreaterThan(sample.aboveEnd);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await notice.getByRole("button", { name: "Decline", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(notice).toBeHidden();
  });
}
