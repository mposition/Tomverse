import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

test.use({ hasTouch: true, timezoneId: "Australia/Brisbane" });
test.setTimeout(90_000);

for (const appearance of ["classic", "studio"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${appearance} ${theme} identifies used credits and the server reset`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await prepareGuestPage(page, "ko", appearance, appearance);
      await setDeterministicTheme(page, theme);
      await page.route("**/api/user/guest-usage", (route) => route.fulfill({ json: {
        used: 7, limit: 80, remaining: 73, creditsAvailable: 73,
        aiReviewTrial: null, resetsAt: "2099-01-01T00:00:00.000Z",
      } }));
      await page.goto("/chat?lang=ko&entry=guest-preview");
      const badge = page.getByTestId("mobile-guest-usage-badge");
      await expect(badge).toHaveText("게스트 크레딧 7/80 사용", { timeout: 60_000 });
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await expectNoHorizontalOverflow(page);
      await badge.click();
      const sheet = page.getByRole("dialog", { name: "게스트 모드 활성화" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("게스트 크레딧 7/80 사용", { exact: true })).toBeVisible();
      await expect(sheet.getByText("일일 게스트 크레딧 한도는 선택한 모델 전체에서 공유됩니다.", { exact: true })).toBeVisible();
      await expect(sheet.getByTestId("guest-usage-reset")).toContainText("10:00");
      await expect(sheet.getByTestId("guest-usage-reset")).toContainText("초기화 (Australia/Brisbane)");
      await expect(sheet).not.toContainText("50 크레딧");
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(badge).toBeFocused();
    });
  }
}

for (const resetsAt of [null, "invalid-date"]) {
  test(`does not invent a reset for ${resetsAt}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await prepareGuestPage(page, "en");
    await page.route("**/api/user/guest-usage", (route) => route.fulfill({ json: { used: 1, limit: 80, resetsAt } }));
    await page.goto("/chat?lang=en&entry=guest-preview");
    const badge = page.getByTestId("mobile-guest-usage-badge");
    await expect(badge).toHaveText("Guest credits 1/80 used", { timeout: 60_000 });
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await badge.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("guest-usage-reset")).toHaveCount(0);
  });
}
