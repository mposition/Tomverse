import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`Korean plugin tabs preserve words and keyboard switching in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 800 });
    await prepareGuestPage(page, "ko", "studio", "studio");
    await mockAuthenticatedApi(page);
    await setDeterministicTheme(page, theme);
    await page.route("**/api/mcp/connections", route => route.fulfill({ json: { enabled: false, servers: [], connections: [], invocations: [] } }));
    await page.goto("/plugins?lang=ko");
    const all = page.getByRole("button", { name: "전체 플러그인", exact: true });
    await expect(all).toBeVisible({ timeout: 30_000 });
    expect(await renderedWordLineCount(all, "플러그인")).toBe(1);
    await expect(all).toHaveCSS("word-break", "keep-all");
    for (const label of ["연결됨", "승인 대기", "전체 플러그인"]) {
      const button = page.getByRole("button", { name: label, exact: true });
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    expect(await renderedWordLineCount(all, "플러그인")).toBe(1);
    await expectNoHorizontalOverflow(page);
  });
}
