import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const path of ["/?lang=ko", "/ko"]) for (const theme of ["light", "dark"] as const) {
  test(`Korean home supporting text is readable on ${path} in ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto(path);
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    const layout = await notice.evaluate((node) => {
      const paragraphs = [...node.querySelectorAll("p")].filter((item) => item.getBoundingClientRect().height > 0);
      const buttons = [...node.querySelectorAll("button")].filter((item) => item.getBoundingClientRect().height > 0);
      return { sizes: paragraphs.map((item) => parseFloat(getComputedStyle(item).fontSize)), bodyBottom: Math.max(...paragraphs.map((item) => item.getBoundingClientRect().bottom)), actionTop: Math.min(...buttons.map((item) => item.getBoundingClientRect().top)) };
    });
    expect(layout.sizes.every((size) => size >= 14)).toBe(true);
    expect(layout.actionTop).toBeGreaterThan(layout.bodyBottom);
    await expectAccessibleContrast(notice.locator("p:visible").last(), "Home consent text");
    await expectAccessibleContrast(notice.getByRole("link"), "Home consent privacy link");
    const note = page.locator('figure[aria-label="Tomverse Chat"] figcaption > span');
    await expect(note).toContainText("실제 모델 평가");
    expect(await note.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    await expectAccessibleContrast(note, "Illustrative example disclosure");
    await expectAccessibleContrast(page.getByTestId("launch-motion-toggle"), "Home motion control");
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
