import { expect, test } from "@playwright/test";
import {
  mockPublicBillingConfig,
  mockPublicProofMetrics,
} from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await mockPublicBillingConfig(page);
  await mockPublicProofMetrics(page);
});

test("home renders the marketing site", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      name: "Ask once. Compare answers. Review what they missed.",
    })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Open app/i }).first()).toHaveAttribute(
    "href",
    "/chat?lang=en"
  );

  await page.getByLabel("Language").selectOption("ko");
  await expect(
    page.getByRole("heading", {
      name: "한 번 질문하고 여러 AI의 답변을 비교하세요.",
    })
  ).toBeVisible();
});

test("pricing page supports Chinese copy", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByLabel("Language").selectOption("zh");
  await expect(
    page.getByRole("heading", { name: "选择适合你的 AI 能力等级。" })
  ).toBeVisible();
  await expect(page.getByTestId("pricing-credit-packs")).toBeVisible();
  await expect(page.locator('[data-pack-id="starter_500"]')).toContainText("500");
  await expect(page.locator('[data-pack-id="project_1500"]')).toContainText("1,500");
});
