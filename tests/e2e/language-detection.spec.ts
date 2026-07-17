import { expect, test } from "@playwright/test";

test.use({ locale: "ko-KR" });

test("a fresh private-style session uses the browser language before opening chat", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  await page.goto("/");

  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tomverse_language")))
    .toBe("ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");

  const startChat = page
    .getByRole("link", { name: "무료로 채팅 시작하기" })
    .first();
  await expect(startChat).toHaveAttribute(
    "href",
    "/chat?lang=ko&entry=guest-preview"
  );

  await startChat.click();
  await expect(page).toHaveURL(/\/chat\?lang=ko&entry=guest-preview$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
});

test("an explicit locale route still overrides the browser preference", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  await page.goto("/en");

  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tomverse_language")))
    .toBe("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
