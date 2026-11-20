import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const theme of ["light", "dark"] as const) {
  test(`Korean assistant settings consent is readable in ${theme}`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await setDeterministicTheme(page, theme);
    await page.route("**/api/assistant-profiles", route => route.fulfill({ json: { profiles: [], limits: { maxProfilesPerAccount: 20 } } }));
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/settings/assistants?lang=ko");
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const body = notice.locator("p:visible").last();
    const privacy = notice.getByRole("link", { name: "개인정보 처리방침" });
    const accept = notice.getByRole("button", { name: "사용 통계 허용", exact: true });
    const decline = notice.getByRole("button", { name: "거부", exact: true });
    await expect(body).toContainText("기능 사용·유입 경로 통계를 수집해 제품을 개선합니다");
    expect(await body.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    const bodyBox = (await body.boundingBox())!;
    expect((await accept.boundingBox())!.y).toBeGreaterThan(bodyBox.y + bodyBox.height);
    const textEnd = await body.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node.firstChild!); return range.getBoundingClientRect().bottom;
    });
    expect((await privacy.boundingBox())!.y).toBeGreaterThanOrEqual(textEnd);
    expect(await privacy.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size; })).toBe(1);
    await expectAccessibleContrast(body, "Consent body");
    await expectAccessibleContrast(privacy, "Privacy link");
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await decline.focus();
    await page.keyboard.press("Enter");
    await expect(notice).toBeHidden();
  });
}
