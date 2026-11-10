import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const path of ["/support/help-centre?lang=en", "/en/support/help-centre"]) for (const theme of ["light", "dark"] as const) {
  test(`Help Centre consent is readable on ${path} in ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto(path);
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const body = notice.locator("p:visible").last();
    const privacy = notice.getByRole("link", { name: "Privacy policy" });
    const accept = notice.getByRole("button", { name: "Allow analytics", exact: true });
    const decline = notice.getByRole("button", { name: "Decline", exact: true });
    expect(await body.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    // The Help Centre shows the full consent body (#3581,
    // help-centre-analytics-scope), not the compact phone summary.
    await expect(body).toContainText("Prompts, responses, filenames, and file contents are never included", { useInnerText: true });
    await expect(body).toContainText("Privacy policy");
    expect((await accept.boundingBox())!.y).toBeGreaterThan((await body.boundingBox())!.y + (await body.boundingBox())!.height);
    expect(await privacy.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size; })).toBe(1);
    await expectAccessibleContrast(body, "Consent body");
    await expectAccessibleContrast(privacy, "Privacy link");
    await decline.focus();
    await page.keyboard.press("Enter");
    await expect(notice).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
