import { expect, test } from "@playwright/test";

test("home renders the marketing site", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /Compare the best AI answers/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open app/i }).first()).toHaveAttribute("href", "/chat");

  await page.getByLabel("Language").selectOption("ko");
  await expect(page.getByRole("heading", { name: /최고의 AI 답변/ })).toBeVisible();
});

test("pricing page supports Chinese copy", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByLabel("Language").selectOption("zh");
  await expect(page.getByRole("heading", { name: /适合每种 AI 工作流/ })).toBeVisible();
});
