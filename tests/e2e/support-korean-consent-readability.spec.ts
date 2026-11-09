import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`support consent is readable with separate actions at ${width}px in ${theme}`, async ({ page, baseURL }, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit phone and desktop viewports.");
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/support?lang=ko");
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    const notice = page.getByTestId("marketing-consent-slot").getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    const metrics = await notice.evaluate(element => {
      const visible = (selector: string) => Array.from(element.querySelectorAll(selector)).filter(node => node.getBoundingClientRect().height > 0);
      const paragraphs = visible("p");
      const buttons = visible("button");
      return {
        fonts: visible("p,a,button").map(node => Number.parseFloat(getComputedStyle(node).fontSize)),
        leading: paragraphs.map(node => Number.parseFloat(getComputedStyle(node).lineHeight)),
        explanationBottom: Math.max(...paragraphs.map(node => node.getBoundingClientRect().bottom)),
        actionTop: Math.min(...buttons.map(node => node.getBoundingClientRect().top)),
        linkLines: visible("a").map(node => node.getClientRects().length),
        targets: buttons.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
      };
    });
    expect(metrics.fonts.every(size => size >= 14)).toBe(true);
    expect(metrics.leading.every(size => size >= 20)).toBe(true);
    expect(metrics.actionTop).toBeGreaterThan(metrics.explanationBottom);
    expect(metrics.linkLines).toEqual([1]);
    expect(metrics.targets.every(box => box.width >= 44 && box.height >= 44)).toBe(true);
    await expectAccessibleContrast(notice.locator("p:visible").last(), "Support consent explanation");
    await expectAccessibleContrast(notice.getByRole("link"), "Support privacy link");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toBeHidden();
  });
}
