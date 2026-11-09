import { expect, test } from "@playwright/test";

test("Korean support directs screenshot attachments to email", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await page.goto("/support?lang=ko");
  await expect(page.getByText("스크린샷이 필요한 문의는 지원 이메일로 보내주세요", { exact: true })).toBeVisible();
  await expect(page.getByText(/이 양식에는 파일을 첨부할 수 없습니다/)).toBeVisible();
  const email = page.getByTestId("support-screenshot-email");
  await expect(email).toHaveAttribute("href", "mailto:support@tomverse.app");
  await expect(email).toHaveText("support@tomverse.app");
  await email.focus();
  await expect(email).toBeFocused();
  await expect(page.locator('form input[type="file"]')).toHaveCount(0);
  await expect(page.locator("form").getByRole("button", { name: "문의 보내기", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
