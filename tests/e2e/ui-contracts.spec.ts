import { expect, test } from "@playwright/test";

test("desktop exposes stable QA contracts", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");

  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-message-list")).toBeVisible();
});

test("mobile exposes stable QA contracts", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto("/");

  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
});
